/**
 * Engine sound for the game, built from Engine Simulator recordings.
 *
 *  - Every recorded loop plays all the time, silently. The engine RPM picks the
 *    two loops that bracket it and crossfades them (equal power); each loop is
 *    pitch-shifted (playbackRate) so the pitch follows the RPM continuously.
 *  - Throttle crossfades between the "on" and "off" loops. The gearbox's shift
 *    cut lifts the throttle and ducks the level a little.
 *  - NEW: when the caller passes `rpm` (the gearbox's real rpm, 900..7500) the
 *    sound follows it directly: no launch flare, almost no extra smoothing, so the
 *    shift drop and the launch build-up are exactly what the gearbox does.
 *    Without `rpm` the old rpmFrac behaviour is used.
 *  - A compressor on the master bus stops the summed loops from clipping.
 *
 * With no samples in public/assets/audio/engine/ it falls back to a crude
 * placeholder synth so the wiring can be tested.
 */

export interface EngineLoopPoint {
  rpm: number;
  on: string;
  off: string;
}

export interface EngineManifest {
  points: EngineLoopPoint[];
  limiter?: string;
  oneShots?: Record<string, string>;
}

export interface EngineAudioInput {
  /** 0..1 position between idle and redline (rpmFraction(gearbox.rpm)). */
  rpmFrac: number;
  /** 0..1 throttle. */
  throttle: number;
  /** True during the power cut of a gear shift. */
  shifting: boolean;
  /** True while pinned on the rev limiter under throttle. */
  limiter: boolean;
  /** Real gearbox rpm. When given, the sound follows it directly. */
  rpm?: number;
}

// ---- tuning knobs ----------------------------------------------------------
/** Legacy path only (no `rpm` input): audible RPM rise / fall speeds (1/s). */
export const REV_RISE = 6;
export const REV_FALL = 2.5;
/** Legacy path only: launch flare. Not used when `rpm` is passed. */
export const LAUNCH_FLARE = 0.25;
export const LAUNCH_ZONE = 0.4;
/** Direct path: how tightly the audible rpm follows the gearbox rpm (1/s). Only removes 60 Hz stair-steps. */
export const RPM_FOLLOW = 35;
/** Game rpm range (matches gearbox.ts IDLE_RPM / REDLINE_RPM). */
export const GAME_IDLE_RPM = 900;
export const GAME_REDLINE_RPM = 7500;
/** Level dip while the clutch is in during a shift (0 = none, 1 = silent). */
export const SHIFT_DUCK = 0.3;
/** Throttle on/off crossfade speeds (1/s). */
export const LOAD_RISE = 14;
export const LOAD_FALL = 9;
/** Synthetic limiter bounce (used only when there is no recorded limiter loop). */
export const LIMITER_HZ = 13;
export const LIMITER_CUT_DUTY = 0.35;
export const LIMITER_CUT_GAIN = 0.45;
export const LIMITER_CUT_RPM_DIP = 0.035;
/** Allowed pitch-shift range per loop (playbackRate). */
export const MIN_RATE = 0.6;
export const MAX_RATE = 1.6;
/** Master volume (loops are normalised to about -3 dBFS by the tool). */
export const MASTER_VOLUME = 0.7;

// ---- pure helpers ----------------------------------------------------------
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map the game's 0..1 RPM fraction onto the RPM range that was recorded. */
export function simRpm(frac: number, firstRpm: number, lastRpm: number): number {
  return firstRpm + clamp01(frac) * (lastRpm - firstRpm);
}

export interface Blend {
  lo: number;
  hi: number;
  wLo: number;
  wHi: number;
}

/** Equal-power crossfade between the two recorded RPM points that bracket `rpm`. */
export function blendPoints(rpm: number, rpms: readonly number[]): Blend {
  const n = rpms.length;
  if (n === 1 || rpm <= rpms[0]) return { lo: 0, hi: 0, wLo: 1, wHi: 0 };
  if (rpm >= rpms[n - 1]) return { lo: n - 1, hi: n - 1, wLo: 1, wHi: 0 };
  let hi = 1;
  while (hi < n - 1 && rpms[hi] < rpm) hi++;
  const lo = hi - 1;
  const t = (rpm - rpms[lo]) / (rpms[hi] - rpms[lo]);
  return { lo, hi, wLo: Math.cos((t * Math.PI) / 2), wHi: Math.sin((t * Math.PI) / 2) };
}

/** Exponential approach with separate rise / fall speeds (per second). */
export function chase(cur: number, target: number, dt: number, rise: number, fall: number): number {
  const k = 1 - Math.exp(-(target > cur ? rise : fall) * dt);
  return cur + (target - cur) * k;
}

/** Legacy: the RPM fraction the engine should sound like, with the launch flare. */
export function targetRevFrac(rpmFrac: number, throttle: number): number {
  const flare = throttle > 0 ? LAUNCH_FLARE * clamp01(1 - rpmFrac / LAUNCH_ZONE) : 0;
  return clamp01(rpmFrac + flare);
}

/** Equal-power split of the throttle between the "on" and "off" loops. */
export function loadGains(load: number): { on: number; off: number } {
  const a = clamp01(load);
  return { on: Math.sin((a * Math.PI) / 2), off: Math.cos((a * Math.PI) / 2) };
}

// ---- Web Audio -------------------------------------------------------------
interface Layer {
  src: AudioBufferSourceNode;
  gain: GainNode;
  point: number;
  kind: "on" | "off";
}

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers: Layer[] = [];
  private rpms: number[] = [];
  private limiterLayer: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private oneShots = new Map<string, AudioBuffer>();
  private fallback: FallbackSynth | null = null;

  private unlocked = false;
  private revFrac = 0;
  private revRpm = GAME_IDLE_RPM;
  private throttleMix = 0;
  private shiftMix = 0;
  private limiterMix = 0;
  private limPhase = 0;

  constructor() {
    const unlock = () => {
      void this.unlock();
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("keydown", unlock);
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("touchstart", unlock);

    document.addEventListener("visibilitychange", () => {
      if (!this.ctx || !this.unlocked) return;
      void (document.hidden ? this.ctx.suspend() : this.ctx.resume());
    });
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER_VOLUME;
      // Safety limiter: several loops add up, this keeps the sum from clipping.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 8;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") await ctx.resume();
    this.unlocked = ctx.state === "running";
  }

  async load(baseUrl = `${import.meta.env.BASE_URL}assets/audio/engine/`): Promise<void> {
    const ctx = this.ensureContext();
    try {
      const res = await fetch(baseUrl + "manifest.json");
      if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
      const manifest = (await res.json()) as EngineManifest;
      if (!manifest.points || manifest.points.length === 0) throw new Error("manifest has no points");
      const points = [...manifest.points].sort((a, b) => a.rpm - b.rpm);

      const decode = async (file: string): Promise<AudioBuffer> => {
        const r = await fetch(baseUrl + file);
        if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
        return ctx.decodeAudioData(await r.arrayBuffer());
      };

      const [onBufs, offBufs, limiterBuf] = await Promise.all([
        Promise.all(points.map((p) => decode(p.on))),
        Promise.all(points.map((p) => decode(p.off))),
        manifest.limiter ? decode(manifest.limiter) : Promise.resolve(null),
      ]);
      if (manifest.oneShots) {
        for (const [name, file] of Object.entries(manifest.oneShots)) {
          this.oneShots.set(name, await decode(file));
        }
      }

      this.rpms = points.map((p) => p.rpm);
      points.forEach((_, i) => {
        this.layers.push(this.startLoop(onBufs[i], i, "on"));
        this.layers.push(this.startLoop(offBufs[i], i, "off"));
      });
      if (limiterBuf) {
        const l = this.startLoop(limiterBuf, 0, "on");
        this.limiterLayer = { src: l.src, gain: l.gain };
      }
    } catch (err) {
      console.info(
        `[EngineAudio] samples not available (${(err as Error).message}); using the placeholder synth. ` +
        `Put the output of tools/make_engine_loops.py in public/assets/audio/engine/.`
      );
      this.layers = [];
      this.limiterLayer = null;
      this.fallback = new FallbackSynth(ctx, this.master!);
    }
  }

  private startLoop(buffer: AudioBuffer, point: number, kind: "on" | "off"): Layer {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.master!);
    src.start();
    return { src, gain, point, kind };
  }

  /** Call once per rendered frame. */
  update(input: EngineAudioInput, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;

    const direct = input.rpm !== undefined;
    const load = input.shifting ? 0 : clamp01(input.throttle);
    if (direct) {
      // Follow the gearbox rpm exactly (it already models the shift drop and launch).
      this.revRpm = chase(this.revRpm, input.rpm!, dt, RPM_FOLLOW, RPM_FOLLOW);
    } else {
      this.revFrac = chase(this.revFrac, targetRevFrac(input.rpmFrac, load), dt, REV_RISE, REV_FALL);
    }
    this.throttleMix = chase(this.throttleMix, load, dt, LOAD_RISE, LOAD_FALL);
    this.shiftMix = chase(this.shiftMix, input.shifting ? 1 : 0, dt, 25, 12);

    // Rev limiter: recorded loop if there is one, otherwise a chopped bounce.
    const hasLimiterLoop = this.limiterLayer !== null;
    this.limiterMix = chase(this.limiterMix, input.limiter ? 1 : 0, dt, 12, 6);
    let cut = false;
    if (input.limiter && !hasLimiterLoop) {
      this.limPhase = (this.limPhase + dt * LIMITER_HZ) % 1;
      cut = this.limPhase < LIMITER_CUT_DUTY;
    } else {
      this.limPhase = 0;
    }

    const span = GAME_REDLINE_RPM - GAME_IDLE_RPM;
    const baseFrac = direct ? clamp01((this.revRpm - GAME_IDLE_RPM) / span) : this.revFrac;
    const rpmFrac = clamp01(baseFrac - (cut ? LIMITER_CUT_RPM_DIP : 0));

    if (this.fallback) {
      this.fallback.update(rpmFrac, this.throttleMix, t);
      return;
    }
    if (this.layers.length === 0) return; // still loading

    // Direct: the game rpm IS the sound rpm (real pitch). Legacy: remap the fraction.
    const rpm = direct
      ? Math.max(1, this.revRpm - (cut ? LIMITER_CUT_RPM_DIP * span : 0))
      : simRpm(rpmFrac, this.rpms[0], this.rpms[this.rpms.length - 1]);
    const blend = blendPoints(rpm, this.rpms);
    const { on, off } = loadGains(this.throttleMix);
    const duck = hasLimiterLoop ? 1 - this.limiterMix : 1;
    const cutGain = cut ? LIMITER_CUT_GAIN : 1;
    const shiftGain = 1 - SHIFT_DUCK * this.shiftMix;

    for (const layer of this.layers) {
      let w = 0;
      if (layer.point === blend.lo) w += blend.wLo;
      if (layer.point === blend.hi && blend.hi !== blend.lo) w += blend.wHi;
      const g = w * (layer.kind === "on" ? on : off) * duck * cutGain * shiftGain;
      const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rpm / this.rpms[layer.point]));
      layer.gain.gain.setTargetAtTime(g, t, 0.015);
      layer.src.playbackRate.setTargetAtTime(rate, t, 0.03);
    }
    if (this.limiterLayer) {
      this.limiterLayer.gain.gain.setTargetAtTime(this.limiterMix, t, 0.015);
    }
  }

  playOneShot(name: string, volume = 1): void {
    const ctx = this.ctx;
    const buf = this.oneShots.get(name);
    if (!ctx || !buf || ctx.state !== "running") return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master!);
    src.start();
  }

  /** Expose the AudioContext for add-on layers (crackle pops, turbo whine). */
  getContext(): AudioContext | null { return this.ctx; }

  /** Expose the master GainNode so add-on layers share the same compressor chain. */
  getMaster(): GainNode | null { return this.master; }

  /** Retrieve a loaded one-shot buffer by name (from manifest.json). */
  getOneShotBuffer(name: string): AudioBuffer | undefined {
    return this.oneShots.get(name);
  }

  setVolume(v: number): void {
    if (this.master) this.master.gain.value = clamp01(v);
  }

  dispose(): void {
    for (const l of this.layers) l.src.stop();
    this.limiterLayer?.src.stop();
    this.fallback?.stop();
    this.layers = [];
    this.limiterLayer = null;
    this.fallback = null;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}

/** Crude stand-in so the audio wiring can be heard before the real samples exist. */
class FallbackSynth {
  private oscs: { osc: OscillatorNode; ratio: number }[] = [];
  private lp: BiquadFilterNode;
  private out: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.Q.value = 2;
    const defs: [OscillatorType, number, number][] = [
      ["sawtooth", 1, 0.5],
      ["square", 0.5, 0.25],
      ["sawtooth", 2.01, 0.18],
    ];
    for (const [type, ratio, level] of defs) {
      const osc = ctx.createOscillator();
      osc.type = type;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(this.lp);
      osc.start();
      this.oscs.push({ osc, ratio });
    }
    this.lp.connect(this.out).connect(dest);
  }

  update(rpmFrac: number, load: number, t: number): void {
    const f = (900 + rpmFrac * 6600) / 20;
    for (const { osc, ratio } of this.oscs) osc.frequency.setTargetAtTime(f * ratio, t, 0.03);
    this.lp.frequency.setTargetAtTime(500 + 2500 * load + 1500 * rpmFrac, t, 0.05);
    this.out.gain.setTargetAtTime(0.1 + 0.14 * load, t, 0.05);
  }

  stop(): void {
    for (const { osc } of this.oscs) osc.stop();
  }
}