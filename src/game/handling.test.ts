import { describe, it, expect } from "vitest";
import { clamp, nextImpact, creepTopEndCap, speedFraction, avoidanceControl, shouldHoldHandbrake } from "./handling";

describe("shouldHoldHandbrake", () => {
  it.each([0, 0.0005, 0.1, 0.15])("holds residual horizontal speed %s", (speed) => {
    expect(shouldHoldHandbrake(true, 0, 4, speed, 0.01)).toBe(true);
  });

  it.each([-0.15, 0, 0.15])("holds small yaw rates in either direction: %s", (yaw) => {
    expect(shouldHoldHandbrake(true, 0, 2, 0, yaw)).toBe(true);
  });

  it("releases immediately with Space released or throttle applied", () => {
    expect(shouldHoldHandbrake(false, 0, 4, 0, 0)).toBe(false);
    expect(shouldHoldHandbrake(true, 0.01, 4, 0, 0)).toBe(false);
    expect(shouldHoldHandbrake(true, 1, 4, 0, 0)).toBe(false);
  });

  it.each([0, 1])("does not hold with only %s wheel contacts", (contacts) => {
    expect(shouldHoldHandbrake(true, 0, contacts, 0, 0)).toBe(false);
  });

  it("preserves moving slides and spins", () => {
    expect(shouldHoldHandbrake(true, 0, 4, 0.151, 0)).toBe(false);
    expect(shouldHoldHandbrake(true, 0, 4, Math.hypot(3, 4), 0)).toBe(false);
    expect(shouldHoldHandbrake(true, 0, 4, 0, 0.151)).toBe(false);
    expect(shouldHoldHandbrake(true, 0, 4, 0, -0.151)).toBe(false);
  });
});

describe("clamp", () => {
  it("bounds values", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
  });
});

describe("nextImpact", () => {
  it("ignores gentle velocity changes (below the 2.5 m/s threshold)", () => {
    expect(nextImpact(0, 2, 1 / 60)).toBe(0);
  });

  it("scales with how hard the hit was and saturates at 1", () => {
    expect(nextImpact(0, 8.5, 1 / 60)).toBeCloseTo(0.5, 5); // (8.5-2.5)/12
    expect(nextImpact(0, 30, 1 / 60)).toBe(1);
  });

  it("decays the previous value toward zero over time", () => {
    const a = nextImpact(1, 0, 1 / 60);
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThan(0);
    expect(nextImpact(a, 0, 1)).toBeLessThan(a); // a full second decays much more
  });

  it("keeps the stronger of decayed-previous vs new spike", () => {
    expect(nextImpact(0.9, 8.5, 1 / 60)).toBeGreaterThan(0.5); // previous still louder
  });
});

describe("creepTopEndCap", () => {
  const topSpeed = 26;
  const vMax = topSpeed * 1.2;

  it("does not rise off throttle", () => {
    expect(creepTopEndCap(26, false, 26, topSpeed, vMax, 0.8, 1 / 60)).toBe(26);
  });

  it("does not rise until pinned near the limit", () => {
    expect(creepTopEndCap(26, true, 10, topSpeed, vMax, 0.8, 1 / 60)).toBe(26);
  });

  it("creeps up when pinned at the limit under throttle", () => {
    const next = creepTopEndCap(26, true, 26, topSpeed, vMax, 0.8, 1 / 60);
    expect(next).toBeGreaterThan(26);
    expect(next).toBeCloseTo(26 + 0.8 / 60, 6);
  });

  it("never exceeds vMax", () => {
    expect(creepTopEndCap(vMax - 0.001, true, vMax, topSpeed, vMax, 5, 1 / 60)).toBe(vMax);
    expect(creepTopEndCap(vMax, true, vMax, topSpeed, vMax, 5, 1 / 60)).toBe(vMax);
  });
});

describe("speedFraction", () => {
  it("is 0 at rest and 1 at the true max (topSpeed × (1+overspeed))", () => {
    expect(speedFraction(0, 26, 0.2)).toBe(0);
    expect(speedFraction(26 * 1.2, 26, 0.2)).toBe(1);
    expect(speedFraction(100, 26, 0.2)).toBe(1); // clamps
  });

  it("uses absolute speed (reverse counts)", () => {
    expect(speedFraction(-15.6, 26, 0.2)).toBeCloseTo(0.5, 5);
  });
});

describe("avoidanceControl", () => {
  const look = 12;

  it("cruises straight on the wander when the path is clear", () => {
    const r = avoidanceControl(look, look, look, look, 0.2);
    expect(r).toEqual({ steer: 0.2, throttle: 0.8 });
  });

  it("steers toward the more open side when blocked ahead", () => {
    const r = avoidanceControl(4, 2, look, look, 0); // left tight, right open
    expect(r.steer).toBeGreaterThan(0); // turn right (the open side)
  });

  it("eases off the throttle and crawls when very close", () => {
    const r = avoidanceControl(2, 2, 2, look, 0);
    expect(r.throttle).toBe(0.15);
  });

  it("commits a side head-on (near-equal clearances)", () => {
    const left = avoidanceControl(4, 4.2, 4.0, look, -1); // wander<0 → left
    const right = avoidanceControl(4, 4.0, 4.2, look, 1); // wander>0 → right
    expect(left.steer).toBeLessThan(0);
    expect(right.steer).toBeGreaterThan(0);
  });
});
