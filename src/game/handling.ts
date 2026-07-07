/**
 * Pure handling/AI math, extracted verbatim from Car and BotController so it can be
 * unit-tested in isolation. These functions are deterministic and side-effect free —
 * NO behaviour change: the formulae are exactly those that were inline before.
 */

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
