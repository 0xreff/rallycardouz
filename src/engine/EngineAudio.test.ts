import { describe, it, expect } from "vitest";
import {
  simRpm, blendPoints, chase, targetRevFrac, loadGains,
  LAUNCH_FLARE, LAUNCH_ZONE,
} from "./EngineAudio";

const RPMS = [1000, 1800, 2600, 3500, 4400, 5400, 6500];

describe("simRpm", () => {
  it("maps the game's 0..1 fraction onto the recorded range and clamps", () => {
    expect(simRpm(0, 1000, 6500)).toBe(1000);
    expect(simRpm(1, 1000, 6500)).toBe(6500);
    expect(simRpm(0.5, 1000, 6500)).toBeCloseTo(3750);
    expect(simRpm(-3, 1000, 6500)).toBe(1000);
    expect(simRpm(9, 1000, 6500)).toBe(6500);
  });
});

describe("blendPoints", () => {
  it("plays the end loop alone outside the recorded range", () => {
    expect(blendPoints(500, RPMS)).toEqual({ lo: 0, hi: 0, wLo: 1, wHi: 0 });
    expect(blendPoints(9000, RPMS)).toEqual({ lo: 6, hi: 6, wLo: 1, wHi: 0 });
  });

  it("handles a single recorded point", () => {
    expect(blendPoints(3000, [2500])).toEqual({ lo: 0, hi: 0, wLo: 1, wHi: 0 });
  });

  it("picks the bracketing pair and is exactly one loop on a recorded RPM", () => {
    const b = blendPoints(2600, RPMS);
    expect(RPMS[b.lo]).toBeLessThanOrEqual(2600);
    expect(RPMS[b.hi]).toBeGreaterThanOrEqual(2600);
    expect(Math.max(b.wLo, b.wHi)).toBeCloseTo(1, 6);
    expect(Math.min(b.wLo, b.wHi)).toBeCloseTo(0, 6);
  });

  it("is equal-power everywhere (no loudness dip or bump while crossfading)", () => {
    for (let rpm = 1000; rpm <= 6500; rpm += 37) {
      const b = blendPoints(rpm, RPMS);
      expect(b.wLo * b.wLo + b.wHi * b.wHi).toBeCloseTo(1, 9);
      expect(b.hi - b.lo).toBeLessThanOrEqual(1);
    }
  });

  it("moves weight monotonically from the lower to the upper loop", () => {
    let prev = 1;
    for (let rpm = 1800; rpm <= 2600; rpm += 20) {
      const b = blendPoints(rpm, RPMS);
      if (b.lo === 1 && b.hi === 2) {
        expect(b.wLo).toBeLessThanOrEqual(prev + 1e-12);
        prev = b.wLo;
      }
    }
  });
});

describe("chase", () => {
  it("rises faster than it falls and never overshoots", () => {
    const up = chase(0, 1, 1 / 60, 6, 2.5);
    const down = 1 - chase(1, 0, 1 / 60, 6, 2.5);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeLessThan(1);
    expect(chase(0.4, 0.4, 1 / 60, 6, 2.5)).toBeCloseTo(0.4);
  });
});

describe("targetRevFrac", () => {
  it("flares at a standstill under throttle, not without it", () => {
    expect(targetRevFrac(0, 1)).toBeCloseTo(LAUNCH_FLARE);
    expect(targetRevFrac(0, 0)).toBe(0);
  });
  it("adds nothing once the car is moving, and never exceeds 1", () => {
    expect(targetRevFrac(LAUNCH_ZONE, 1)).toBeCloseTo(LAUNCH_ZONE);
    expect(targetRevFrac(0.8, 1)).toBeCloseTo(0.8);
    expect(targetRevFrac(1, 1)).toBe(1);
  });
});

describe("loadGains", () => {
  it("is all 'off' at 0, all 'on' at 1, and equal-power between", () => {
    expect(loadGains(0).on).toBeCloseTo(0);
    expect(loadGains(0).off).toBeCloseTo(1);
    expect(loadGains(1).on).toBeCloseTo(1);
    expect(loadGains(1).off).toBeCloseTo(0);
    const g = loadGains(0.37);
    expect(g.on * g.on + g.off * g.off).toBeCloseTo(1, 9);
  });
});
