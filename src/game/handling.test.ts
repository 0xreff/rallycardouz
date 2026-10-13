import { describe, it, expect } from "vitest";
import {
  clamp, nextImpact, creepTopEndCap, speedFraction, avoidanceControl, shouldHoldHandbrake,
  powerOversteer, airAttitudeRate, tiltAssist,
  steerLockLimit, steerSlew, slideRamp, counterSteerAssist, nextHookup,
} from "./handling";

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

describe("powerOversteer", () => {
  it("is zero standing still, driving straight or off throttle", () => {
    expect(powerOversteer(0.6, 1, 1, 0, 0.65, 1)).toBe(0);
    expect(powerOversteer(0.6, 1, 0, 20, 0.65, 1)).toBe(0);
    expect(powerOversteer(0.6, 0, 1, 20, 0.65, 1)).toBe(0);
  });

  it("grows with rear drive and on loose ground", () => {
    const awd = powerOversteer(0.6, 1, 1, 20, 0.5, 1);
    expect(powerOversteer(0.6, 1, 1, 20, 1, 1)).toBeGreaterThan(awd);
    expect(powerOversteer(0.6, 1, 1, 20, 0.5, 0.6)).toBeGreaterThan(awd);
  });

  it("never removes all rear grip", () => {
    expect(powerOversteer(5, 1, 1, 30, 1, 0)).toBe(0.9);
  });
});

describe("airAttitudeRate", () => {
  const dt = 1 / 60;

  it("does nothing when already on target and still", () => {
    expect(airAttitudeRate(0, 0, 10, 5, dt)).toBe(0);
  });

  it("rotates toward the target", () => {
    expect(airAttitudeRate(0, 0.5, 10, 5, dt)).toBeGreaterThan(0);
    expect(airAttitudeRate(0, -0.5, 10, 5, dt)).toBeLessThan(0);
  });

  it("damps a spin it did not cause", () => {
    const r = airAttitudeRate(3, 0, 10, 5, dt);
    expect(r).toBeLessThan(3);
    expect(r).toBeGreaterThan(0);
  });

  it("settles a tilted car without overshooting wildly", () => {
    let angle = 1; // rad off target
    let rate = 0;
    let minAngle = angle;
    for (let i = 0; i < 300; i++) {
      rate = airAttitudeRate(rate, -angle, 10, 5, dt);
      angle += rate * dt;
      minAngle = Math.min(minAngle, angle);
    }
    expect(Math.abs(angle)).toBeLessThan(0.02);
    expect(minAngle).toBeGreaterThan(-0.1);
  });
});

describe("tiltAssist", () => {
  it("is 0 inside the free zone and 1 from twice it", () => {
    expect(tiltAssist(0, 0.14)).toBe(0);
    expect(tiltAssist(0.14, 0.14)).toBe(0);
    expect(tiltAssist(0.28, 0.14)).toBe(1);
    expect(tiltAssist(1, 0.14)).toBe(1);
  });

  it("ramps smoothly in between", () => {
    const a = tiltAssist(0.21, 0.14);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it("is always on with no free zone", () => {
    expect(tiltAssist(0, 0)).toBe(1);
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

describe("steerLockLimit", () => {
  const L = 3; // wheelbase (m)

  it("gives full lock when crawling, whatever the yaw cap", () => {
    expect(steerLockLimit(0.68, L, 0, 1.2, 2.0, 0)).toBe(0.68);
    expect(steerLockLimit(0.68, L, 2, 1.2, 2.0, 0)).toBe(0.68);
  });

  it("shrinks the lock as speed rises", () => {
    const slow = steerLockLimit(0.68, L, 10, 1.2, 2.0, 0.2);
    const fast = steerLockLimit(0.68, L, 30, 1.2, 2.0, 0.6);
    expect(fast).toBeLessThan(slow);
    expect(slow).toBeLessThan(0.68);
  });

  it("gives MORE yaw-rate authority at speed than at low speed (strong steering when fast)", () => {
    const yawAt = (speed: number, frac: number) => (speed * Math.tan(steerLockLimit(0.68, L, speed, 1.2, 2.0, frac))) / L;
    expect(yawAt(30, 0.6)).toBeGreaterThan(yawAt(10, 0.2));
  });

  it("uses the same sign-free magnitude in reverse", () => {
    expect(steerLockLimit(0.68, L, -20, 1.2, 2.0, 0.4)).toBe(steerLockLimit(0.68, L, 20, 1.2, 2.0, 0.4));
  });
});

describe("steerSlew", () => {
  const dt = 1 / 60;

  it("never moves faster than the slew rate (no step response)", () => {
    const next = steerSlew(0, 0.68, 100, 3, dt);
    expect(next).toBeCloseTo(3 * dt, 6);
  });

  it("approaches the target smoothly and settles on it", () => {
    let a = 0;
    for (let i = 0; i < 120; i++) a = steerSlew(a, 0.4, 10, 3, dt);
    expect(a).toBeCloseTo(0.4, 2);
    expect(a).toBeLessThanOrEqual(0.4);
  });

  it("unwinds toward centre 1.5x faster than it winds on", () => {
    const on = steerSlew(0, 0.68, 100, 3, dt);
    const off = steerSlew(0.68, 0, 100, 3, dt);
    expect(Math.abs(off - 0.68)).toBeCloseTo(1.5 * on, 6);
  });
});

describe("slideRamp", () => {
  it("is zero while gripping", () => {
    expect(slideRamp(0, 20, 2.5, 0.11, 1)).toBe(0);
    expect(slideRamp(0.2, 20, 2.5, 0.11, 1)).toBe(0);
  });

  it("trips on slip ANGLE at low speed, where sideways speed alone never would", () => {
    // 1.5 m/s sideways at 8 m/s ahead: ~10.6 deg. Under the 2.5 m/s speed trigger.
    expect(slideRamp(1.5, 8, 2.5, 0.11, 1)).toBeGreaterThan(0);
  });

  it("trips on sideways SPEED at high speed", () => {
    // 4 m/s sideways at 40 m/s ahead is only ~5.7 deg, but past the m/s trigger.
    expect(slideRamp(4, 40, 2.5, 0.11, 1)).toBeGreaterThan(0);
  });

  it("lets the rear (bias < 1) break loose before the front", () => {
    expect(slideRamp(1.2, 8, 2.5, 0.11, 0.8)).toBeGreaterThan(slideRamp(1.2, 8, 2.5, 0.11, 1));
  });

  it("saturates at 1 and does not blow up near standstill", () => {
    expect(slideRamp(30, 5, 2.5, 0.11, 1)).toBe(1);
    expect(slideRamp(0.3, 0, 2.5, 0.11, 1)).toBeLessThanOrEqual(1);
  });
});

describe("counterSteerAssist", () => {
  it("is off inside the dead zone, below walking pace, or with zero gain", () => {
    expect(counterSteerAssist(0.05, 20, 0.7, 0.3, 0.1, 0)).toBe(0);
    expect(counterSteerAssist(0.5, 1, 0.7, 0.3, 0.1, 0)).toBe(0);
    expect(counterSteerAssist(0.5, 20, 0, 0.3, 0.1, 0)).toBe(0);
  });

  it("steers toward the direction of travel, in either direction", () => {
    expect(counterSteerAssist(0.3, 20, 0.7, 0.3, 0.1, 0)).toBeGreaterThan(0);
    expect(counterSteerAssist(-0.3, 20, 0.7, 0.3, 0.1, 0)).toBeLessThan(0);
  });

  it("is capped at maxAssist", () => {
    expect(counterSteerAssist(1.2, 20, 0.7, 0.3, 0.1, 0)).toBe(0.3);
    expect(counterSteerAssist(-1.2, 20, 0.7, 0.3, 0.1, 0)).toBe(-0.3);
  });

  it("fades out as the driver steers, vanishing at full input", () => {
    const free = counterSteerAssist(0.4, 20, 0.7, 0.3, 0.1, 0);
    expect(counterSteerAssist(0.4, 20, 0.7, 0.3, 0.1, 0.5)).toBeCloseTo(free * 0.5, 6);
    expect(counterSteerAssist(0.4, 20, 0.7, 0.3, 0.1, 1)).toBe(0);
  });
});

describe("nextHookup", () => {
  const dt = 1 / 60;
  const slide = 0.5; // rad, well past `settled`
  const settled = 0.11;

  it("is zero while the handbrake is held", () => {
    expect(nextHookup(1, true, 1, slide, settled, 0.8, 0.5, dt)).toBe(0);
  });

  it("does not snap back on release", () => {
    expect(nextHookup(0, false, 1, slide, settled, 0.8, 0.5, dt)).toBeLessThan(0.05);
  });

  it("with no throttle, a continuing slide only recovers to the plateau", () => {
    let g = 0;
    for (let i = 0; i < 600; i++) g = nextHookup(g, false, 0, slide, settled, 0.8, 0.5, dt);
    expect(g).toBeCloseTo(0.5, 5);
  });

  it("with throttle, a continuing slide hooks the rear fully up", () => {
    let g = 0;
    for (let i = 0; i < 600; i++) g = nextHookup(g, false, 1, slide, settled, 0.8, 0.5, dt);
    expect(g).toBe(1);
  });

  it("throttle hooks up faster than coasting", () => {
    let coast = 0, push = 0;
    for (let i = 0; i < 30; i++) {
      coast = nextHookup(coast, false, 0, slide, settled, 0.8, 0.5, dt);
      push = nextHookup(push, false, 1, slide, settled, 0.8, 0.5, dt);
    }
    expect(push).toBeGreaterThan(coast);
  });

  it("restores full grip once the slide is over, even with no throttle", () => {
    let g = 0.5;
    for (let i = 0; i < 600; i++) g = nextHookup(g, false, 0, 0.02, settled, 0.8, 0.5, dt);
    expect(g).toBe(1);
  });

  it("takes about recoverTime to go from 0 to 1 under throttle", () => {
    let g = 0, t = 0;
    while (g < 1 && t < 5) { g = nextHookup(g, false, 1, slide, settled, 0.8, 0.5, dt); t += dt; }
    expect(t).toBeGreaterThan(0.75);
    expect(t).toBeLessThan(0.85);
  });
});
