import { describe, it, expect } from "vitest";
import { WindControl, WIND_PRESETS, DEFAULT_WIND_PRESET, type WindPresetName } from "./WindConfig";

describe("wind presets", () => {
  const names = Object.keys(WIND_PRESETS) as WindPresetName[];
  const keys = Object.keys(WIND_PRESETS[DEFAULT_WIND_PRESET]).sort();

  it("every preset defines exactly the same finite numbers", () => {
    for (const n of names) {
      expect(Object.keys(WIND_PRESETS[n]).sort()).toEqual(keys);
      for (const v of Object.values(WIND_PRESETS[n])) expect(Number.isFinite(v)).toBe(true);
    }
  });
  it("is sane: fullSpeed above minSpeed, filter ranges ordered, volume 0..1", () => {
    for (const n of names) {
      const p = WIND_PRESETS[n];
      expect(p.fullSpeed).toBeGreaterThan(p.minSpeed);
      expect(p.rumbleLpMax).toBeGreaterThanOrEqual(p.rumbleLpMin);
      expect(p.hissBpMax).toBeGreaterThanOrEqual(p.hissBpMin);
      expect(p.volume).toBeGreaterThanOrEqual(0);
      expect(p.volume).toBeLessThanOrEqual(1);
    }
  });
  it("storm is louder and gustier than calm; off is silent", () => {
    expect(WIND_PRESETS.storm.volume).toBeGreaterThan(WIND_PRESETS.calm.volume);
    expect(WIND_PRESETS.storm.gustDepthA).toBeGreaterThan(WIND_PRESETS.calm.gustDepthA);
    expect(WIND_PRESETS.off.volume).toBe(0);
  });
});

describe("WindControl", () => {
  it("starts on the default preset", () => {
    const c = new WindControl();
    expect(c.preset).toBe(DEFAULT_WIND_PRESET);
    expect(c.settings).toEqual(WIND_PRESETS[DEFAULT_WIND_PRESET]);
  });
  it("setPreset changes the settings in place and bumps the version", () => {
    const c = new WindControl();
    const same = c.settings;
    const v = c.version;
    expect(c.setPreset("storm")).toBe(true);
    expect(c.settings).toBe(same); // same object, so WindAudio keeps reading it
    expect(c.settings.volume).toBe(WIND_PRESETS.storm.volume);
    expect(c.version).toBe(v + 1);
  });
  it("rejects unknown preset names without changing anything", () => {
    const c = new WindControl();
    const v = c.version;
    expect(c.setPreset("hurricane")).toBe(false);
    expect(c.setPreset("toString")).toBe(false);
    expect(c.version).toBe(v);
    expect(c.preset).toBe(DEFAULT_WIND_PRESET);
  });
  it("tweak overrides only valid numeric known keys", () => {
    const c = new WindControl();
    c.tweak({ volume: 0.7 });
    expect(c.settings.volume).toBe(0.7);
    c.tweak({ volume: NaN, bogus: 5 } as never);
    expect(c.settings.volume).toBe(0.7);
    expect((c.settings as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});
