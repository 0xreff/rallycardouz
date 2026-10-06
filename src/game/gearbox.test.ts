import { describe, it, expect } from "vitest";
import {
  createGearbox, stepGearbox, driveMultiplier, speedCap, sixthReady, torqueCurve, rpmFraction,
  FIFTH_TOP, UNLOCK_READY, SIXTH_RELOCK, SHIFT_CUT, BOOST_TIME, IDLE_RPM, REDLINE_RPM,
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

describe("gearbox", () => {
  it("caps 5th at 130-140 km/h for every car", () => {
    expect(FIFTH_TOP * 3.6).toBeGreaterThanOrEqual(130);
    expect(FIFTH_TOP * 3.6).toBeLessThanOrEqual(140);
  });

  it("starts in 1st at idle", () => {
    const s = createGearbox();
    expect(s.gear).toBe(1);
    expect(s.rpm).toBe(IDLE_RPM);
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

  it("cuts power briefly on an upshift", () => {
    const s = createGearbox();
    stepGearbox(s, 10.4, TOP, false, dt); // past 1st's upshift point
    expect(s.gear).toBe(2);
    expect(driveMultiplier(s)).toBe(0);
    for (let t = 0; t <= SHIFT_CUT + dt; t += dt) stepGearbox(s, 10.4, TOP, false, dt);
    expect(driveMultiplier(s)).toBeGreaterThan(0);
  });

  it("does not hunt between gears at a steady speed (hysteresis)", () => {
    const s = createGearbox();
    stepGearbox(s, 10.4, TOP, false, dt);
    for (let i = 0; i < 120; i++) {
      stepGearbox(s, 10, TOP, false, dt);
      expect(s.gear).toBe(2);
    }
  });

  it("has a torque curve peaking mid-range", () => {
    expect(torqueCurve(0)).toBeCloseTo(0.75, 6);
    expect(torqueCurve(0.7)).toBeCloseTo(1, 6);
    expect(torqueCurve(1)).toBeCloseTo(0.85, 6);
    expect(rpmFraction(IDLE_RPM)).toBe(0);
    expect(rpmFraction(REDLINE_RPM)).toBe(1);
  });
});
