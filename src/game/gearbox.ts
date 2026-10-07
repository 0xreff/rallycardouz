import { clamp } from "./handling";

/**
 * Arcade 6-speed gearbox. Pure and deterministic: stepGearbox() mutates a small
 * state object and allocates nothing, so it runs inside the fixed 60 Hz physics
 * step and syncs cheaply in multiplayer (4 numbers).
 *
 *  - Gears 1-5 shift automatically. An upshift takes real time: power is fully cut
 *    (clutch in), the revs fall toward the next gear, then the clutch bites and
 *    power ramps back in. A minimum dwell per gear stops it racing 1st to 5th.
 *  - A standing start is a launch: the revs climb to LAUNCH_RPM with the clutch
 *    slipping, then the clutch drops and the car gets a short kick (wheelspin).
 *  - 5th gear tops out at FIFTH_TOP (135 km/h) for every car: the rev limiter.
 *  - 6th is LOCKED. Holding T on the 5th-gear limiter engages it with a short
 *    power kick and opens the car's own full top speed. Dropping back below
 *    SIXTH_RELOCK re-locks it.
 */

export const GEAR_COUNT = 6;
/** 5th-gear top speed (m/s) shared by all cars: 37.5 m/s = 135 km/h. */
export const FIFTH_TOP = 37.5;
/** Gears 1-5 top speed as a fraction of FIFTH_TOP (~40 / 63 / 86 / 111 / 135 km/h). */
const GEAR_FRACTIONS = [0.3, 0.47, 0.64, 0.82, 1.0];
/**
 * Per-gear leverage on the engine force. Low gears are still the strongest, but far
 * less extreme than before, so the car stays in each gear long enough to hear and feel
 * the shift (0-135 km/h takes several seconds instead of ~3). 6th keeps its punch.
 */
const GEAR_FORCE = [0.5, 0.78, 0.66, 0.57, 0.5, 0.9];

export const UPSHIFT_AT = 0.92;   // upshift at this fraction of the gear's top speed
export const DOWNSHIFT_AT = 0.8;  // downshift below this fraction of the LOWER gear's top speed
export const SHIFT_CUT = 0.28;    // s of full power cut on an upshift (clutch in, lever moving)
export const SHIFT_RAMP = 0.2;    // s the power fades back in after the cut (clutch bite)
export const DOWNSHIFT_CUT = 0.14; // s of power cut on a downshift (rev-match blip)
export const MIN_GEAR_TIME = 0.6; // s a gear must be held before the next UPSHIFT
export const RPM_FALL = 11000;    // rpm/s: how fast the revs drop while the clutch is in
export const RPM_RISE = 16000;    // rpm/s: how fast they climb (blip / launch)
export const UNLOCK_READY = 0.95; // fraction of FIFTH_TOP from which T can engage 6th
export const SIXTH_RELOCK = 0.85; // in 6th, below this fraction of FIFTH_TOP → back to 5th (locked)
export const BOOST_TIME = 1.5;    // s of the 6th-gear power kick (fades out)
export const BOOST_FORCE = 1.8;   // engine-force multiplier at the start of the kick
export const LAUNCH_REV_TIME = 0.32; // s the revs build on the line before the clutch drops
export const LAUNCH_RPM = 4800;   // rpm held on the line
export const LAUNCH_SLIP = 0.08;  // drive multiplier while the clutch slips on the line
export const LAUNCH_KICK = 0.4;   // extra engine force at the clutch drop (fades out)
export const LAUNCH_KICK_TIME = 1.0; // s the kick (and the wheelspin revs) fade over
export const LAUNCH_MAX_SPEED = 1.5; // m/s: a "standing start" is below this
export const LAUNCH_THROTTLE = 0.6;  // throttle needed to arm a launch
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7500;
const TORQUE_PEAK = 0.7;          // rpm fraction of peak torque

export interface GearboxState {
  gear: number;       // 1..6
  rpm: number;        // IDLE_RPM..REDLINE_RPM
  shiftTimer: number; // s left of the shift (cut + ramp); > SHIFT_RAMP means power is fully cut
  boostTimer: number; // s left of the 6th-gear kick
  gearTime: number;   // s since the last gear change
  launch: number;     // 0..1 launch build-up on the line (1 = clutch dropped)
  kickTimer: number;  // s left of the launch kick
}

export function createGearbox(): GearboxState {
  return { gear: 1, rpm: IDLE_RPM, shiftTimer: 0, boostTimer: 0, gearTime: 0, launch: 0, kickTimer: 0 };
}

/** Top speed (m/s) of a gear (1-based). 6th uses the car's own top speed. */
export function gearTopSpeed(gear: number, carTop: number): number {
  return gear >= GEAR_COUNT ? Math.max(carTop, FIFTH_TOP) : FIFTH_TOP * GEAR_FRACTIONS[gear - 1];
}

/** Torque multiplier for an rpm fraction: 0.75 at idle, 1 at the peak, 0.85 at redline. */
export function torqueCurve(rpmFrac: number): number {
  const r = clamp(rpmFrac, 0, 1);
  return r < TORQUE_PEAK
    ? 0.75 + 0.25 * (r / TORQUE_PEAK)
    : 1 - 0.15 * ((r - TORQUE_PEAK) / (1 - TORQUE_PEAK));
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
  if (s.gear === 1 && v < LAUNCH_MAX_SPEED && throttle >= LAUNCH_THROTTLE) {
    if (s.launch < 1) {
      s.launch = Math.min(1, s.launch + dt / LAUNCH_REV_TIME);
      if (s.launch >= 1) s.kickTimer = LAUNCH_KICK_TIME; // clutch dropped: kick
    }
  } else if (s.gear !== 1 || v >= LAUNCH_MAX_SPEED || throttle < 0.2) {
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
  if (s.gear !== shiftedAt) s.gearTime = 0;

  // --- Engine revs. Locked to the wheels once the clutch is home; while it is in
  // (shift) or slipping (launch) they move at a finite rate, so you hear and see
  // the drop between gears and the build-up on the line.
  let target = IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * clamp(v / gearTopSpeed(s.gear, carTop), 0, 1);
  if (s.gear === 1 && throttle >= LAUNCH_THROTTLE && v < LAUNCH_MAX_SPEED && s.launch < 1) {
    target = Math.max(target, IDLE_RPM + (LAUNCH_RPM - IDLE_RPM) * s.launch);
  } else if (s.gear === 1 && s.kickTimer > 0) {
    // wheelspin: the revs hang above the road speed and settle as the kick fades
    const f = s.kickTimer / LAUNCH_KICK_TIME;
    target = Math.max(target, target + (LAUNCH_RPM - target) * f * f);
  }
  if (isShifting(s) || s.shiftTimer > 0 || (s.gear === 1 && s.launch > 0 && s.launch < 1)) {
    const down = RPM_FALL * dt, up = RPM_RISE * dt;
    s.rpm += clamp(target - s.rpm, -down, up);
  } else {
    s.rpm = target;
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