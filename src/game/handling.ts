/**
 * Pure handling/AI math shared by Car and BotController.
 * These functions are deterministic and side-effect free, so handling decisions
 * can be unit-tested in isolation.
 */

/**
 * Settle only residual motion under the handbrake, never a slide or burnout.
 * Require at least two wheel contacts so a single-wheel landing stays dynamic.
 * The limits are 0.15 m/s horizontally and 0.15 rad/s in yaw.
 */
export function shouldHoldHandbrake(
  handbrake: boolean,
  throttle: number,
  groundedWheels: number,
  horizontalSpeed: number,
  yawRate: number
): boolean {
  return handbrake && throttle === 0 && groundedWheels >= 2 &&
    horizontalSpeed <= 0.15 && Math.abs(yawRate) <= 0.15;
}

/** Clamp `v` into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Collision-impact level for the camera. Decays the previous value and takes the
 * max with this frame's velocity-loss mapping. `dv` is the per-frame change in
 * velocity (m/s) — i.e. how much the hit took out of the car.
 */
export function nextImpact(prev: number, dv: number, dt: number): number {
  return Math.max(prev * Math.pow(0.02, dt), clamp((dv - 2.5) / 12, 0, 1));
}

/**
 * Creep the top-speed cap upward while the car is pinned near its limit under
 * throttle. The full engine force (elsewhere) holds whatever the cap is, so this
 * slow rise is what carries the car past `topSpeed` toward `vMax` and holds it.
 */
export function creepTopEndCap(
  cap: number,
  throttleOn: boolean,
  speed: number,
  topSpeed: number,
  vMax: number,
  accel: number,
  dt: number
): number {
  if (throttleOn && speed > topSpeed - 1 && cap < vMax) {
    return Math.min(vMax, cap + accel * dt);
  }
  return cap;
}

/**
 * Fraction (0..0.9) of rear side grip lost to power oversteer: throttle mid-corner
 * spins the driven rear tyres, so the tail steps out and the throttle steers the
 * car. Zero standing still or driving straight; stronger with more rear drive
 * (`rearDriveShare` 0..1) and on loose ground (`rearGrip` < 1). Never 100%.
 */
export function powerOversteer(
  strength: number,
  throttle: number,
  steerAbs: number,
  speed: number,
  rearDriveShare: number,
  rearGrip: number
): number {
  const rolling = clamp(speed / 8, 0, 1);
  const loose = 2 - clamp(rearGrip, 0, 1);
  return clamp(strength * throttle * steerAbs * rolling * rearDriveShare * loose, 0, 0.9);
}

/**
 * One axis of the airborne landing assist: a spring-damper on an angular rate.
 * `error` is how far (rad) the car must still rotate in the rate's positive
 * direction; returns the next rate. Critically-ish damped for k=10, d=5.
 */
export function airAttitudeRate(rate: number, error: number, stiffness: number, damping: number, dt: number): number {
  return rate + (stiffness * error - damping * rate) * dt;
}

/**
 * Grounded stabilizer strength (0..1) for a tilt angle: 0 inside the free zone so
 * the suspension can pitch and roll the body, smoothly reaching 1 at 2 × free.
 */
export function tiltAssist(angle: number, free: number): number {
  if (free <= 0) return 1;
  const t = clamp((angle - free) / free, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Forward speed as a fraction (0..1) of the car's true top speed (incl. overspeed). */
export function speedFraction(speed: number, topSpeed: number, overspeed: number): number {
  return clamp(Math.abs(speed) / (topSpeed * (1 + overspeed)), 0, 1);
}

/**
 * Bot avoidance decision from three forward ray clearances (centre/left/right) and
 * the current wander steer. Returns the steer + throttle to apply this frame.
 */
export function avoidanceControl(
  dC: number,
  dL: number,
  dR: number,
  look: number,
  wander: number
): { steer: number; throttle: number } {
  if (dC < look * 0.95 || Math.min(dL, dR) < look * 0.6) {
    const urgency = 1 - Math.min(dC, look) / look;
    let avoid = dR > dL ? 1 : -1; // turn toward the more open side
    if (Math.abs(dR - dL) < 0.5) avoid = wander >= 0 ? 1 : -1; // head-on: commit a side
    const steer = clamp(avoid * (0.5 + urgency) + wander * 0.3, -1, 1);
    const throttle = dC < 3 ? 0.15 : clamp(0.8 - urgency, 0.25, 0.8);
    return { steer, throttle };
  }
  return { steer: wander, throttle: 0.8 };
}
