/**
 * Engine sound for the game, built from Engine Simulator recordings.
 *
 * How it works (the usual game-audio approach):
 *  - You record the engine at several steady RPMs, once with the throttle open
 *    ("on") and once closed ("off"), and turn each recording into a seamless
 *    loop with tools/make_engine_loops.py.
 *  - At runtime every loop plays all the time, silently. The game's RPM picks
 *    the two loops that bracket it and crossfades them (equal power); each
 *    loop is also pitch-shifted (playbackRate) so the pitch follows the RPM
 *    continuously between the recorded points.
 *  - Throttle crossfades between the "on" and "off" loops. A gear shift lifts
 *    the throttle for the shift cut. On the rev limiter an optional recorded
 *    limiter loop takes over, or (without one) the sound is chopped in a
 *    limiter-style bounce.
 *
 * With no samples in public/assets/audio/engine/ it falls back to a crude
 * placeholder synth so the wiring can be tested before you record anything.
 *
 * The maths lives in small pure functions (see EngineAudio.test.ts); the class
 * only talks to Web Audio.
 */

export interface EngineLoopPoint {
  /** RPM the clips were recorded at (Engine Simulator RPM hold). */
  rpm: number;
  /** Full-throttle loop file. */
  on: string;
  /** Closed-throttle (engine braking) loop file. */
  off: string;
}

export interface EngineManifest {
  points: EngineLoopPoint[];
  /** Optional loop recorded bouncing off the rev limiter. */
  limiter?: string;
  /** Optional one-shots, e.g. { start: "start.wav", stall: "stall.wav" }. */
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
}

// ---- tuning knobs ----------------------------------------------------------
/** How fast the audible RPM rises / falls toward the game RPM (1/s). */
export const REV_RISE = 6;
export const REV_FALL = 2.5;
/** At a standstill with throttle the engine flares up by this RPM fraction... */
export const LAUNCH_FLARE = 0.25;
/** ...fading out by this RPM fraction (the car is moving, the clutch has "bitten"). */
export const LAUNCH_ZONE = 0.4;
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

/**
 * Equal-power crossfade between the two recorded RPM points that bracket `rpm`.
 * `rpms` must be ascending. Outside the recorded range the end point plays alone.
 */
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

/** The RPM fraction the engine should sound like: game RPM plus the launch flare. */
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
  private throttleMix = 0;
  private limiterMix = 0;
  private limPhase = 0;

  constructor() {
    // Browsers only allow sound after a user gesture: resume on the first one.
    const unlock = () => {
      void this.unlock();
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("keydown", unlock);
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("touchstart", unlock);

    // No engine drone from a background tab.
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
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") await ctx.resume();
    this.unlocked = ctx.state === "running";
  }

  /**
   * Fetch + decode the loops listed in manifest.json and start them (silent
   * until update() drives their gains). Falls back to the placeholder synth if
   * the manifest or any file is missing.
   */
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

    // Audible RPM chases the game RPM (plus a launch flare under throttle).
    const load = input.shifting ? 0 : clamp01(input.throttle);
    this.revFrac = chase(this.revFrac, targetRevFrac(input.rpmFrac, load), dt, REV_RISE, REV_FALL);
    this.throttleMix = chase(this.throttleMix, load, dt, LOAD_RISE, LOAD_FALL);

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
    const rpmFrac = clamp01(this.revFrac - (cut ? LIMITER_CUT_RPM_DIP : 0));

    if (this.fallback) {
      this.fallback.update(rpmFrac, this.throttleMix, t);
      return;
    }
    if (this.layers.length === 0) return; // still loading

    const first = this.rpms[0];
    const last = this.rpms[this.rpms.length - 1];
    const rpm = simRpm(rpmFrac, first, last);
    const blend = blendPoints(rpm, this.rpms);
    const { on, off } = loadGains(this.throttleMix);
    const duck = hasLimiterLoop ? 1 - this.limiterMix : 1;
    const cutGain = cut ? LIMITER_CUT_GAIN : 1;

    for (const layer of this.layers) {
      let w = 0;
      if (layer.point === blend.lo) w += blend.wLo;
      if (layer.point === blend.hi && blend.hi !== blend.lo) w += blend.wHi;
      const g = w * (layer.kind === "on" ? on : off) * duck * cutGain;
      const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rpm / this.rpms[layer.point]));
      layer.gain.gain.setTargetAtTime(g, t, 0.015);
      layer.src.playbackRate.setTargetAtTime(rate, t, 0.03);
    }
    if (this.limiterLayer) {
      this.limiterLayer.gain.gain.setTargetAtTime(this.limiterMix, t, 0.015);
    }
  }

  /** Play a one-shot from the manifest (e.g. "start" or "stall"). */
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

/**
 * Crude stand-in (a few oscillators and a low-pass) so the audio wiring can be
 * heard and tested before the real samples exist. NOT the final sound.
 */
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
    // Game RPM 900..7500; an inline-6 fires 3 times per revolution (rpm / 20 Hz).
    const f = (900 + rpmFrac * 6600) / 20;
    for (const { osc, ratio } of this.oscs) osc.frequency.setTargetAtTime(f * ratio, t, 0.03);
    this.lp.frequency.setTargetAtTime(500 + 2500 * load + 1500 * rpmFrac, t, 0.05);
    this.out.gain.setTargetAtTime(0.1 + 0.14 * load, t, 0.05);
  }

  stop(): void {
    for (const { osc } of this.oscs) osc.stop();
  }
}
