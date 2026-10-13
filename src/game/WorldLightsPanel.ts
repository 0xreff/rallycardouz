import GUI from "lil-gui";
import * as THREE from "three";
import type { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { NightAtmosphere, Theme } from "../engine/NightAtmosphere";
import type { AtmospherePass } from "../engine/AtmospherePass";
import type { SkidMarks } from "../engine/SkidMarks";

/**
 * World lights panel (press K). Edits every light and look of the active theme live:
 * sun/moon, sky fill, sky and disc, fog, exposure, bloom, god rays, colour grade, ground
 * ripples and glints, blowing sand and the tyre-track lighting. Works in both the
 * night and the desert-day theme (open the game with ?theme=night or ?theme=day).
 *
 * The car's own lights (headlights, tail lights) stay in the L panel.
 *
 * Values are kept per theme. SAVE stores them in this browser; RESET goes back to the
 * built-in look of the theme; COPY puts the current values on the clipboard as JSON so
 * you can paste them into NightAtmosphere.ts (THEMES) as the new defaults.
 */

export interface WorldLightTargets {
    theme: Theme;
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    atmosphere: NightAtmosphere;
    bloom: UnrealBloomPass;
    atmospherePass: AtmospherePass;
    skids: SkidMarks;
    skidAmbient: number; // the value Game.ts passes to skids.setLight()
}

interface Rgb { r: number; g: number; b: number }

interface Settings {
    // key light (sun by day, moon at night)
    keyIntensity: number;
    keyColor: string;
    keyAzimuth: number;
    keyElevation: number;
    shadows: boolean;
    // sky fill
    hemiIntensity: number;
    hemiSky: string;
    hemiGround: string;
    // camera
    exposure: number;
    // sky dome
    horizon: string; // also the fog and background colour
    zenith: string;
    discTint: string;
    discGain: number;
    discSize: number;
    glow: number;
    stars: number;
    haze: number;
    // fog
    fogNear: number;
    fogFar: number;
    // bloom
    bloomStrength: number;
    bloomRadius: number;
    bloomThreshold: number;
    // god rays
    rayStrength: number;
    rayThreshold: number;
    rayWidth: number;
    rayColor: string;
    // colour grade
    saturation: number;
    vignette: number;
    shadowTint: Rgb;
    highTint: Rgb;
    lift: Rgb;
    // ground
    rippleGain: number;
    glintGain: number;
    glintColor: string;
    sandAlpha: number;
    sandColor: string;
    skidAmbient: number;
}

const hex = (c: THREE.Color) => "#" + c.getHexString();
const rgb = (c: THREE.Color): Rgb => ({ r: c.r, g: c.g, b: c.b });

export class WorldLightsPanel {
    private readonly gui: GUI;
    private readonly storageKey: string;
    private readonly defaults: Settings;
    private readonly s: Settings;
    private visible = false;
    private readonly status = { text: "" };

    constructor(private readonly t: WorldLightTargets) {
        this.storageKey = `worldLights:v1:${t.theme}`;
        this.defaults = this.readFromScene();
        this.s = JSON.parse(JSON.stringify(this.defaults)) as Settings;

        // Saved values from an earlier session replace the theme defaults.
        const saved = this.load();
        if (saved) {
            this.mergeSaved(this.s, saved);
            this.apply();
            this.applyShadows();
        }

        const gui = new GUI({ title: `World lights (K) - ${t.theme}` });
        this.gui = gui;
        const el = gui.domElement;
        el.style.cssText += ";position:fixed;left:262px;top:110px;z-index:40;max-height:calc(100vh - 130px);overflow-y:auto;";
        // Keep the keyboard inside the panel (no steering while you type) and release held keys.
        el.addEventListener("keydown", (e) => e.stopPropagation());
        el.addEventListener("keyup", (e) => e.stopPropagation());
        el.addEventListener("focusin", () => window.dispatchEvent(new Event("blur")));

        this.build();
        gui.show(false);

        window.addEventListener("keydown", (e) => {
            if (e.code !== "KeyK" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target as HTMLElement | null)?.tagName ?? "";
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            this.toggle();
        });
    }

    toggle() {
        this.visible = !this.visible;
        this.gui.show(this.visible);
    }

    dispose() {
        this.gui.destroy();
    }

    // --- UI -------------------------------------------------------------------

    private build() {
        const { gui, s } = this;
        const change = () => this.apply();

        const num = (f: GUI, key: keyof Settings, label: string, min: number, max: number, step: number) =>
            f.add(s as unknown as Record<string, number>, key as string, min, max, step).name(label).onChange(change);
        const col = (f: GUI, key: keyof Settings, label: string) =>
            f.addColor(s as unknown as Record<string, string>, key as string).name(label).onChange(change);
        const tint = (parent: GUI, key: "shadowTint" | "highTint" | "lift", label: string, max: number) => {
            const f = parent.addFolder(label);
            f.add(s[key], "r", 0, max, 0.005).name("red").onChange(change);
            f.add(s[key], "g", 0, max, 0.005).name("green").onChange(change);
            f.add(s[key], "b", 0, max, 0.005).name("blue").onChange(change);
            f.close();
        };

        const key = gui.addFolder(this.t.theme === "night" ? "Moon (key light)" : "Sun (key light)");
        num(key, "keyIntensity", "intensity", 0, 12, 0.01);
        col(key, "keyColor", "light colour");
        num(key, "keyAzimuth", "azimuth", -180, 180, 1);
        num(key, "keyElevation", "elevation", 0, 89, 1);
        key.add(s, "shadows").name("casts shadows").onChange(() => this.applyShadows());

        const fill = gui.addFolder("Sky fill (ambient)");
        num(fill, "hemiIntensity", "intensity", 0, 5, 0.01);
        col(fill, "hemiSky", "sky colour");
        col(fill, "hemiGround", "ground bounce");

        const sky = gui.addFolder("Sky and disc");
        col(sky, "horizon", "horizon / fog colour");
        col(sky, "zenith", "zenith colour");
        col(sky, "discTint", "disc + glow colour");
        num(sky, "discGain", "disc brightness", 0, 20, 0.05);
        num(sky, "discSize", "disc size", 0.005, 0.2, 0.001);
        num(sky, "glow", "glow", 0, 4, 0.01);
        num(sky, "stars", "stars", 0, 2, 0.01);
        num(sky, "haze", "dust haze", 0, 2, 0.01);
        sky.close();

        const fog = gui.addFolder("Fog and exposure");
        num(fog, "fogNear", "fog start (m)", 0, 1500, 5);
        num(fog, "fogFar", "fog end (m)", 100, 3000, 10);
        num(fog, "exposure", "exposure", 0.1, 3, 0.01);
        fog.close();

        const bloom = gui.addFolder("Bloom");
        num(bloom, "bloomStrength", "strength", 0, 3, 0.01);
        num(bloom, "bloomRadius", "radius", 0, 1.5, 0.01);
        num(bloom, "bloomThreshold", "threshold", 0, 3, 0.01);
        bloom.close();

        const rays = gui.addFolder("God rays");
        num(rays, "rayStrength", "strength", 0, 3, 0.01);
        num(rays, "rayThreshold", "brightness threshold", 0, 4, 0.01);
        num(rays, "rayWidth", "threshold softness", 0.05, 4, 0.01);
        col(rays, "rayColor", "ray colour");
        rays.close();

        const grade = gui.addFolder("Colour grade");
        num(grade, "saturation", "saturation", 0, 2, 0.01);
        num(grade, "vignette", "vignette", 0, 1, 0.01);
        tint(grade, "shadowTint", "shadow tint (x)", 2);
        tint(grade, "highTint", "highlight tint (x)", 2);
        tint(grade, "lift", "black lift (+)", 0.3);
        grade.close();

        const ground = gui.addFolder("Ground and dust");
        num(ground, "rippleGain", "sand ripples", 0, 4, 0.01);
        num(ground, "glintGain", "sand glints", 0, 3, 0.01);
        col(ground, "glintColor", "glint colour");
        num(ground, "sandAlpha", "blowing sand opacity", 0, 1, 0.01);
        col(ground, "sandColor", "blowing sand colour");
        num(ground, "skidAmbient", "tyre-track fill light", 0, 1.5, 0.01);
        ground.close();

        const actions = gui.addFolder("Save / reset");
        actions.add({ run: () => this.save() }, "run").name("Save in this browser");
        actions.add({ run: () => this.reset() }, "run").name("Reset to theme defaults");
        actions.add({ run: () => this.copy() }, "run").name("Copy values (JSON)");
        actions.add(this.status, "text").name("status").disable();
        actions.add({ run: () => this.openTheme("night") }, "run").name("Open night theme");
        actions.add({ run: () => this.openTheme("day") }, "run").name("Open day theme");
    }

    // --- scene <-> settings ---------------------------------------------------

    private readFromScene(): Settings {
        const { atmosphere: a, renderer, bloom, atmospherePass: p, scene } = this.t;
        const u = a.skyUniforms;
        const pu = p.uniforms;
        const angles = a.getKeyAngles();
        const fog = scene.fog as THREE.Fog | null;
        return {
            keyIntensity: a.moonLight.intensity,
            keyColor: hex(a.moonLight.color),
            keyAzimuth: angles.azimuth,
            keyElevation: angles.elevation,
            shadows: a.moonLight.castShadow,
            hemiIntensity: a.hemi.intensity,
            hemiSky: hex(a.hemi.color),
            hemiGround: hex(a.hemi.groundColor),
            exposure: renderer.toneMappingExposure,
            horizon: hex(u.uHorizon.value as THREE.Color),
            zenith: hex(u.uZenith.value as THREE.Color),
            discTint: hex(u.uMoonTint.value as THREE.Color),
            discGain: u.uDiscGain.value as number,
            discSize: u.uDiscSize.value as number,
            glow: u.uGlow.value as number,
            stars: u.uStars.value as number,
            haze: u.uHaze.value as number,
            fogNear: fog?.near ?? 100,
            fogFar: fog?.far ?? 1000,
            bloomStrength: bloom.strength,
            bloomRadius: bloom.radius,
            bloomThreshold: bloom.threshold,
            rayStrength: pu.uRayStrength.value as number,
            rayThreshold: pu.uRayThreshold.value as number,
            rayWidth: pu.uRayWidth.value as number,
            rayColor: hex(pu.uRayColor.value as THREE.Color),
            saturation: pu.uSaturation.value as number,
            vignette: pu.uVignette.value as number,
            shadowTint: rgb(pu.uShadowTint.value as THREE.Color),
            highTint: rgb(pu.uHighTint.value as THREE.Color),
            lift: rgb(pu.uLift.value as THREE.Color),
            rippleGain: a.groundUniforms.rippleGain.value,
            glintGain: a.groundUniforms.glintGain.value,
            glintColor: hex(a.groundUniforms.glintColor.value),
            sandAlpha: a.sandUniforms.uAlpha.value as number,
            sandColor: hex(a.sandUniforms.uColor.value as THREE.Color),
            skidAmbient: this.t.skidAmbient,
        };
    }

    /** Push the current settings into the scene. Cheap, so it runs on every change. */
    private apply() {
        const { atmosphere: a, renderer, bloom, atmospherePass: p, scene, skids } = this.t;
        const s = this.s;
        const u = a.skyUniforms;
        const pu = p.uniforms;

        a.moonLight.intensity = s.keyIntensity;
        a.moonLight.color.set(s.keyColor);
        a.setKeyDirection(s.keyAzimuth, s.keyElevation);

        a.hemi.intensity = s.hemiIntensity;
        a.hemi.color.set(s.hemiSky);
        a.hemi.groundColor.set(s.hemiGround);

        renderer.toneMappingExposure = s.exposure;

        (u.uHorizon.value as THREE.Color).set(s.horizon);
        (u.uZenith.value as THREE.Color).set(s.zenith);
        (u.uMoonTint.value as THREE.Color).set(s.discTint);
        u.uDiscGain.value = s.discGain;
        u.uDiscSize.value = s.discSize;
        u.uGlow.value = s.glow;
        u.uStars.value = s.stars;
        u.uHaze.value = s.haze;

        const fog = scene.fog as THREE.Fog | null;
        if (fog) {
            fog.near = s.fogNear;
            fog.far = Math.max(s.fogFar, s.fogNear + 1);
            fog.color.set(s.horizon);
        }
        if (scene.background instanceof THREE.Color) scene.background.set(s.horizon);

        bloom.strength = s.bloomStrength;
        bloom.radius = s.bloomRadius;
        bloom.threshold = s.bloomThreshold;

        pu.uRayStrength.value = s.rayStrength;
        pu.uRayThreshold.value = s.rayThreshold;
        pu.uRayWidth.value = s.rayWidth;
        (pu.uRayColor.value as THREE.Color).set(s.rayColor);
        pu.uSaturation.value = s.saturation;
        pu.uVignette.value = s.vignette;
        (pu.uShadowTint.value as THREE.Color).setRGB(s.shadowTint.r, s.shadowTint.g, s.shadowTint.b);
        (pu.uHighTint.value as THREE.Color).setRGB(s.highTint.r, s.highTint.g, s.highTint.b);
        (pu.uLift.value as THREE.Color).setRGB(s.lift.r, s.lift.g, s.lift.b);

        a.groundUniforms.rippleGain.value = s.rippleGain;
        a.groundUniforms.glintGain.value = s.glintGain;
        a.groundUniforms.glintColor.value.set(s.glintColor);
        a.sandUniforms.uAlpha.value = s.sandAlpha;
        (a.sandUniforms.uColor.value as THREE.Color).set(s.sandColor);

        // Tyre tracks copy the key light's colour, so refresh them whenever it changes.
        skids.setLight(a.moonDir, a.moonLight.color, s.skidAmbient);
    }

    private applyShadows() {
        this.t.atmosphere.moonLight.castShadow = this.s.shadows;
    }

    // --- save / reset / copy ----------------------------------------------------

    private load(): unknown {
        try {
            const raw = localStorage.getItem(this.storageKey);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    /** Copy known keys of the same type from `src` into `dst`; ignore anything else. */
    private mergeSaved(dst: Settings, src: unknown) {
        if (!src || typeof src !== "object") return;
        const from = src as Record<string, unknown>;
        const to = dst as unknown as Record<string, unknown>;
        for (const k of Object.keys(to)) {
            const v = from[k];
            const cur = to[k];
            if (typeof cur === "number" && typeof v === "number" && Number.isFinite(v)) to[k] = v;
            else if (typeof cur === "string" && typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) to[k] = v;
            else if (typeof cur === "boolean" && typeof v === "boolean") to[k] = v;
            else if (cur && typeof cur === "object" && v && typeof v === "object") {
                const c = cur as Record<string, number>;
                const o = v as Record<string, unknown>;
                for (const ch of ["r", "g", "b"]) if (typeof o[ch] === "number" && Number.isFinite(o[ch] as number)) c[ch] = o[ch] as number;
            }
        }
    }

    private setStatus(text: string) {
        this.status.text = text;
        this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }

    private save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.s));
            this.setStatus("saved");
        } catch {
            this.setStatus("could not save");
        }
    }

    private reset() {
        try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
        this.mergeSaved(this.s, this.defaults); // copies in place, so the sliders stay bound
        this.apply();
        this.applyShadows();
        this.setStatus("defaults restored");
    }

    private copy() {
        const text = JSON.stringify({ theme: this.t.theme, ...this.s }, null, 2);
        console.log("[WorldLightsPanel] values\n" + text);
        navigator.clipboard?.writeText(text).then(
            () => this.setStatus("copied"),
            () => this.setStatus("see console")
        );
    }

    private openTheme(name: "night" | "day") {
        const url = new URL(window.location.href);
        url.searchParams.set("theme", name);
        window.location.href = url.toString();
    }
}