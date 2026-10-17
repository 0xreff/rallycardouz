import * as THREE from "three";
import type { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { NightAtmosphere } from "./NightAtmosphere";
import { WIND_DIR } from "./NightAtmosphere";
import type { AtmospherePass } from "./AtmospherePass";
import type { SkidMarks } from "./SkidMarks";
import { Rain } from "./Rain";
import { rimGlobal } from "./RimMaterial";
import { makePinkNoise } from "./WindAudio";
import { windControl } from "./WindConfig";

/**
 * WEATHER / TIME-OF-DAY SELECTOR.
 *
 * A dropdown at the top centre of the screen switches between 8 complete looks. Each look
 * is just a table of numbers (sky, sun/moon, fog, clouds, post-processing, ground, rain,
 * wind), so the "wow" is tuned by editing the LOOKS table below, or live with the K panel
 * (Save keeps your tweaks per look).
 *
 *  - switching fades smoothly (about 3 s) instead of popping
 *  - the choice is remembered; open the game with ?weather=rain to force one
 *    (ids: rain dawn pitch fullmoon sunrise wind clear sunset), "original" in the list
 *    returns to the original desert-day / night theme
 *  - cost: clouds are a few noise taps on sky pixels only, rain is one GPU line batch whose
 *    amount only changes the draw range, wet ground is two multiplies in the ground shader
 */

// --------------------------------------------------------------------------- looks
const H = (hex: number) => new THREE.Color(hex);
const V = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b);

export interface Look {
    // sky
    horizon: THREE.Color; zenith: THREE.Color; mid: THREE.Color; midAmt: number;
    band: THREE.Color; bandAmt: number;       // warm glow hugging the horizon towards the sun
    tint: THREE.Color; stars: number; glow: number; discSize: number; discGain: number;
    haze: number; day: number;                // day: 0 = night sky, 1 = day sky (glow terms, moon craters)
    // clouds
    cloud: number; cloudCol: THREE.Color; cloudDark: THREE.Color; cloudSpeed: number;
    // sun / moon
    azimuth: number; elevation: number;       // degrees, azimuth 0 = the spawn heading (+Z)
    keyColor: THREE.Color; keyIntensity: number; shadows: boolean;
    // sky fill + camera + fog
    hemiSky: THREE.Color; hemiGround: THREE.Color; hemiIntensity: number;
    exposure: number; fogNear: number; fogFar: number;
    // post
    bloomStrength: number; bloomRadius: number; bloomThreshold: number;
    rayStrength: number; rayThreshold: number; rayWidth: number; rayColor: THREE.Color;
    saturation: number; vignette: number;
    shadowTint: THREE.Color; highTint: THREE.Color; lift: THREE.Color;
    // ground, sand, rain, wind
    rippleGain: number; glintGain: number; glintColor: THREE.Color; wet: number;
    sandColor: THREE.Color; sandAlpha: number; sandSpeed: number; sandSize: number; sandMaxPx: number;
    sandAdditive: boolean;
    rain: number; lightning: number;          // 0..1
    windPreset: "off" | "calm" | "desert" | "storm";
    skidAmbient: number;
    rim: number; rimTint: THREE.Color;         // edge glow on cars: 0 = off, 1 = the material's own strength
}

const BASE_NIGHT: Look = {
    horizon: H(0x251a4a), zenith: H(0x05050f), mid: H(0x000000), midAmt: 0, band: H(0xff9a45), bandAmt: 0,
    tint: V(0.85, 0.82, 1.0), stars: 1, glow: 1, discSize: 0.032, discGain: 2, haze: 0, day: 0,
    cloud: 0, cloudCol: H(0xffffff), cloudDark: H(0x808890), cloudSpeed: 1,
    azimuth: 18.8, elevation: 21, keyColor: H(0xb4a8ff), keyIntensity: 0.6, shadows: true,
    hemiSky: H(0x6a5cc8), hemiGround: H(0x1b1535), hemiIntensity: 0.85,
    exposure: 1.05, fogNear: 220, fogFar: 1300,
    bloomStrength: 0.55, bloomRadius: 0.6, bloomThreshold: 0.85,
    rayStrength: 0.55, rayThreshold: 0.8, rayWidth: 0.8, rayColor: V(0.62, 0.55, 1.0),
    saturation: 1.08, vignette: 0.35, shadowTint: V(1.1, 0.9, 1.3), highTint: V(1, 1, 1.06), lift: V(0, 0, 0),
    rippleGain: 1, glintGain: 0.25, glintColor: V(0.5, 0.45, 0.9), wet: 0,
    sandColor: V(0.7, 0.62, 1.0), sandAlpha: 0.2, sandSpeed: 7, sandSize: 28, sandMaxPx: 6, sandAdditive: true,
    rain: 0, lightning: 0, windPreset: "desert", skidAmbient: 0.6,
    rim: 1, rimTint: V(1, 1, 1),
};

const BASE_DAY: Look = {
    horizon: H(0xe39a5a), zenith: H(0x7d7f88), mid: H(0x000000), midAmt: 0, band: H(0xff9a45), bandAmt: 0,
    tint: V(1.0, 0.9, 0.7), stars: 0, glow: 1, discSize: 0.05, discGain: 6, haze: 1, day: 1,
    cloud: 0, cloudCol: H(0xffffff), cloudDark: H(0x808890), cloudSpeed: 1,
    azimuth: -28.5, elevation: 19.8, keyColor: H(0xffd3a0), keyIntensity: 5.4, shadows: true,
    hemiSky: H(0xd9a47a), hemiGround: H(0x7a3a1c), hemiIntensity: 1.5,
    exposure: 1.0, fogNear: 70, fogFar: 820,
    bloomStrength: 0.38, bloomRadius: 0.7, bloomThreshold: 1.1,
    rayStrength: 0.75, rayThreshold: 1.7, rayWidth: 1.6, rayColor: V(1.0, 0.7, 0.38),
    saturation: 1.14, vignette: 0.3, shadowTint: V(1.06, 0.88, 0.8), highTint: V(1.07, 1.0, 0.88), lift: V(0.045, 0.024, 0.012),
    rippleGain: 1.8, glintGain: 0.55, glintColor: V(1.0, 0.8, 0.5), wet: 0,
    sandColor: V(0.93, 0.66, 0.4), sandAlpha: 0.32, sandSpeed: 7, sandSize: 70, sandMaxPx: 22, sandAdditive: false,
    rain: 0, lightning: 0, windPreset: "desert", skidAmbient: 0.3,
    rim: 1, rimTint: V(1, 1, 1),
};

const mk = (base: Look, o: Partial<Look>): Look => ({ ...base, ...o });

export type WeatherId = "rain" | "dawn" | "pitch" | "fullmoon" | "sunrise" | "wind" | "clear" | "sunset";

/** Order and Arabic names = the dropdown. */
export const WEATHER_LIST: { id: WeatherId; label: string }[] = [
    { id: "rain", label: "🌧️ ممطر" },
    { id: "dawn", label: "🌅 عند الفجر" },
    { id: "pitch", label: "🌑 ليل كاحل" },
    { id: "fullmoon", label: "🌕 ليل القمر كامل" },
    { id: "sunrise", label: "⛅ عند مطلع الشمس الجو غائم" },
    { id: "wind", label: "🌪️ رياح شديدة" },
    { id: "clear", label: "☀️ الجو ممتاز" },
    { id: "sunset", label: "🌇 قبل مغرب الشمس" },
];

export const LOOKS: Record<WeatherId, Look> = {
    // Dark overcast, heavy rain, soaked glossy sand, lightning and thunder.
    rain: mk(BASE_DAY, {
        horizon: H(0x4a5560), zenith: H(0x20262e), mid: H(0x39424c), midAmt: 1, tint: V(0.7, 0.75, 0.85),
        stars: 0, glow: 0.2, discGain: 0, haze: 0.3, day: 0.6,
        cloud: 0.97, cloudCol: H(0x6a7480), cloudDark: H(0x262c34), cloudSpeed: 1.6,
        azimuth: -20, elevation: 35, keyColor: H(0x9aa8b8), keyIntensity: 1.1,
        hemiSky: H(0x7d8a99), hemiGround: H(0x2c2f33), hemiIntensity: 1.35,
        exposure: 1.05, fogNear: 20, fogFar: 380,
        bloomStrength: 0.45, bloomRadius: 0.7, bloomThreshold: 0.9, rayStrength: 0,
        saturation: 0.72, vignette: 0.45, shadowTint: V(0.9, 0.95, 1.1), highTint: V(0.96, 1, 1.04), lift: V(0, 0.004, 0.01),
        rippleGain: 0.5, glintGain: 0.1, wet: 1,
        sandColor: V(0.6, 0.62, 0.66), sandAlpha: 0.05, sandSpeed: 9,
        rain: 1, lightning: 0.65, windPreset: "desert", skidAmbient: 0.25,
        rim: 0.35, rimTint: V(0.8, 0.95, 1.1),
    }),
    // Like the night theme, but enhanced: indigo to magenta sky, glowing orange horizon, last stars.
    dawn: mk(BASE_NIGHT, {
        horizon: H(0x6a3f7a), mid: H(0x2c2a6c), midAmt: 1, zenith: H(0x070a1e),
        band: H(0xff7a55), bandAmt: 1.1, tint: V(1.0, 0.62, 0.5), stars: 0.55, glow: 1.7, discSize: 0.042, discGain: 2.6, day: 0.45,
        cloud: 0.22, cloudCol: H(0xd8a0b8), cloudDark: H(0x3a3060), cloudSpeed: 0.8,
        azimuth: -22, elevation: 1.5, keyColor: H(0xff9a8a), keyIntensity: 1.3,
        hemiSky: H(0x7a6ad8), hemiGround: H(0x2a1f40), hemiIntensity: 1.0,
        exposure: 1.1, fogNear: 100, fogFar: 1500,
        bloomStrength: 0.7, bloomRadius: 0.7, bloomThreshold: 0.95,
        rayStrength: 0.75, rayThreshold: 1.0, rayWidth: 1.3, rayColor: V(1.0, 0.55, 0.45),
        saturation: 1.18, vignette: 0.4, highTint: V(1.04, 0.98, 1.04), lift: V(0.012, 0.004, 0.02),
        glintGain: 0.35, glintColor: V(0.95, 0.6, 0.7), sandColor: V(0.9, 0.7, 0.85), sandAlpha: 0.2, skidAmbient: 0.5,
        rim: 1, rimTint: V(1.5, 0.85, 0.95),
    }),
    // No moon at all: only stars and your headlights.
    pitch: mk(BASE_NIGHT, {
        horizon: H(0x07070e), zenith: H(0x010103), stars: 1.5, glow: 0, discGain: 0, discSize: 0.001,
        azimuth: 18.8, elevation: 25, keyColor: H(0x5060a0), keyIntensity: 0.07, shadows: false,
        hemiSky: H(0x1a1f4a), hemiGround: H(0x07070f), hemiIntensity: 0.22,
        exposure: 1.15, fogNear: 60, fogFar: 650,
        bloomStrength: 0.75, bloomRadius: 0.7, bloomThreshold: 1.0, rayStrength: 0,
        saturation: 1.0, vignette: 0.55, rippleGain: 0.3, glintGain: 0.05, sandAlpha: 0.08, skidAmbient: 0.2,
        rim: 0.05, rimTint: V(1, 1, 1), // only lamps and the headlight beams may glow
    }),
    // Big bright cold moon, silver sand, long visibility.
    fullmoon: mk(BASE_NIGHT, {
        horizon: H(0x1d2f5c), mid: H(0x10204a), midAmt: 0.6, zenith: H(0x04081a),
        tint: V(0.92, 0.95, 1.0), stars: 0.55, glow: 1.9, discSize: 0.046, discGain: 3.4,
        cloud: 0.12, cloudCol: H(0x9fb4e0), cloudDark: H(0x1a2340), cloudSpeed: 0.7,
        azimuth: 12, elevation: 30, keyColor: H(0xc9d8ff), keyIntensity: 1.2,
        hemiSky: H(0x6f8fe0), hemiGround: H(0x1e2848), hemiIntensity: 1.1,
        exposure: 1.05, fogNear: 280, fogFar: 2200,
        bloomStrength: 0.62, bloomRadius: 0.65, bloomThreshold: 1.0,
        rayStrength: 0.5, rayThreshold: 0.9, rayWidth: 0.9, rayColor: V(0.7, 0.8, 1.0),
        saturation: 1.05, vignette: 0.35, shadowTint: V(0.95, 0.98, 1.2), highTint: V(0.98, 1, 1.08), lift: V(0, 0.004, 0.012),
        rippleGain: 1.1, glintGain: 0.55, glintColor: V(0.7, 0.8, 1.0), sandColor: V(0.75, 0.82, 1.0), sandAlpha: 0.18, skidAmbient: 0.6,
        rim: 0.75, rimTint: V(0.75, 0.9, 1.1),
    }),
    // Low veiled sun behind a thick pink-grey cloud deck, mist on the sand.
    sunrise: mk(BASE_DAY, {
        horizon: H(0xd9917a), mid: H(0x8d7a98), midAmt: 1, zenith: H(0x4a5878),
        band: H(0xffb08a), bandAmt: 0.6, tint: V(1.0, 0.8, 0.62), glow: 1.2, discSize: 0.05, discGain: 3.5, haze: 0.8,
        cloud: 0.86, cloudCol: H(0xe9b9a0), cloudDark: H(0x59506a), cloudSpeed: 1.2,
        azimuth: 30, elevation: 3.5, keyColor: H(0xffc7a0), keyIntensity: 2.4,
        hemiSky: H(0x9aa6c4), hemiGround: H(0x5a4540), hemiIntensity: 1.3,
        exposure: 1.0, fogNear: 35, fogFar: 620,
        bloomStrength: 0.5, bloomRadius: 0.8, bloomThreshold: 0.95,
        rayStrength: 0.55, rayThreshold: 1.2, rayWidth: 1.8, rayColor: V(1.0, 0.75, 0.55),
        saturation: 1.0, vignette: 0.38, shadowTint: V(0.95, 0.95, 1.1), highTint: V(1.04, 1, 0.96), lift: V(0.03, 0.025, 0.03),
        rippleGain: 1.1, glintGain: 0.15, sandColor: V(0.85, 0.7, 0.6), sandAlpha: 0.22, skidAmbient: 0.4,
        rim: 0.6, rimTint: V(1.4, 0.95, 0.9),
    }),
    // Dust storm: orange-brown haze, fast dust clouds, streaming sand, strong ripples, roaring wind.
    wind: mk(BASE_DAY, {
        horizon: H(0xc8905a), mid: H(0xb08a64), midAmt: 1, zenith: H(0x8a7560),
        glow: 1.4, discGain: 1.6, haze: 1,
        cloud: 0.6, cloudCol: H(0xd7a878), cloudDark: H(0x7a5a40), cloudSpeed: 7,
        azimuth: -25, elevation: 28, keyColor: H(0xffc890), keyIntensity: 2.6,
        hemiSky: H(0xc9a07a), hemiGround: H(0x6a4a30), hemiIntensity: 1.4,
        exposure: 1.0, fogNear: 12, fogFar: 240,
        bloomStrength: 0.35, bloomRadius: 0.8, bloomThreshold: 1.2,
        rayStrength: 0.3, rayThreshold: 1.8, rayColor: V(1.0, 0.7, 0.4),
        saturation: 1.05, vignette: 0.42, rippleGain: 3.0, glintGain: 0.35,
        sandColor: V(0.9, 0.68, 0.45), sandAlpha: 0.55, sandSpeed: 26, sandSize: 95, sandMaxPx: 32,
        windPreset: "storm", skidAmbient: 0.3,
        rim: 0.5, rimTint: V(1.5, 1.1, 0.7),
    }),
    // Crisp clear blue day, high sun, white clouds, far visibility.
    clear: mk(BASE_DAY, {
        horizon: H(0xbfd9f0), mid: H(0x6fa6dc), midAmt: 1, zenith: H(0x2f6fc4),
        tint: V(1.0, 0.97, 0.88), glow: 0.6, discSize: 0.035, discGain: 8, haze: 0.15,
        cloud: 0.24, cloudCol: H(0xffffff), cloudDark: H(0xaab6c8), cloudSpeed: 0.8,
        azimuth: -25, elevation: 50, keyColor: H(0xfff1dc), keyIntensity: 4.6,
        hemiSky: H(0x9ec7ff), hemiGround: H(0xb8905f), hemiIntensity: 1.6,
        exposure: 1.0, fogNear: 250, fogFar: 2400,
        bloomStrength: 0.3, bloomRadius: 0.6, bloomThreshold: 1.2,
        rayStrength: 0.45, rayThreshold: 1.9, rayWidth: 1.2, rayColor: V(1.0, 0.9, 0.7),
        saturation: 1.12, vignette: 0.22, shadowTint: V(1.0, 0.92, 0.9), highTint: V(1.04, 1.02, 0.97), lift: V(0.02, 0.015, 0.01),
        rippleGain: 1.3, glintGain: 0.6, glintColor: V(1.0, 0.92, 0.75), sandColor: V(0.95, 0.8, 0.55), sandAlpha: 0.12, sandSpeed: 4,
        windPreset: "calm", skidAmbient: 0.3,
        rim: 0.2, rimTint: V(0.9, 1.3, 1.5),
    }),
    // Golden hour: sun low and huge, orange to rose to indigo sky, long warm shadows.
    sunset: mk(BASE_DAY, {
        horizon: H(0xf0833a), mid: H(0xc4506a), midAmt: 1, zenith: H(0x3a3f7a),
        band: H(0xff9a45), bandAmt: 0.9, tint: V(1.0, 0.72, 0.45), glow: 1.3, discSize: 0.06, discGain: 7, haze: 1,
        cloud: 0.36, cloudCol: H(0xffb27a), cloudDark: H(0x6b4a6a), cloudSpeed: 0.9,
        azimuth: -28, elevation: 8.5, keyColor: H(0xffa860), keyIntensity: 5.8,
        hemiSky: H(0xe0907a), hemiGround: H(0x6b2f1c), hemiIntensity: 1.2,
        exposure: 1.0, fogNear: 55, fogFar: 900,
        bloomStrength: 0.5, bloomRadius: 0.75, bloomThreshold: 1.0,
        rayStrength: 0.95, rayThreshold: 1.5, rayWidth: 2.0, rayColor: V(1.0, 0.6, 0.3),
        saturation: 1.2, vignette: 0.34, shadowTint: V(1.1, 0.8, 0.78), highTint: V(1.1, 0.98, 0.85), lift: V(0.06, 0.03, 0.015),
        rippleGain: 2.0, glintGain: 0.7, glintColor: V(1.0, 0.7, 0.4), sandColor: V(0.98, 0.6, 0.32), sandAlpha: 0.3, skidAmbient: 0.35,
        rim: 0.8, rimTint: V(1.6, 0.9, 0.6),
    }),
};

// --------------------------------------------------------------------------- helpers
const cloneLook = (l: Look): Look => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(l)) o[k] = v instanceof THREE.Color ? v.clone() : v;
    return o as unknown as Look;
};

/** out = a + (b - a) * t for numbers and colours; booleans / strings switch to b at once. */
export function mixLook(a: Look, b: Look, t: number, out: Look): Look {
    const A = a as unknown as Record<string, unknown>, B = b as unknown as Record<string, unknown>;
    const O = out as unknown as Record<string, unknown>;
    for (const k of Object.keys(A)) {
        const va = A[k], vb = B[k];
        if (typeof va === "number") O[k] = va + ((vb as number) - va) * t;
        else if (va instanceof THREE.Color) (O[k] as THREE.Color).copy(va).lerp(vb as THREE.Color, t);
        else O[k] = vb;
    }
    return out;
}

const STORE = "weather:v1";
const TRANSITION_S = 3;

export interface WeatherTargets {
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    atmosphere: NightAtmosphere;
    bloom: UnrealBloomPass;
    atmospherePass: AtmospherePass;
    skids: SkidMarks;
    quality: "high" | "low";
    /** The K panel: told to re-read the scene when a look has finished fading in. */
    worldLights?: { switchLook(id: string): void };
    /** false = no dropdown (tests). */
    ui?: boolean;
}

export class Weather {
    private readonly t: WeatherTargets;
    private readonly rain: Rain;
    private readonly audio = new WeatherAudio();
    private cur: Look | null = null;
    private from: Look | null = null;
    private to: Look | null = null;
    private k = 1;                       // 0..1 progress of the current fade
    private id: WeatherId | null = null;
    private select: HTMLSelectElement | null = null;
    private flashT = 99;                 // seconds since the last bolt
    private flashPeak = 0;
    private nextBolt = 8;
    private appliedWind = "";
    private shadowsOn = true;
    private readonly tmpC = new THREE.Color();

    constructor(t: WeatherTargets) {
        this.t = t;
        this.rain = new Rain(t.scene, t.quality);
        if (t.ui !== false) this.buildUI();
        const q = new URLSearchParams(window.location.search).get("weather");
        let saved: string | null = null;
        try { saved = localStorage.getItem(STORE); } catch { /* ignore */ }
        const start = (q ?? saved) as WeatherId | null;
        if (start && start in LOOKS) this.set(start, true);
    }

    /** Called once the engine's AudioContext exists (rain loop + thunder). */
    attachAudio(ctx: AudioContext, dest: AudioNode) {
        this.audio.attach(ctx, dest);
    }

    /** Switch to a look. instant = no fade. */
    set(id: WeatherId, instant = false) {
        const target = LOOKS[id];
        this.id = id;
        window.dispatchEvent(new CustomEvent("weatherchange", { detail: id })); // car lights follow the weather
        if (this.select) this.select.value = id;
        try { localStorage.setItem(STORE, id); } catch { /* ignore */ }
        if (!this.cur || instant) {
            this.cur = cloneLook(target);
            this.from = this.to = null;
            this.k = 1;
            this.apply(this.cur);
            this.t.worldLights?.switchLook(id);
        } else {
            this.from = cloneLook(this.cur);
            this.to = target;
            this.k = 0;
        }
        this.nextBolt = 3 + Math.random() * 5;
    }

    /** Per frame. `focus` = the car position (rain and lightning follow it). */
    update(dt: number, focus: THREE.Vector3) {
        if (!this.cur) return;
        let changing = false;
        if (this.to && this.from) {
            changing = true; // includes the final frame, so the look lands exactly on its target
            this.k = Math.min(1, this.k + dt / TRANSITION_S);
            const s = this.k * this.k * (3 - 2 * this.k);
            mixLook(this.from, this.to, s, this.cur);
            this.cur.sandAdditive = this.to.sandAdditive;
            this.cur.shadows = this.to.shadows;
            this.cur.windPreset = this.to.windPreset;
            if (this.k >= 1) {
                this.from = null;
                this.to = null;
                if (this.id) this.t.worldLights?.switchLook(this.id);
            }
        }
        // lightning: random bolts while it rains
        const bolts = this.cur.lightning * Math.min(1, this.cur.rain * 1.5);
        let flash = 0;
        if (bolts > 0.02) {
            this.nextBolt -= dt;
            if (this.nextBolt <= 0) {
                this.flashT = 0;
                this.flashPeak = 0.6 + 0.4 * Math.random();
                this.nextBolt = (7 + Math.random() * 14) / bolts;
                this.audio.thunder(0.4 + Math.random() * 3);
            }
        }
        if (this.flashT < 1.3) {
            this.flashT += dt;
            const f = (this.flashT < 0.05 ? this.flashT / 0.05 : Math.exp(-(this.flashT - 0.05) * 8)) +
                0.7 * Math.exp(-Math.pow((this.flashT - 0.2) * 14, 2));
            flash = Math.min(1, f) * this.flashPeak;
        }
        if (changing || flash > 0 || this.flashT < 1.3) this.apply(this.cur, flash);
        this.rain.update(dt, focus);
        this.audio.setRain(this.cur.rain);
    }

    private apply(L: Look, flash = 0) {
        const { atmosphere: a, renderer, bloom, atmospherePass: p, scene, skids } = this.t;
        const u = a.skyUniforms, pu = p.uniforms, pr = renderer.getPixelRatio();

        a.moonLight.intensity = L.keyIntensity;
        a.moonLight.color.copy(L.keyColor);
        a.setKeyDirection(L.azimuth, Math.max(0.5, L.elevation)); // keep the disc just above the horizon
        if (L.shadows !== this.shadowsOn) { a.moonLight.castShadow = L.shadows; this.shadowsOn = L.shadows; }
        a.setShadowStyle(L.day < 0.5);
        a.hemi.intensity = L.hemiIntensity + flash * 2.5;
        a.hemi.color.copy(L.hemiSky);
        a.hemi.groundColor.copy(L.hemiGround);
        renderer.toneMappingExposure = L.exposure;

        (u.uHorizon.value as THREE.Color).copy(L.horizon);
        (u.uZenith.value as THREE.Color).copy(L.zenith);
        (u.uMid.value as THREE.Color).copy(L.mid);
        u.uMidAmt.value = L.midAmt;
        (u.uBand.value as THREE.Color).copy(L.band);
        u.uBandAmt.value = L.bandAmt;
        (u.uMoonTint.value as THREE.Color).copy(L.tint);
        u.uStars.value = L.stars;
        u.uGlow.value = L.glow;
        u.uDiscSize.value = L.discSize;
        u.uDiscGain.value = L.discGain;
        u.uHaze.value = L.haze;
        u.uDay.value = L.day;
        u.uCloud.value = L.cloud;
        (u.uCloudCol.value as THREE.Color).copy(L.cloudCol);
        (u.uCloudDark.value as THREE.Color).copy(L.cloudDark);
        u.uCloudSpeed.value = L.cloudSpeed;
        u.uFlash.value = flash;

        const fog = scene.fog as THREE.Fog | null;
        if (fog) {
            fog.near = L.fogNear;
            fog.far = Math.max(L.fogFar, L.fogNear + 1);
            fog.color.copy(L.horizon);
        }
        if (scene.background instanceof THREE.Color) scene.background.copy(L.horizon);

        bloom.strength = L.bloomStrength;
        bloom.radius = L.bloomRadius;
        bloom.threshold = L.bloomThreshold;
        pu.uRayStrength.value = L.rayStrength;
        pu.uRayThreshold.value = L.rayThreshold;
        pu.uRayWidth.value = L.rayWidth;
        (pu.uRayColor.value as THREE.Color).copy(L.rayColor);
        pu.uSaturation.value = L.saturation;
        pu.uVignette.value = L.vignette;
        (pu.uShadowTint.value as THREE.Color).copy(L.shadowTint);
        (pu.uHighTint.value as THREE.Color).copy(L.highTint);
        (pu.uLift.value as THREE.Color).copy(L.lift);

        a.groundUniforms.rippleGain.value = L.rippleGain;
        a.groundUniforms.glintGain.value = L.glintGain;
        a.groundUniforms.glintColor.value.copy(L.glintColor);
        a.groundUniforms.wet.value = L.wet;

        a.setSandStyle(L.sandAdditive);
        a.sandUniforms.uAlpha.value = L.sandAlpha;
        (a.sandUniforms.uColor.value as THREE.Color).copy(L.sandColor);
        a.sandUniforms.uSize.value = L.sandSize * pr;
        a.sandUniforms.uMaxPx.value = L.sandMaxPx * pr;
        (a.sandUniforms.uWind.value as THREE.Vector2).copy(WIND_DIR).multiplyScalar(L.sandSpeed);

        skids.setLight(a.moonDir, a.moonLight.color, L.skidAmbient);

        // car edge glow follows the look (no violet outline glowing in the dark)
        rimGlobal.mul.value = L.rim;
        rimGlobal.tint.value.copy(L.rimTint);

        // rain: amount, colour (the fog colour, lightened) and slant (follows the wind)
        this.rain.setAmount(L.rain);
        this.rain.setColor(this.tmpC.copy(L.horizon).lerp(WHITE, 0.55));
        this.rain.setWind(WIND_DIR.x * L.sandSpeed * 0.35, WIND_DIR.y * L.sandSpeed * 0.35);

        // wind sound follows the look (only when it changes)
        if (L.windPreset !== this.appliedWind) {
            this.appliedWind = L.windPreset;
            windControl.setPreset(L.windPreset);
        }
    }

    // --------------------------------------------------------------------- dropdown
    private buildUI() {
        const sel = document.createElement("select");
        sel.dir = "rtl";
        sel.title = "الطقس";
        sel.style.cssText =
            "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:45;min-width:230px;" +
            "padding:7px 14px;font:600 15px system-ui,'Segoe UI',Tahoma,sans-serif;color:#f3efe8;" +
            "background:rgba(14,12,22,0.62);border:1px solid rgba(255,255,255,0.22);border-radius:999px;" +
            "backdrop-filter:blur(6px);outline:none;cursor:pointer;text-align:center;";
        const add = (value: string, text: string, extra?: (o: HTMLOptionElement) => void) => {
            const o = document.createElement("option");
            o.value = value;
            o.textContent = text;
            o.style.cssText = "background:#15131f;color:#f3efe8;";
            extra?.(o);
            sel.appendChild(o);
        };
        add("", "🌍 الطقس", (o) => { o.disabled = true; o.hidden = true; });
        for (const w of WEATHER_LIST) add(w.id, w.label);
        add("original", "↺ الأصلي (افتراضي)");
        sel.value = "";
        sel.addEventListener("change", () => {
            if (sel.value === "original") {
                try { localStorage.removeItem(STORE); } catch { /* ignore */ }
                const url = new URL(window.location.href);
                url.searchParams.delete("weather");
                window.location.href = url.toString();
                return;
            }
            this.set(sel.value as WeatherId);
            sel.blur(); // give the keyboard back to the car (arrows / space must not change the list)
        });
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        sel.addEventListener("keyup", (e) => e.stopPropagation());
        sel.addEventListener("focusin", () => window.dispatchEvent(new Event("blur"))); // release held keys
        document.body.appendChild(sel);
        this.select = sel;
    }

    dispose() {
        this.rain.dispose();
        this.select?.remove();
    }
}

const WHITE = new THREE.Color(1, 1, 1);

// --------------------------------------------------------------------------- audio
/** Rain patter loop (volume follows the rain amount) and synthesized thunder. */
class WeatherAudio {
    private ctx: AudioContext | null = null;
    private dest: AudioNode | null = null;
    private rainGain: GainNode | null = null;
    private noise: AudioBuffer | null = null;
    private level = -1;

    attach(ctx: AudioContext, dest: AudioNode) {
        this.ctx = ctx;
        this.dest = dest;
        const data = makePinkNoise(ctx.sampleRate, 6);
        const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
        buf.getChannelData(0).set(data);
        this.noise = buf;

        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 900;      // patter
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7000;
        const body = ctx.createBiquadFilter(); body.type = "lowpass"; body.frequency.value = 450; // soft roar
        const gHi = ctx.createGain(); gHi.gain.value = 0.55;
        const gLo = ctx.createGain(); gLo.gain.value = 0.35;
        this.rainGain = ctx.createGain();
        this.rainGain.gain.value = 0;
        src.connect(hp).connect(lp).connect(gHi).connect(this.rainGain);
        src.connect(body).connect(gLo).connect(this.rainGain);
        this.rainGain.connect(dest);
        src.start();
    }

    setRain(amount: number) {
        if (!this.ctx || !this.rainGain || this.ctx.state !== "running") return;
        if (Math.abs(amount - this.level) < 0.003) return;
        this.level = amount;
        this.rainGain.gain.setTargetAtTime(amount * 0.5, this.ctx.currentTime, 0.4);
    }

    /** A rumble that starts `delay` seconds from now (the farther the bolt, the later and softer). */
    thunder(delay: number) {
        const ctx = this.ctx;
        if (!ctx || !this.noise || !this.dest || ctx.state !== "running") return;
        const t0 = ctx.currentTime + delay;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(380, t0);
        lp.frequency.exponentialRampToValueAtTime(70, t0 + 3.5);
        const g = ctx.createGain();
        const vol = 0.9 / (1 + delay * 0.6);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(vol, t0 + 0.06);
        g.gain.setTargetAtTime(0, t0 + 0.25, 0.9);
        src.connect(lp).connect(g).connect(this.dest);
        src.start(t0, Math.random() * 2);
        src.stop(t0 + 6);
    }
}