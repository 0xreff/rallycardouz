/**
 * Wind sound that follows the car's speed.
 *
 * All the numbers (volume, curves, filters, gusts, presets) live in WindConfig.ts,
 * the main control file. This file only builds the audio graph and applies them.
 *
 * Works with NO assets: it synthesizes wind from a looping pink-noise buffer.
 * When you have a recording, call `setSample(buffer)` and it replaces the noise
 * (the filters, speed curve and gusts all keep working on top of it).
 *
 * Cost: 1 looping source, 2 filters, 3 gain nodes, 2 low-frequency oscillators.
 * Everything runs on the audio thread; per frame we only touch a few AudioParams.
 *
 * Shape of the sound
 *  - rumble : low-passed noise, rises early and fills the cabin (body of the wind)
 *  - hiss   : band-passed noise, only really appears at high speed (the "whoosh")
 *  - gusts  : two slow sine LFOs make the level breathe a little
 *  - ambient: a small always-on level so a parked car in the desert is not dead silent
 */
import { windControl, type WindControl } from "./WindConfig";

// ---- pure helpers (unit-tested) --------------------------------------------
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 0..1 wind amount for a speed in m/s: 0 at/below minSpeed, 1 at fullSpeed. */
export function windAmount(speed: number, fullSpeed: number, minSpeed: number): number {
  return clamp01((Math.abs(speed) - minSpeed) / (fullSpeed - minSpeed));
}

/** Per-band level for a wind amount (0..1). */
export function bandLevel(amount: number, curve: number, gain: number): number {
  return Math.pow(clamp01(amount), curve) * gain;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Looping pink noise (Paul Kellet filter), seam crossfaded so it loops without a click. */
export function makePinkNoise(sampleRate: number, seconds: number, seamSeconds = 0.5): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const xf = Math.floor(sampleRate * seamSeconds);
  const raw = new Float32Array(n + xf);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  // Loop = first n samples. The audio that would CONTINUE after the end (raw[n..n+xf])
  // is placed over the start and equal-power faded into the real start, so the wrap
  // point (end -> start) continues smoothly. Noise is uncorrelated, hence equal power.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i];
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    const cont = Math.cos((t * Math.PI) / 2);   // continuation fades out
    const start = Math.sin((t * Math.PI) / 2);  // real start fades in
    out[i] = raw[n + i] * cont + raw[i] * start;
  }
  return out;
}

// ---- Web Audio -------------------------------------------------------------
export class WindAudio {
  private ctx: AudioContext;
  private control: WindControl;
  private input: GainNode;      // noise or recorded sample enters here
  private rumbleLp: BiquadFilterNode;
  private hissBp: BiquadFilterNode;
  private rumbleGain: GainNode;
  private hissGain: GainNode;
  private windGain: GainNode;   // overall volume
  private gustGain: GainNode;   // 1 +- gust LFOs
  private src: AudioBufferSourceNode | null = null;
  private lfos: OscillatorNode[] = [];
  private lfoDepths: GainNode[] = [];
  private level = 0;            // last amount we pushed to the graph
  private silent = true;
  private seenVersion = -1;

  constructor(ctx: AudioContext, dest: AudioNode, control: WindControl = windControl) {
    this.ctx = ctx;
    this.control = control;
    const s = control.settings;

    this.input = ctx.createGain();

    this.rumbleLp = ctx.createBiquadFilter();
    this.rumbleLp.type = "lowpass";
    this.rumbleLp.frequency.value = s.rumbleLpMin;
    this.rumbleLp.Q.value = 0.5;

    this.hissBp = ctx.createBiquadFilter();
    this.hissBp.type = "bandpass";
    this.hissBp.frequency.value = s.hissBpMin;
    this.hissBp.Q.value = 0.6;

    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = s.volume;
    this.gustGain = ctx.createGain();
    this.gustGain.gain.value = 1;

    this.input.connect(this.rumbleLp).connect(this.rumbleGain).connect(this.windGain);
    this.input.connect(this.hissBp).connect(this.hissGain).connect(this.windGain);
    this.windGain.connect(this.gustGain).connect(dest);

    // Gusts: two slow sines modulate gustGain.gain around 1 (rates/depths set in applySlow).
    for (let k = 0; k < 2; k++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const d = ctx.createGain();
      osc.connect(d).connect(this.gustGain.gain);
      osc.start();
      this.lfos.push(osc);
      this.lfoDepths.push(d);
    }
    this.applySlow();

    // Start with synthesized noise. A recording can replace it later.
    const data = makePinkNoise(ctx.sampleRate, 8);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.getChannelData(0).set(data);
    this.setSample(buf);
  }

  /** Replace the noise with a recorded wind loop (mono, seamless, any length). */
  setSample(buffer: AudioBuffer): void {
    const old = this.src;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.input);
    src.start();
    this.src = src;
    if (old) {
      old.stop();
      old.disconnect();
    }
  }

  /** Re-apply the settings that are not driven by speed (volume, gust rates and depths). */
  private applySlow(): void {
    const s = this.control.settings;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(clamp01(s.volume), t, 0.05);
    this.lfos[0].frequency.setTargetAtTime(Math.max(0.01, s.gustHzA), t, 0.1);
    this.lfos[1].frequency.setTargetAtTime(Math.max(0.01, s.gustHzB), t, 0.1);
    this.lfoDepths[0].gain.setTargetAtTime(s.gustDepthA, t, 0.1);
    this.lfoDepths[1].gain.setTargetAtTime(s.gustDepthB, t, 0.1);
    this.seenVersion = this.control.version;
  }

  /**
   * Call once per frame.
   * @param speed    car speed magnitude in m/s
   * @param dt       frame delta (s), unused: smoothing is done by AudioParam time constants
   * @param airborne true while all wheels are off the ground
   */
  update(speed: number, _dt: number, airborne = false): void {
    const ctx = this.ctx;
    if (ctx.state !== "running") return;
    const s = this.control.settings;

    let force = false;
    if (this.seenVersion !== this.control.version) {
      this.applySlow();
      force = true; // a setting changed: push the speed-driven values again too
    }

    const base = Math.max(windAmount(speed, s.fullSpeed, s.minSpeed), clamp01(s.ambient));
    const amount = clamp01(base * (airborne ? s.airBoost : 1));

    // Fully quiet: make sure we are silent once, then do no per-frame work.
    if (amount <= 0.001) {
      if (!this.silent || force) {
        const t = ctx.currentTime;
        this.rumbleGain.gain.setTargetAtTime(0, t, s.smooth);
        this.hissGain.gain.setTargetAtTime(0, t, s.smooth);
        this.silent = true;
        this.level = 0;
      }
      return;
    }
    // Skip when nothing audible changed (saves AudioParam automation events).
    if (!force && !this.silent && Math.abs(amount - this.level) < 0.002) return;

    const t = ctx.currentTime;
    this.rumbleGain.gain.setTargetAtTime(bandLevel(amount, s.rumbleCurve, s.rumbleGain), t, s.smooth);
    this.hissGain.gain.setTargetAtTime(bandLevel(amount, s.hissCurve, s.hissGain), t, s.smooth);
    this.rumbleLp.frequency.setTargetAtTime(lerp(s.rumbleLpMin, s.rumbleLpMax, amount), t, s.smooth);
    this.hissBp.frequency.setTargetAtTime(lerp(s.hissBpMin, s.hissBpMax, amount), t, s.smooth);
    this.level = amount;
    this.silent = false;
  }

  dispose(): void {
    this.src?.stop();
    for (const o of this.lfos) o.stop();
    this.lfos = [];
    this.lfoDepths = [];
    this.src = null;
  }
}
