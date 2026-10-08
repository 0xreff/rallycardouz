import { clamp } from "./handling";

/**
 * Arcade 6-speed gearbox. Pure and deterministic: stepGearbox() mutates a small
 * state object and allocates nothing, so it runs inside the fixed 60 Hz physics
 * step and syncs cheaply in multiplayer (gear, rpm, shiftTimer, boostTimer, launch, kickTimer).
 *
 *  - Gears 1-5 shift automatically. An upshift takes real time: power is fully cut
 *    (clutch in), the revs fall toward the next gear, then the clutch bites and
 *    power ramps back in. A minimum dwell per gear stops it racing 1st to 5th.
 *  - A standing start is a launch: the revs climb to LAUNCH_RPM with the clutch
 *    slipping, then the clutch drops and the car gets a short kick (wheelspin).
 *    Once a launch has started it is LATCHED: creeping or rolling at up to
 *    LAUNCH_ABORT_SPEED does not cancel it (only letting off the throttle does).
 *  - 5th gear tops out at FIFTH_TOP (135 km/h) for every car: the rev limiter.
 *  - 6th is LOCKED. Holding T on the 5th-gear limiter engages it with a gentle,
 *    long-lasting push (BOOST_TIME) and opens the car's own full top speed. It stays
 *    engaged until the car drops well below the pace (SIXTH_RELOCK), then re-locks.
 *  - The engine never idles below STOP_RPM (a high, cinematic rally idle), even when
 *    the car is completely stopped. The stopped idle wanders softly between
 *    STOP_RPM (1800) and STOP_RPM_MAX (2000) for a natural, breathing feel.
 *
 * Feel hooks (for camera / body / particles / audio): shiftSeq, shiftDir and
 * launchSeq are event COUNTERS (compare with the last value you saw, so no event is
 * lost when a render frame runs 0 or 2 physics steps); kickEnvelope() and
 * shiftPhase() are continuous signals. Counters are local-only: no need to sync them.
 */

export const GEAR_COUNT = 6;
/** 5th-gear top speed (m/s) shared by all cars: 37.5 m/s = 135 km/h. */
export const FIFTH_TOP = 37.5;
/** Gears 1-5 top speed as a fraction of FIFTH_TOP. Wider gaps = bigger RPM drops on shift. */
const GEAR_FRACTIONS = [0.18, 0.38, 0.58, 0.78, 1.0];
/**
 * Per-gear leverage on the engine force. Punchier across the board so the car
 * accelerates hard through each gear. 6th keeps its push.
 */
const GEAR_FORCE = [0.72, 0.92, 0.80, 0.70, 0.62, 0.70];

export const UPSHIFT_AT = 0.92;   // upshift at this fraction of the gear's top speed
export const DOWNSHIFT_AT = 0.8;  // downshift below this fraction of the LOWER gear's top speed
export const SHIFT_CUT = 0.28;    // s of full power cut on an upshift (clutch in, lever moving)
export const SHIFT_RAMP = 0.2;    // s the power fades back in after the cut (clutch bite)
export const DOWNSHIFT_CUT = 0.14; // s of power cut on a downshift (rev-match blip)
export const MIN_GEAR_TIME = 0.6; // s a gear must be held before the next UPSHIFT
export const RPM_FALL = 14000;    // rpm/s: how fast the revs drop while the clutch is in (snappy shift)
export const RPM_RISE = 16000;    // rpm/s: how fast they climb (blip / launch)
/** RPM the revs target during the clutch-in phase of an upshift (~3900-4000 zone). */
export const SHIFT_LAND_RPM = 3950;
/** ± variation around SHIFT_LAND_RPM so each shift feels slightly different. */
export const SHIFT_LAND_VARY = 150;
export const UNLOCK_READY = 0.95; // fraction of FIFTH_TOP from which T can engage 6th
export const SIXTH_RELOCK = 0.7;  // in 6th, below this fraction of FIFTH_TOP → back to 5th (locked); lower = 6th lives longer
export const BOOST_TIME = 4.0;    // s of the 6th-gear push (fades out slowly)
export const BOOST_FORCE = 1.3;   // engine-force multiplier at the start of the push (was 1.8 over 1.5 s)
export const LAUNCH_REV_TIME = 0.45; // s the revs build on the line before the clutch drops (was 0.32)
export const LAUNCH_RPM = 4800;   // rpm held on the line
export const LAUNCH_SLIP = 0;     // drive multiplier while the clutch slips on the line (0 = car is held)
export const LAUNCH_KICK = 0.4;   // extra engine force at the clutch drop (fades out)
export const LAUNCH_KICK_TIME = 1.0; // s the kick (and the wheelspin revs) fade over
export const LAUNCH_MAX_SPEED = 1.5; // m/s: a launch can only be ARMED below this
export const LAUNCH_ABORT_SPEED = 4.0; // m/s: once armed, only a car faster than this cancels it
export const LAUNCH_THROTTLE = 0.6;  // throttle needed to arm a launch
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7500;
/** Minimum RPM when the car is rolling in gear (wheels turning the engine). */
export const COAST_RPM = 2000;
/** Rally idle floor: minimum RPM when the car is fully stopped. */
export const STOP_RPM = 1800;
/** Rally idle ceiling: the idle wanders up to this RPM when stopped. */
export const STOP_RPM_MAX = 2000;
/** Speed (m/s) above which the coasting RPM floor applies (~7 km/h). */
export const COAST_SPEED = 2.0;
/** RPM/s: how fast revs drop when coasting (off-throttle). Slow = rev-hang feel. */
export const RPM_COAST_FALL = 4000;
const TORQUE_PEAK = 0.55;         // rpm fraction of peak torque (~4530 rpm): strong mid-range

export interface GearboxState {
  gear: number;       // 1..6
  rpm: number;        // IDLE_RPM..REDLINE_RPM
  shiftTimer: number; // s left of the shift (cut + ramp); > SHIFT_RAMP means power is fully cut
  boostTimer: number; // s left of the 6th-gear kick
  gearTime: number;   // s since the last gear change
  launch: number;     // 0..1 launch build-up on the line (1 = clutch dropped)
  kickTimer: number;  // s left of the launch kick
  idleT: number;      // s clock for the stopped-engine idle wander
  // --- local event counters (not synced) ---
  shiftSeq: number;   // +1 on every gear change
  shiftDir: number;   // direction of the LAST gear change: +1 up, -1 down
  launchSeq: number;  // +1 at every clutch drop
}

/**
 * Smooth idle wander: overlapping sine waves that drift RPM between
 * STOP_RPM (1800) and STOP_RPM_MAX (2000). The result is a soft,
 * organic breathing feel — no two moments sound the same.
 */
export function idleWanderRpm(t: number): number {
  const range = STOP_RPM_MAX - STOP_RPM; // 200 rpm
  // Three slow sine waves at incommensurate frequencies so the pattern
  // never obviously repeats. Each is 0..1 scaled, then mixed.
  const a = 0.5 + 0.5 * Math.sin(t * 1.7);          // ~0.37 Hz
  const b = 0.5 + 0.5 * Math.sin(t * 2.9 + 1.0);    // ~0.46 Hz
  const c = 0.5 + 0.5 * Math.sin(t * 0.8 + 2.3);    // ~0.13 Hz (slow drift)
  const mix = 0.4 * a + 0.35 * b + 0.25 * c;         // weighted 0..1
  return STOP_RPM + range * mix;
}

export function createGearbox(): GearboxState {
  return {
    gear: 1, rpm: STOP_RPM, shiftTimer: 0, boostTimer: 0, gearTime: 0, launch: 0, kickTimer: 0,
    idleT: 0, shiftSeq: 0, shiftDir: 0, launchSeq: 0,
  };
}

/** Top speed (m/s) of a gear (1-based). 6th uses the car's own top speed. */
export function gearTopSpeed(gear: number, carTop: number): number {
  return gear >= GEAR_COUNT ? Math.max(carTop, FIFTH_TOP) : FIFTH_TOP * GEAR_FRACTIONS[gear - 1];
}

/**
 * Torque multiplier for an rpm fraction. Strong mid-range, top-end fade:
 *   0.85 at idle → 1.0 at peak (~4530 rpm) → 0.60 at redline.
 * The car pulls hard from ~3200 to ~5500 rpm, then struggles near redline.
 */
export function torqueCurve(rpmFrac: number): number {
  const r = clamp(rpmFrac, 0, 1);
  return r < TORQUE_PEAK
    ? 0.85 + 0.15 * (r / TORQUE_PEAK)
    : 1 - 0.40 * ((r - TORQUE_PEAK) / (1 - TORQUE_PEAK));
}

/** 0..1 position of rpm between idle and redline. */
export function rpmFraction(rpm: number): number {
  return clamp((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM), 0, 1);
}

/** True when holding T engages 6th right now: in 5th, on (or near) the limiter. */
export function sixthReady(s: GearboxState, speed: number): boolean {
  return s.gear === GEAR_COUNT - 1 && speed >= FIFTH_TOP * UNLOCK_READY;
}

/** True while the power is fully cut (clutch in) during a gear change. */
export function isShifting(s: GearboxState): boolean {
  return s.shiftTimer > SHIFT_RAMP;
}

/** True on the line while the revs build before the clutch drops. */
export function isLaunching(s: GearboxState): boolean {
  return s.gear === 1 && s.launch > 0 && s.launch < 1;
}

/** 1 at the clutch drop, fading to 0 over LAUNCH_KICK_TIME. Drive squat, FOV kick, dust, wheelspin audio. */
export function kickEnvelope(s: GearboxState): number {
  return s.gear === 1 ? clamp(s.kickTimer / LAUNCH_KICK_TIME, 0, 1) : 0;
}

/** 0 = no shift, 1 = power cut (clutch in), 2 = clutch biting (power fading back in). */
export function shiftPhase(s: GearboxState): number {
  if (s.shiftTimer <= 0) return 0;
  return s.shiftTimer > SHIFT_RAMP ? 1 : 2;
}

/** Advance the gearbox one fixed step. Mutates and returns s. */
export function stepGearbox(
  s: GearboxState,
  speed: number,
  carTop: number,
  unlockHeld: boolean,
  dt: number,
  throttle = 0
): GearboxState {
  s.shiftTimer = Math.max(0, s.shiftTimer - dt);
  s.boostTimer = Math.max(0, s.boostTimer - dt);
  s.kickTimer = Math.max(0, s.kickTimer - dt);
  s.gearTime += dt;
  const v = Math.max(0, speed);

  // --- Launch: standing start in 1st with the throttle pinned.
  // Armed only from (almost) standstill, but once the build-up has begun it is latched:
  // the car creeping/rolling (slope, tyre slip, the physics letting it drift) up to
  // LAUNCH_ABORT_SPEED no longer cancels it before the clutch drops.
  const building = s.launch > 0 && s.launch < 1;
  if (
    s.gear === 1 &&
    throttle >= LAUNCH_THROTTLE &&
    (v < LAUNCH_MAX_SPEED || (building && v < LAUNCH_ABORT_SPEED))
  ) {
    if (s.launch < 1) {
      s.launch = Math.min(1, s.launch + dt / LAUNCH_REV_TIME);
      if (s.launch >= 1) {
        s.kickTimer = LAUNCH_KICK_TIME; // clutch dropped: kick
        s.launchSeq++;
      }
    }
  } else if (
    s.gear !== 1 ||
    throttle < 0.2 ||
    v >= (building ? LAUNCH_ABORT_SPEED : LAUNCH_MAX_SPEED)
  ) {
    s.launch = 0; // rolling or off the throttle: re-arm for the next standing start
  }

  const shiftedAt = s.gear;
  if (s.gear === GEAR_COUNT) {
    if (v < FIFTH_TOP * SIXTH_RELOCK) {
      s.gear = GEAR_COUNT - 1; // fell off the pace: 6th locks again
      s.boostTimer = 0;
    }
  } else if (s.shiftTimer > 0) {
    // mid-change: the box is busy, no second shift until it has finished
  } else if (unlockHeld && sixthReady(s, v)) {
    s.gear = GEAR_COUNT;     // BOOM: 6th unlocked
    s.shiftTimer = SHIFT_CUT * 0.5 + SHIFT_RAMP * 0.5;
    s.boostTimer = BOOST_TIME;
  } else if (
    s.gear < GEAR_COUNT - 1 &&
    s.gearTime >= MIN_GEAR_TIME &&
    v >= gearTopSpeed(s.gear, carTop) * UPSHIFT_AT
  ) {
    s.gear++;
    s.shiftTimer = SHIFT_CUT + SHIFT_RAMP;
  } else if (s.gear > 1 && v < gearTopSpeed(s.gear - 1, carTop) * DOWNSHIFT_AT) {
    s.gear--;
    s.shiftTimer = DOWNSHIFT_CUT + 0.0001;
  }
  if (s.gear !== shiftedAt) {
    s.gearTime = 0;
    s.shiftSeq++;
    s.shiftDir = s.gear > shiftedAt ? 1 : -1;
  }

  // --- Engine revs. Locked to the wheels once the clutch is home; while it is in
  // (shift) or slipping (launch) they move at a finite rate, so you hear and see
  // the drop between gears and the build-up on the line.
  //
  // RPM floor: rolling (v > COAST_SPEED) the wheels turn the engine and it never drops
  // below COAST_RPM; fully stopped the idle wanders softly between STOP_RPM and
  // STOP_RPM_MAX (1800-2000 rpm) so the engine sounds alive and organic.
  s.idleT += dt;
  const floor = v > COAST_SPEED ? COAST_RPM : idleWanderRpm(s.idleT);
  let target = floor + (REDLINE_RPM - floor) * clamp(v / gearTopSpeed(s.gear, carTop), 0, 1);
  // Ensure the target is never below the floor (low speed in a tall gear).
  target = Math.max(target, floor);

  // Shift-landing: during the clutch-in phase of an upshift, the revs target a
  // specific landing zone (~3200 rpm ± variation) instead of the gear-speed RPM.
  // Each shift gets a slightly different landing via a deterministic hash of shiftSeq.
  // Once the clutch starts biting, the target returns to the real speed-based RPM
  // and the engine climbs from ~3200 up — fast through mid-range, struggling at the top.
  if (isShifting(s) && s.shiftDir > 0) {
    // Deterministic per-shift variation: ±SHIFT_LAND_VARY based on shiftSeq
    const hash = Math.sin(s.shiftSeq * 127.1 + 0.7) * 0.5 + 0.5; // 0..1
    const vary = (hash - 0.5) * 2 * SHIFT_LAND_VARY; // -VARY..+VARY
    target = Math.min(target, SHIFT_LAND_RPM + vary);
  }

  if (isLaunching(s)) {
    target = Math.max(target, IDLE_RPM + (LAUNCH_RPM - IDLE_RPM) * s.launch);
  } else if (s.gear === 1 && s.kickTimer > 0) {
    // wheelspin: the revs hang above the road speed and settle as the kick fades
    const f = s.kickTimer / LAUNCH_KICK_TIME;
    target = Math.max(target, target + (LAUNCH_RPM - target) * f * f);
  }
  // RPM always transitions gradually — never snaps.  During shifts/launches the
  // rate is RPM_FALL / RPM_RISE (the shift-drop sound).  During normal driving
  // it uses RPM_RISE going up (instant feel) and RPM_COAST_FALL going down (the
  // satisfying rev-hang when you lift off the throttle).
  if (isShifting(s) || s.shiftTimer > 0 || isLaunching(s)) {
    const down = RPM_FALL * dt, up = RPM_RISE * dt;
    s.rpm += clamp(target - s.rpm, -down, up);
  } else {
    const down = RPM_COAST_FALL * dt, up = RPM_RISE * dt;
    s.rpm += clamp(target - s.rpm, -down, up);
  }
  return s;
}

/**
 * Engine-force multiplier: torque curve × gear leverage. Zero while the clutch is in,
 * fading back in as it bites, a low "slip" value on the launch line, a kick at the
 * clutch drop, and the 6th-gear kick.
 */
export function driveMultiplier(s: GearboxState): number {
  if (s.shiftTimer > SHIFT_RAMP) return 0;
  const bite = s.shiftTimer > 0 ? 1 - s.shiftTimer / SHIFT_RAMP : 1;
  const bite3 = bite * bite * (3 - 2 * bite); // smoothstep: no jolt when power returns
  let m = torqueCurve(rpmFraction(s.rpm)) * GEAR_FORCE[s.gear - 1] * bite3;
  if (s.gear === 1) {
    if (s.launch > 0 && s.launch < 1) return m * LAUNCH_SLIP;
    if (s.kickTimer > 0) m *= 1 + LAUNCH_KICK * (s.kickTimer / LAUNCH_KICK_TIME);
  }
  const kick = s.boostTimer > 0 ? 1 + (BOOST_FORCE - 1) * (s.boostTimer / BOOST_TIME) : 1;
  return m * kick;
}

/** Speed (m/s) the engine may pull to: the 5th-gear limiter until 6th is unlocked. */
export function speedCap(s: GearboxState, topEndCap: number): number {
  return s.gear === GEAR_COUNT ? topEndCap : FIFTH_TOP;
}