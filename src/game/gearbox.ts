import { clamp } from "./handling";

/**
 * Arcade 6-speed gearbox. Pure and deterministic: stepGearbox() mutates a small
 * state object and allocates nothing, so it runs inside the fixed 60 Hz physics
 * step and syncs cheaply in multiplayer (4 numbers).
 *
 *  - Gears 1-5 shift automatically (power cut on upshifts, hysteresis on downshifts).
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
/** Per-gear leverage on the engine force: short gears pull harder. */
const GEAR_FORCE = [1.35, 1.2, 1.08, 1.0, 0.95, 0.9];

export const UPSHIFT_AT = 0.92;   // upshift at this fraction of the gear's top speed
export const DOWNSHIFT_AT = 0.8;  // downshift below this fraction of the LOWER gear's top speed
export const SHIFT_CUT = 0.16;    // s of power cut on an upshift (the shift "kick")
export const UNLOCK_READY = 0.95; // fraction of FIFTH_TOP from which T can engage 6th
export const SIXTH_RELOCK = 0.85; // in 6th, below this fraction of FIFTH_TOP → back to 5th (locked)
export const BOOST_TIME = 1.5;    // s of the 6th-gear power kick (fades out)
export const BOOST_FORCE = 1.8;   // engine-force multiplier at the start of the kick
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7500;
const TORQUE_PEAK = 0.7;          // rpm fraction of peak torque

export interface GearboxState {
  gear: number;       // 1..6
  rpm: number;        // IDLE_RPM..REDLINE_RPM
  shiftTimer: number; // s left of the shift power cut
  boostTimer: number; // s left of the 6th-gear kick
}

export function createGearbox(): GearboxState {
  return { gear: 1, rpm: IDLE_RPM, shiftTimer: 0, boostTimer: 0 };
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

/** Advance the gearbox one fixed step. Mutates and returns s. */
export function stepGearbox(
  s: GearboxState,
  speed: number,
  carTop: number,
  unlockHeld: boolean,
  dt: number
): GearboxState {
  s.shiftTimer = Math.max(0, s.shiftTimer - dt);
  s.boostTimer = Math.max(0, s.boostTimer - dt);
  const v = Math.max(0, speed);

  if (s.gear === GEAR_COUNT) {
    if (v < FIFTH_TOP * SIXTH_RELOCK) {
      s.gear = GEAR_COUNT - 1; // fell off the pace: 6th locks again
      s.boostTimer = 0;
    }
  } else if (unlockHeld && sixthReady(s, v)) {
    s.gear = GEAR_COUNT;     // BOOM: 6th unlocked
    s.shiftTimer = SHIFT_CUT * 0.5;
    s.boostTimer = BOOST_TIME;
  } else if (s.gear < GEAR_COUNT - 1 && v >= gearTopSpeed(s.gear, carTop) * UPSHIFT_AT) {
    s.gear++;
    s.shiftTimer = SHIFT_CUT;
  } else if (s.gear > 1 && v < gearTopSpeed(s.gear - 1, carTop) * DOWNSHIFT_AT) {
    s.gear--;
  }

  s.rpm = IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * clamp(v / gearTopSpeed(s.gear, carTop), 0, 1);
  return s;
}

/** Engine-force multiplier: torque curve × gear leverage, 0 during a shift cut, kicked after unlocking 6th. */
export function driveMultiplier(s: GearboxState): number {
  if (s.shiftTimer > 0) return 0;
  const kick = s.boostTimer > 0 ? 1 + (BOOST_FORCE - 1) * (s.boostTimer / BOOST_TIME) : 1;
  return torqueCurve(rpmFraction(s.rpm)) * GEAR_FORCE[s.gear - 1] * kick;
}

/** Speed (m/s) the engine may pull to: the 5th-gear limiter until 6th is unlocked. */
export function speedCap(s: GearboxState, topEndCap: number): number {
  return s.gear === GEAR_COUNT ? topEndCap : FIFTH_TOP;
}
