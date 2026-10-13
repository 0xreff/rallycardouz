import { describe, it, expect } from "vitest";
import { windAmount, bandLevel, lerp, makePinkNoise } from "./WindAudio";
import { WIND_PRESETS } from "./WindConfig";

const D = WIND_PRESETS.desert;

describe("windAmount", () => {
  it("is silent at and below the minimum speed", () => {
    expect(windAmount(0, D.fullSpeed, D.minSpeed)).toBe(0);
    expect(windAmount(D.minSpeed, D.fullSpeed, D.minSpeed)).toBe(0);
  });
  it("reaches 1 at full speed and clamps above it", () => {
    expect(windAmount(D.fullSpeed, D.fullSpeed, D.minSpeed)).toBe(1);
    expect(windAmount(D.fullSpeed * 3, D.fullSpeed, D.minSpeed)).toBe(1);
  });
  it("treats reversing like driving forward", () => {
    expect(windAmount(-30, D.fullSpeed, D.minSpeed)).toBeCloseTo(windAmount(30, D.fullSpeed, D.minSpeed));
  });
  it("rises monotonically", () => {
    let prev = -1;
    for (let v = 0; v <= 60; v += 2) {
      const a = windAmount(v, D.fullSpeed, D.minSpeed);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
});

describe("bandLevel", () => {
  it("the hiss band stays quieter than the rumble at mid speed, and catches up at the top", () => {
    expect(bandLevel(0.5, D.hissCurve, 1)).toBeLessThan(bandLevel(0.5, D.rumbleCurve, 1));
    expect(bandLevel(1, D.hissCurve, 1)).toBeCloseTo(bandLevel(1, D.rumbleCurve, 1));
  });
});

describe("lerp", () => {
  it("interpolates and clamps t", () => {
    expect(lerp(100, 200, 0.5)).toBe(150);
    expect(lerp(100, 200, 5)).toBe(200);
    expect(lerp(100, 200, -1)).toBe(100);
  });
});

describe("makePinkNoise", () => {
  it("has the requested length, stays in range and has no wrap-around click", () => {
    const sr = 8000;
    const x = makePinkNoise(sr, 2, 0.25);
    expect(x.length).toBe(sr * 2);
    let peak = 0, stepSum = 0;
    for (let i = 0; i < x.length; i++) {
      peak = Math.max(peak, Math.abs(x[i]));
      if (i > 0) stepSum += Math.abs(x[i] - x[i - 1]);
    }
    expect(peak).toBeLessThan(1.5);
    const typicalStep = stepSum / (x.length - 1);
    const wrapStep = Math.abs(x[0] - x[x.length - 1]);
    expect(wrapStep).toBeLessThan(typicalStep * 8);
  });
});
