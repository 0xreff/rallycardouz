/**
 * Overrun crackle & turbo spool FX layer.
 *
 * This is the "tak-tak-tak / firecracker" effect when you lift off the throttle
 * at high revs.  It also models a turbo spool (whine pitch/volume) and a
 * blow-off valve "pssh" on lift-off.
 *
 * Timing/state is pure (no Web Audio here).  Audio playback is delegated to
 * an FxSink that the caller implements with one-shot BufferSourceNodes.
 *
 * Trigger rules
 * ─────────────
 *  • Throttle must be held ≥ HOLD_MIN s AND rpm ≥ RPM_GATE before a lift counts.
 *  • On lift: one loud initial "bang", then a decaying burst of pops at
 *    POP_HZ_MAX → POP_HZ_MIN over BURST_DURATION (longer from higher rpm).
 *  • Intervals are jittered ±JITTER so it sounds like firecrackers.
 *  • DOUBLE_CHANCE of a quick double-pop (second pop DOUBLE_GAP s later).
 *  • Re-applying throttle or rpm falling below RPM_GATE kills the burst.
 *
 * Upshift pops
 * ────────────
 *  • 2–4 quick pops during the power cut of an upshift under throttle.
 *    Hooks onto the gearbox's shiftSeq / shiftDir counters (compare with
 *    the last value you saw — works even when a render frame skips a step).
 *
 * Turbo spool
 * ───────────
 *  • `spool` (0..1) rises under load (throttle × rpm), falls on lift-off.
 *  • Forced up when the 6th-gear boost is active (boostFrac > 0).
 *  • On lift-off with spool ≥ BOV_THRESHOLD → blow-off valve "pssh".
 */

import { clamp } from "../game/handling";

// ---- tuning ----------------------------------------------------------------

// Overrun crackle
const HOLD_MIN = 0.25;      // s throttle must be held before a lift-off burst
const RPM_GATE = 0.35;      // min rpmFrac that arms a crackle
const POP_HZ_MAX = 18;      // pops/s at the start of the burst (high rpm)
const POP_HZ_MIN = 6;       // pops/s as the burst dies out
const BURST_MIN = 0.7;      // s minimum burst duration
const BURST_MAX = 2.3;      // s maximum burst duration (full revs)
const JITTER = 0.35;        // ± fraction of the interval
const DOUBLE_CHANCE = 0.15;  // probability of a quick double-pop
const DOUBLE_GAP = 0.045;   // s between the two pops of a double
const POP_PITCH_SPREAD = 0.08; // ± pitch random variation
const INITIAL_POP_VOLUME = 1.0; // volume of the first "bang"

// Upshift pops
const SHIFT_POP_MIN = 2;    // min pops per upshift
const SHIFT_POP_MAX = 4;    // max pops per upshift
const SHIFT_POP_INTERVAL = 0.04; // s between upshift pops

// Turbo spool
const SPOOL_RISE = 1.4;     // 1/s: how fast spool builds under load
const SPOOL_FALL = 2.8;     // 1/s: how fast spool drops on lift-off
const SPOOL_BOOST_MIN = 0.6; // spool forced to at least this when 6th-gear boost is active
const BOV_THRESHOLD = 0.45;  // spool level that triggers a blow-off on lift-off
const BOV_COOLDOWN = 0.8;    // s before another BOV can fire

// ---- sink interface --------------------------------------------------------

/** Implement this with WebAudio one-shots. */
export interface FxSink {
  /** Play a pop variant. `intensity` 0..1, `variant` 0..numVariants-1, `pitch` ~0.92..1.08. */
  pop(intensity: number, variant: number, pitch: number): void;
  /** Play the blow-off valve sound. `intensity` 0..1 (how much boost was built). */
  bov(intensity: number): void;
}

// ---- state machine ---------------------------------------------------------

export class EngineFx {
  // --- public read-only outputs ---
  /** Turbo spool level (0..1).  Drive the whine loop's gain + pitch from this. */
  spool = 0;

  // --- internal state ---
  private sink: FxSink;
  private numVariants: number;

  // Throttle hold tracking
  private holdTime = 0;        // s the throttle has been held continuously
  private wasThrottleOn = false;

  // Overrun burst
  private bursting = false;
  private burstAge = 0;        // s since the burst started
  private burstDuration = 0;   // s this burst will last
  private nextPop = 0;         // s until the next pop
  private doublePending = false;
  private doubleTimer = 0;
  private lastVariant = -1;

  // Upshift pops
  private lastShiftSeq = 0;
  private shiftPopsLeft = 0;
  private shiftPopTimer = 0;

  // Turbo / BOV
  private bovCooldown = 0;     // s remaining before another BOV can fire

  constructor(sink: FxSink, numPopVariants: number) {
    this.sink = sink;
    this.numVariants = Math.max(1, numPopVariants);
  }

  /**
   * Call once per render frame (clamp dt to ~0.05 to avoid tab-switch bursts).
   *
   * @param dt            frame delta (s), clamped by the caller
   * @param throttle      smoothed 0..1 throttle
   * @param rpmFrac       0..1 position between idle and redline
   * @param shiftSeq      gearbox.shiftSeq (event counter, +1 per gear change)
   * @param shiftDir      gearbox.shiftDir (+1 upshift, -1 downshift)
   * @param boostFrac     gearbox.boostTimer / BOOST_TIME (0..1, 6th-gear kick)
   */
  update(
    dt: number,
    throttle: number,
    rpmFrac: number,
    shiftSeq: number,
    shiftDir: number,
    boostFrac: number
  ): void {
    dt = Math.min(dt, 0.05); // safety clamp

    const throttleOn = throttle > 0.1;

    // ---- Throttle hold tracking ----
    if (throttleOn) {
      this.holdTime += dt;
    } else {
      // Detect lift-off edge
      if (this.wasThrottleOn && this.holdTime >= HOLD_MIN && rpmFrac >= RPM_GATE) {
        this.startBurst(rpmFrac);
      }
      this.holdTime = 0;
    }
    this.wasThrottleOn = throttleOn;

    // ---- Overrun burst ----
    if (this.bursting) {
      // Kill the burst if throttle comes back or revs drop too low
      if (throttleOn || rpmFrac < RPM_GATE * 0.5) {
        this.bursting = false;
      } else {
        this.burstAge += dt;
        if (this.burstAge >= this.burstDuration) {
          this.bursting = false;
        } else {
          this.tickBurst(dt);
        }
      }
    }

    // ---- Double-pop follow-up ----
    if (this.doublePending) {
      this.doubleTimer -= dt;
      if (this.doubleTimer <= 0) {
        this.doublePending = false;
        this.firePop(0.6);
      }
    }

    // ---- Upshift pops ----
    if (shiftSeq !== this.lastShiftSeq) {
      const shifts = shiftSeq - this.lastShiftSeq;
      this.lastShiftSeq = shiftSeq;
      // Only pop on upshifts while the throttle is on
      if (shiftDir > 0 && throttleOn) {
        this.shiftPopsLeft += SHIFT_POP_MIN + Math.floor(Math.random() * (SHIFT_POP_MAX - SHIFT_POP_MIN + 1));
        this.shiftPopsLeft = Math.min(this.shiftPopsLeft, SHIFT_POP_MAX * shifts);
        this.shiftPopTimer = 0; // fire the first one immediately
      }
    }
    if (this.shiftPopsLeft > 0) {
      this.shiftPopTimer -= dt;
      if (this.shiftPopTimer <= 0) {
        this.firePop(0.7 + Math.random() * 0.3);
        this.shiftPopsLeft--;
        this.shiftPopTimer = SHIFT_POP_INTERVAL * (0.8 + Math.random() * 0.4);
      }
    }

    // ---- Turbo spool ----
    const load = throttleOn ? throttle * rpmFrac : 0;
    const spoolTarget = Math.max(load, boostFrac > 0 ? SPOOL_BOOST_MIN + 0.4 * boostFrac : 0);
    const spoolRate = spoolTarget > this.spool ? SPOOL_RISE : SPOOL_FALL;
    this.spool += (spoolTarget - this.spool) * Math.min(1, spoolRate * dt);

    // ---- Blow-off valve ----
    this.bovCooldown = Math.max(0, this.bovCooldown - dt);
    if (!throttleOn && this.wasThrottleOn === false && this.spool >= BOV_THRESHOLD && this.bovCooldown <= 0) {
      // The wasThrottleOn check above already fired on the edge; use a separate
      // flag for the BOV so it only fires once per lift.
    }
    // BOV fires on the lift-off edge (handled above in the hold tracking section)
    // We check it here to keep the code flow clear:
    if (this.holdTime === 0 && !throttleOn && this.spool >= BOV_THRESHOLD && this.bovCooldown <= 0) {
      this.sink.bov(clamp(this.spool, 0, 1));
      this.bovCooldown = BOV_COOLDOWN;
    }
  }

  // ---- internals -----------------------------------------------------------

  private startBurst(rpmAtLift: number) {
    this.bursting = true;
    this.burstAge = 0;
    // Burst duration scales with how high the revs were
    this.burstDuration = BURST_MIN + (BURST_MAX - BURST_MIN) * clamp(rpmAtLift, 0, 1);
    // Fire the initial loud "bang" immediately
    this.firePop(INITIAL_POP_VOLUME);
    this.scheduleNext();
  }

  private tickBurst(dt: number) {
    this.nextPop -= dt;
    if (this.nextPop <= 0) {
      // Intensity fades over the burst
      const progress = this.burstAge / this.burstDuration;
      const intensity = clamp(1 - progress * progress, 0.15, 1);
      this.firePop(intensity);
      this.scheduleNext();

      // Chance of a double-pop
      if (Math.random() < DOUBLE_CHANCE) {
        this.doublePending = true;
        this.doubleTimer = DOUBLE_GAP;
      }
    }
  }

  private scheduleNext() {
    // Pop rate decays from POP_HZ_MAX to POP_HZ_MIN over the burst
    const progress = clamp(this.burstAge / this.burstDuration, 0, 1);
    const hz = POP_HZ_MAX + (POP_HZ_MIN - POP_HZ_MAX) * progress;
    const base = 1 / hz;
    // Jitter the interval
    this.nextPop = base * (1 + (Math.random() * 2 - 1) * JITTER);
  }

  private firePop(intensity: number) {
    // Pick a variant that isn't the same as the last one
    let v = Math.floor(Math.random() * this.numVariants);
    if (v === this.lastVariant && this.numVariants > 1) {
      v = (v + 1 + Math.floor(Math.random() * (this.numVariants - 1))) % this.numVariants;
    }
    this.lastVariant = v;

    const pitch = 1 + (Math.random() * 2 - 1) * POP_PITCH_SPREAD;
    this.sink.pop(intensity, v, pitch);
  }
}
