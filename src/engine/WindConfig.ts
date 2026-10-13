/**
 * MAIN CONTROL FILE FOR THE WIND SOUND.
 *
 * Every wind number lives here. WindAudio reads `windControl.settings` live, so you can
 * change anything while the game runs.
 *
 * Pick a look
 *   - in this file : change DEFAULT_WIND_PRESET below
 *   - in the URL   : http://localhost:5173/?wind=storm        (off | calm | desert | storm)
 *                    http://localhost:5173/?wind=desert&windvol=0.5
 *   - in the console (F12) while playing:
 *        wind.setPreset("storm")
 *        wind.tweak({ volume: 0.5, hissCurve: 2 })
 *        wind.list()          // preset names
 *        wind.settings        // current values
 *
 * What the numbers mean
 *   volume        overall wind level on the master bus (0..1)
 *   fullSpeed     speed (m/s) where the wind is at full strength (55 = ~200 km/h)
 *   minSpeed      below this speed (m/s) there is no speed-driven wind
 *   rumbleCurve   how late the low rumble ramps up (bigger = later and steeper)
 *   hissCurve     same for the high whoosh (bigger = only at very high speed)
 *   rumbleGain /  strength of each band
 *   hissGain
 *   rumbleLpMin/Max   low-pass sweep of the rumble (Hz): darker when slow, brighter when fast
 *   hissBpMin/Max     band-pass sweep of the whoosh (Hz)
 *   gustDepthA/B  how much the wind level "breathes" (fraction of the level)
 *   gustHzA/B     how fast it breathes (Hz); two slow waves are mixed so it never repeats evenly
 *   smooth        how quickly the sound follows the speed (seconds; smaller = snappier)
 *   airBoost      wind multiplier while the car is in the air
 *   ambient       wind that is always there, even when parked (0..1 of full strength)
 */

export interface WindSettings {
  volume: number;
  fullSpeed: number;
  minSpeed: number;
  rumbleCurve: number;
  hissCurve: number;
  rumbleGain: number;
  hissGain: number;
  rumbleLpMin: number;
  rumbleLpMax: number;
  hissBpMin: number;
  hissBpMax: number;
  gustDepthA: number;
  gustDepthB: number;
  gustHzA: number;
  gustHzB: number;
  smooth: number;
  airBoost: number;
  ambient: number;
}

export type WindPresetName = "off" | "calm" | "desert" | "storm";

export const WIND_PRESETS: Record<WindPresetName, WindSettings> = {
  // no wind at all
  off: {
    volume: 0, fullSpeed: 55, minSpeed: 3, rumbleCurve: 1.4, hissCurve: 2.6, rumbleGain: 0.9, hissGain: 0.6,
    rumbleLpMin: 180, rumbleLpMax: 700, hissBpMin: 1400, hissBpMax: 3800,
    gustDepthA: 0, gustDepthB: 0, gustHzA: 0.31, gustHzB: 0.77, smooth: 0.12, airBoost: 1, ambient: 0,
  },
  // quiet, steady wind: only really noticeable at high speed
  calm: {
    volume: 0.25, fullSpeed: 65, minSpeed: 5, rumbleCurve: 1.8, hissCurve: 3.2, rumbleGain: 0.8, hissGain: 0.45,
    rumbleLpMin: 160, rumbleLpMax: 550, hissBpMin: 1300, hissBpMax: 3200,
    gustDepthA: 0.05, gustDepthB: 0.03, gustHzA: 0.22, gustHzB: 0.55, smooth: 0.18, airBoost: 1.05, ambient: 0,
  },
  // default: open desert, a gentle breeze when parked, building to a whoosh at speed
  desert: {
    volume: 0.35, fullSpeed: 55, minSpeed: 3, rumbleCurve: 1.4, hissCurve: 2.6, rumbleGain: 0.9, hissGain: 0.6,
    rumbleLpMin: 180, rumbleLpMax: 700, hissBpMin: 1400, hissBpMax: 3800,
    gustDepthA: 0.14, gustDepthB: 0.08, gustHzA: 0.31, gustHzB: 0.77, smooth: 0.12, airBoost: 1.1, ambient: 0.14,
  },
  // gusty, loud, wind that never quite stops
  storm: {
    volume: 0.5, fullSpeed: 45, minSpeed: 2, rumbleCurve: 1.1, hissCurve: 2.0, rumbleGain: 1.0, hissGain: 0.8,
    rumbleLpMin: 260, rumbleLpMax: 900, hissBpMin: 1600, hissBpMax: 4200,
    gustDepthA: 0.3, gustDepthB: 0.16, gustHzA: 0.5, gustHzB: 1.3, smooth: 0.08, airBoost: 1.15, ambient: 0.32,
  },
};

export const DEFAULT_WIND_PRESET: WindPresetName = "desert";

export class WindControl {
  /** Current values (mutated in place; WindAudio keeps reading this same object). */
  readonly settings: WindSettings = { ...WIND_PRESETS[DEFAULT_WIND_PRESET] };
  preset: WindPresetName = DEFAULT_WIND_PRESET;
  /** Bumped on every change so WindAudio knows to re-apply the slow parameters. */
  version = 0;

  list(): WindPresetName[] {
    return Object.keys(WIND_PRESETS) as WindPresetName[];
  }

  /** Switch to a named preset. Returns false (and changes nothing) for an unknown name. */
  setPreset(name: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(WIND_PRESETS, name)) return false;
    Object.assign(this.settings, WIND_PRESETS[name as WindPresetName]);
    this.preset = name as WindPresetName;
    this.version++;
    return true;
  }

  /** Override individual numbers on top of the current preset. */
  tweak(partial: Partial<WindSettings>): void {
    for (const [k, v] of Object.entries(partial)) {
      if (k in this.settings && typeof v === "number" && Number.isFinite(v)) {
        (this.settings as unknown as Record<string, number>)[k] = v;
      }
    }
    this.version++;
  }
}

export const windControl = new WindControl();

// URL switches and a console handle (browser only).
if (typeof window !== "undefined") {
  try {
    const q = new URLSearchParams(window.location.search);
    const p = q.get("wind");
    if (p) windControl.setPreset(p);
    const vol = q.get("windvol");
    if (vol !== null && vol !== "") windControl.tweak({ volume: Number(vol) });
    (window as unknown as { wind?: WindControl }).wind = windControl;
  } catch {
    /* no URL access: keep the defaults */
  }
}
