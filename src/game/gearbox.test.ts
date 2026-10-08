import { describe, it, expect } from "vitest";
import {
  createGearbox, stepGearbox, driveMultiplier, speedCap, sixthReady, torqueCurve, rpmFraction,
  isShifting, isLaunching,
  FIFTH_TOP, UNLOCK_READY, SIXTH_RELOCK, SHIFT_CUT, SHIFT_RAMP, MIN_GEAR_TIME, BOOST_TIME,
  IDLE_RPM, STOP_RPM, STOP_RPM_MAX, REDLINE_RPM, LAUNCH_REV_TIME, LAUNCH_RPM,
  SHIFT_LAND_RPM, SHIFT_LAND_VARY,
  idleWanderRpm,
} from "./gearbox";

const dt = 1 / 60;
const TOP = 48; // a car's 6th-gear top speed (m/s)

/** Drive a fresh gearbox up to 5th on the limiter. */
function onLimiter() {
  const s = createGearbox();
  for (let v = 0; v <= FIFTH_TOP; v += 0.1) stepGearbox(s, v, TOP, false, dt);
  stepGearbox(s, FIFTH_TOP, TOP, false, dt);
  return s;
}

/** A box in 1st, revving out just below the upshift point after the minimum gear time.
 *  1st gear top = 0.18 * 37.5 = 6.75 m/s; upshift at 0.92 * 6.75 ≈ 6.21 m/s. */
function inFirstGearReadyToShift() {
  const s = createGearbox();
  const n = Math.ceil((MIN_GEAR_TIME + 0.1) / dt);
  for (let i = 1; i <= n; i++) stepGearbox(s, 6.1 * (i / n), TOP, false, dt);
  return s;
}

describe("gearbox", () => {
  it("caps 5th at 130-140 km/h for every car", () => {
    expect(FIFTH_TOP * 3.6).toBeGreaterThanOrEqual(130);
    expect(FIFTH_TOP * 3.6).toBeLessThanOrEqual(140);
  });

  it("starts in 1st at the high rally idle", () => {
    const s = createGearbox();
    expect(s.gear).toBe(1);
    expect(s.rpm).toBe(STOP_RPM);
  });

  it("never drops below 1800 rpm and stays within idle wander range when stopped", () => {
    expect(STOP_RPM).toBe(1800);
    expect(STOP_RPM_MAX).toBe(2000);
    const s = createGearbox();
    for (let i = 0; i < 300; i++) stepGearbox(s, 0, TOP, false, dt, 0); // standing still, no throttle
    expect(s.rpm).toBeGreaterThanOrEqual(STOP_RPM);
    expect(s.rpm).toBeLessThanOrEqual(STOP_RPM_MAX);
    // coast down from speed to a standstill: the revs hang, but never fall under the floor
    const r = createGearbox();
    for (let v = 30; v >= 0; v -= 0.05) {
      stepGearbox(r, v, TOP, false, dt, 0);
      expect(r.rpm).toBeGreaterThanOrEqual(STOP_RPM);
    }
  });

  it("idleWanderRpm always returns values in the STOP_RPM..STOP_RPM_MAX range", () => {
    for (let t = 0; t < 60; t += 0.01) {
      const rpm = idleWanderRpm(t);
      expect(rpm).toBeGreaterThanOrEqual(STOP_RPM);
      expect(rpm).toBeLessThanOrEqual(STOP_RPM_MAX);
    }
    // Check it actually varies (not stuck at one value)
    const values = new Set<number>();
    for (let t = 0; t < 10; t += 0.1) values.add(Math.round(idleWanderRpm(t)));
    expect(values.size).toBeGreaterThan(3);
  });

  it("shifts 1 to 5 automatically but never into 6th without T", () => {
    const s = createGearbox();
    const seen = new Set<number>();
    for (let v = 0; v <= 60; v += 0.1) seen.add(stepGearbox(s, v, TOP, false, dt).gear);
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(speedCap(s, TOP)).toBe(FIFTH_TOP);
    expect(s.rpm).toBe(REDLINE_RPM); // bouncing on the limiter
  });

  it("ignores T below the limiter", () => {
    const s = onLimiter();
    stepGearbox(s, FIFTH_TOP * (UNLOCK_READY - 0.05), TOP, true, dt);
    expect(s.gear).toBe(5);
    expect(sixthReady(s, FIFTH_TOP * (UNLOCK_READY - 0.05))).toBe(false);
  });

  it("T on the limiter engages 6th with a kick and opens the full top speed", () => {
    const s = onLimiter();
    expect(sixthReady(s, FIFTH_TOP)).toBe(true);
    const noKick = driveMultiplier(s);
    stepGearbox(s, FIFTH_TOP, TOP, true, dt);
    expect(s.gear).toBe(6);
    expect(s.boostTimer).toBeCloseTo(BOOST_TIME, 6);
    expect(speedCap(s, TOP)).toBe(TOP);
    expect(driveMultiplier(s)).toBe(0); // short shift first
    for (let i = 0; i < 10; i++) stepGearbox(s, FIFTH_TOP, TOP, false, dt);
    expect(driveMultiplier(s)).toBeGreaterThan(noKick); // then BOOM
  });

  it("6th is a medium push: long-lasting but not too fast", () => {
    const s = onLimiter();
    const noKick = driveMultiplier(s);
    stepGearbox(s, FIFTH_TOP, TOP, true, dt);
    let peak = 0;
    for (let t = 0; t < BOOST_TIME; t += dt) {
      stepGearbox(s, FIFTH_TOP, TOP, false, dt);
      peak = Math.max(peak, driveMultiplier(s));
    }
    expect(BOOST_TIME).toBeGreaterThanOrEqual(3);   // lives on for a good while
    expect(peak).toBeGreaterThan(noKick);           // still a push over 5th
    expect(peak).toBeLessThan(1.0);                 // but medium, not the old ~1.6 slam
  });

  it("the kick fades out", () => {
    const s = onLimiter();
    stepGearbox(s, FIFTH_TOP, TOP, true, dt);
    for (let t = 0; t < BOOST_TIME + 0.1; t += dt) stepGearbox(s, FIFTH_TOP, TOP, false, dt);
    expect(s.boostTimer).toBe(0);
  });

  it("re-locks 6th when the car drops off the pace", () => {
    const s = onLimiter();
    stepGearbox(s, FIFTH_TOP, TOP, true, dt);
    stepGearbox(s, FIFTH_TOP * SIXTH_RELOCK - 0.1, TOP, false, dt);
    expect(s.gear).toBe(5);
    expect(speedCap(s, TOP)).toBe(FIFTH_TOP);
  });

  it("cuts power on an upshift, then brings it back gradually", () => {
    const s = inFirstGearReadyToShift();
    stepGearbox(s, 6.3, TOP, false, dt); // past 1st's upshift point
    expect(s.gear).toBe(2);
    expect(isShifting(s)).toBe(true);
    expect(driveMultiplier(s)).toBe(0);
    for (let t = 0; t < SHIFT_CUT - dt; t += dt) stepGearbox(s, 6.3, TOP, false, dt);
    expect(driveMultiplier(s)).toBe(0); // still fully cut (clutch in)
    for (let t = 0; t < SHIFT_RAMP / 2; t += dt) stepGearbox(s, 6.3, TOP, false, dt);
    const half = driveMultiplier(s);
    expect(half).toBeGreaterThan(0);    // clutch biting
    for (let t = 0; t < SHIFT_RAMP; t += dt) stepGearbox(s, 6.3, TOP, false, dt);
    expect(driveMultiplier(s)).toBeGreaterThan(half); // full power back
    expect(isShifting(s)).toBe(false);
  });

  it("the revs fall during a shift instead of snapping to the new gear", () => {
    const s = inFirstGearReadyToShift();
    const before = stepGearbox(s, 6.3, TOP, false, dt).rpm;
    stepGearbox(s, 6.3, TOP, false, dt);
    const r1 = s.rpm;
    for (let i = 0; i < 6; i++) stepGearbox(s, 6.3, TOP, false, dt);
    const r2 = s.rpm;
    expect(r1).toBeGreaterThan(r2);                 // still dropping
    expect(before - r1).toBeLessThan(500);          // no instant jump
    for (let i = 0; i < 90; i++) stepGearbox(s, 6.3, TOP, false, dt);
    expect(s.rpm).toBeLessThan(r2);                 // settled at the lower new-gear revs
  });

  it("holds each gear for a minimum time and never double-shifts", () => {
    const s = inFirstGearReadyToShift();
    stepGearbox(s, 6.3, TOP, false, dt);
    expect(s.gear).toBe(2);
    // Even at a speed way past 2nd's upshift point, 2nd is held for MIN_GEAR_TIME.
    let t = 0;
    while (t < MIN_GEAR_TIME - 2 * dt) { stepGearbox(s, 30, TOP, false, dt); t += dt; }
    expect(s.gear).toBe(2);
    for (let i = 0; i < 120; i++) stepGearbox(s, 30, TOP, false, dt);
    expect(s.gear).toBeGreaterThan(2);
  });

  it("paces 0-135 km/h: every gear lasts, and the whole run takes several seconds", () => {
    // A simplified copy of the Car.ts drive model (engine accel 17, launch boost 0.8
    // over 14 m/s, drag 0.1): a regression guard for "races from 1st to 5th too fast".
    const s = createGearbox();
    let v = 0, t = 0, gearStart = 0, last = 1;
    const dwell: number[] = [];
    let t100 = 0;
    while (t < 30 && v < FIFTH_TOP * 0.99) {
      stepGearbox(s, v, TOP, false, dt, 1);
      const boost = 1 + 0.8 * Math.max(0, 1 - v / 14);
      v += (17 * boost * driveMultiplier(s) - 0.1 * v) * dt;
      t += dt;
      if (!t100 && v * 3.6 >= 100) t100 = t;
      if (s.gear !== last) { dwell.push(t - gearStart); gearStart = t; last = s.gear; }
    }
    expect(dwell.length).toBe(4);
    for (const d of dwell) expect(d).toBeGreaterThan(0.5); // each gear held for at least 0.5s
    expect(t100).toBeGreaterThan(2);     // 0-100 takes at least 2s
    expect(t100).toBeLessThan(8);        // but not more than 8s
    expect(t).toBeGreaterThan(3);        // whole run takes at least 3s
    expect(t).toBeLessThan(15);          // but finishes within 15s
  });

  it("launch: revs build on the line with little drive, then the clutch drops with a kick", () => {
    const s = createGearbox();
    stepGearbox(s, 0, TOP, false, dt, 1);
    expect(isLaunching(s)).toBe(true);
    for (let t = 0; t < LAUNCH_REV_TIME * 0.8; t += dt) stepGearbox(s, 0, TOP, false, dt, 1);
    expect(s.rpm).toBeGreaterThan(IDLE_RPM + (LAUNCH_RPM - IDLE_RPM) * 0.5);
    expect(driveMultiplier(s)).toBeLessThan(0.2);       // clutch slipping
    for (let t = 0; t < LAUNCH_REV_TIME * 0.4; t += dt) stepGearbox(s, 0, TOP, false, dt, 1);
    expect(isLaunching(s)).toBe(false);
    expect(s.kickTimer).toBeGreaterThan(0);
    const kicked = driveMultiplier(s);
    expect(kicked).toBeGreaterThan(0.5);
    // the wheelspin revs hang above the road-speed revs, then settle
    for (let t = 0; t < 1.2; t += dt) stepGearbox(s, 2, TOP, false, dt, 1);
    expect(s.kickTimer).toBe(0);
    expect(driveMultiplier(s)).toBeLessThan(kicked);
  });

  it("launch re-arms after the throttle is released and ignores a rolling start", () => {
    const s = createGearbox();
    for (let t = 0; t < 0.6; t += dt) stepGearbox(s, 0, TOP, false, dt, 1);
    expect(s.launch).toBe(1);
    stepGearbox(s, 0, TOP, false, dt, 0);
    expect(s.launch).toBe(0);
    const r = createGearbox();
    stepGearbox(r, 5, TOP, false, dt, 1); // already rolling: no launch
    expect(isLaunching(r)).toBe(false);
    expect(r.kickTimer).toBe(0);
  });

  it("does not hunt between gears at a steady speed (hysteresis)", () => {
    const s = inFirstGearReadyToShift();
    stepGearbox(s, 6.3, TOP, false, dt);
    for (let i = 0; i < 120; i++) {
      stepGearbox(s, 5.5, TOP, false, dt);
      expect(s.gear).toBe(2);
    }
  });

  it("has a torque curve: strong mid-range, top-end fade", () => {
    expect(torqueCurve(0)).toBeCloseTo(0.85, 6);     // strong at idle
    expect(torqueCurve(0.55)).toBeCloseTo(1, 6);     // peak at 55% (~4530 rpm)
    expect(torqueCurve(1)).toBeCloseTo(0.60, 6);     // struggles at redline
    expect(rpmFraction(IDLE_RPM)).toBe(0);
    expect(rpmFraction(REDLINE_RPM)).toBe(1);
  });

  it("upshift lands RPM near SHIFT_LAND_RPM with variation", () => {
    const s = inFirstGearReadyToShift();
    stepGearbox(s, 6.3, TOP, false, dt); // trigger upshift to 2nd
    expect(s.gear).toBe(2);
    expect(isShifting(s)).toBe(true);
    // Run through the full shift cut so RPM settles toward the landing zone
    for (let t = 0; t < SHIFT_CUT; t += dt) stepGearbox(s, 6.3, TOP, false, dt);
    // RPM should be in or near the landing zone (SHIFT_LAND_RPM ± SHIFT_LAND_VARY + transition margin)
    expect(s.rpm).toBeGreaterThanOrEqual(SHIFT_LAND_RPM - SHIFT_LAND_VARY - 500);
    expect(s.rpm).toBeLessThanOrEqual(SHIFT_LAND_RPM + SHIFT_LAND_VARY + 500);
  });
});