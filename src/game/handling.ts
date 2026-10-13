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
  const rolling = clamp(speed / 6, 0, 1);
  const loose = 2 - clamp(rearGrip, 0, 1);
  return clamp(strength * throttle * steerAbs * rolling * rearDriveShare * loose, 0, 0.9);
}

/**
 * Front-wheel lock limit (rad) for a given speed. What the driver feels is yaw-rate
 * authority, not wheel angle, so the lock is whatever gives the yaw-rate cap on a
 * bicycle model: tan(delta) = wheelbase * yawRate / speed. It never exceeds `maxSteer`,
 * so crawling and parking still get full lock, and it shrinks as speed rises while the
 * yaw-rate cap itself GROWS with speed (`yawLow` at a standstill pace up to `yawHigh`
 * at top speed): smooth, progressive turn-in at low speed, strong steering when fast.
 */
export function steerLockLimit(
  maxSteer: number,
  wheelbase: number,
  speed: number,
  yawLow: number,
  yawHigh: number,
  speedFrac: number
): number {
  const yawCap = yawLow + (yawHigh - yawLow) * clamp(speedFrac, 0, 1);
  const u = Math.max(Math.abs(speed), 1);
  return Math.min(maxSteer, Math.atan((wheelbase * yawCap) / u));
}

/**
 * Steering-wheel angle follower: exponential approach (`rate`, 1/s) that can never
 * move faster than `slew` rad/s, so turn-in builds progressively instead of stepping.
 * Unwinding toward centre is allowed 1.5x the slew so the car straightens promptly.
 */
export function steerSlew(current: number, target: number, rate: number, slew: number, dt: number): number {
  const want = (target - current) * Math.min(1, rate * dt);
  const unwinding = Math.abs(target) < Math.abs(current) ? 1.5 : 1;
  const maxStep = slew * unwinding * dt;
  return current + clamp(want, -maxStep, maxStep);
}

/**
 * Static -> kinetic ramp (0 = full grip, 1 = fully sliding) for one axle, from the
 * car's sideways slip. Two triggers, whichever trips first:
 *  - sideways SPEED (m/s): what breaks the tyres loose when fast;
 *  - slip ANGLE (rad): at low speed a couple of m/s of sideways speed is already a
 *    big angle, and a pure m/s threshold would never trip, so low-speed turns ran
 *    on rails. This lets the tail slide a little at any speed.
 * `bias` < 1 makes the axle break loose earlier (rear). The slip angle uses a floored
 * forward speed so it can't blow up near standstill.
 */
export function slideRamp(
  lateralSpeed: number,
  forwardSpeed: number,
  slipSpeed: number,
  slipAngle: number,
  bias: number
): number {
  const bySpeed = clamp((lateralSpeed - slipSpeed * bias) / slipSpeed, 0, 1);
  const angle = Math.atan2(lateralSpeed, Math.max(Math.abs(forwardSpeed), 3));
  const byAngle = clamp((angle - slipAngle * bias) / slipAngle, 0, 1);
  return Math.max(bySpeed, byAngle);
}

/**
 * Counter-steer assist (rad, in the car's steering sign: + = wheels turn left).
 * When the body slips past `dead` rad the front wheels point toward where the car is
 * actually travelling, like a driver catching a slide. `leftSlip` is the velocity
 * direction relative to the nose (+ = travelling left of it). Faded out as the
 * driver steers (`steerAbs` 0..1) so manual input always wins; off below 2 m/s.
 */
export function counterSteerAssist(
  leftSlip: number,
  forwardSpeed: number,
  gain: number,
  maxAssist: number,
  dead: number,
  steerAbs: number
): number {
  if (forwardSpeed < 2 || gain <= 0) return 0;
  const excess = Math.sign(leftSlip) * Math.max(0, Math.abs(leftSlip) - dead);
  return clamp(gain * excess, -maxAssist, maxAssist) * (1 - clamp(steerAbs, 0, 1));
}

/**
 * Rear grip "hook-up" (0..1) after the handbrake. Zero while it is held. On release the
 * rear tyres do NOT snap back: while the car is still sliding the hook-up only climbs to
 * `plateau` with the throttle off, and to 1 with the throttle on, at 1/`recoverTime` per
 * second. So a handbrake pivot keeps carrying its old course until the driver pushes on
 * the throttle to hook the rear up and drive out along the new heading. Once the slide is
 * over (slip angle below `settled`) grip is restored regardless.
 */
export function nextHookup(
  hookup: number,
  handbraking: boolean,
  throttle: number,
  slipAngleAbs: number,
  settled: number,
  recoverTime: number,
  plateau: number,
  dt: number
): number {
  if (handbraking) return 0;
  const target = slipAngleAbs < settled ? 1 : plateau + (1 - plateau) * clamp(throttle, 0, 1);
  const step = dt / Math.max(recoverTime, 1e-3);
  return hookup < target ? Math.min(target, hookup + step) : Math.max(target, hookup - step);
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
