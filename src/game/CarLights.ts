import * as THREE from "three";
import type { CarSpec } from "./CarSpec";

/**
 * Night driving lights for a car, attached to its chassis group so they follow
 * the body (including the cosmetic lean).
 *
 *  - HEADLIGHTS: two separate lamps (round or box shaped, position and size are live settings),
 *    each with a lens, a hot core, a light-shaft cone (dust drifting through it) and
 *    (player only) its own SpotLight.
 *  - TAIL LIGHTS: deep red LED lamps (lens + LED bar + soft halo sprite), HDR so the
 *    bloom pass makes them glow, flaring when braking. Their position is a live setting
 *    (tailX / tailY / tailZ), so they can be slid onto the real rear of any model.
 *    Two short-reach red lights hang off the lamps: one washes the car's own rear panel
 *    (bumper / tailgate), one washes the ground right behind it. Both fade out within
 *    a few metres.
 *  - Real lights cost every material in the scene, so they are player-only
 *    (withRealLights); the bot gets all the glow, halos and shafts but no real light.
 *
 * Every look value lives in LightSettings. The in-game panel (LightsPanel.ts) edits
 * them; setLightSettings() applies them to every car on screen and, with persist=true,
 * saves them so they come back next time the game loads.
 *
 * +Z is the car's forward axis (same as the physics controller).
 * The headX/Y/Z and tailX/Y/Z settings place the lamps on a particular model's grille and rear:
 * values are fractions of the spec's half extents, measured from the chassis centre.
 */

// ------------------------------------------------------------------ settings
export interface LightSettings {
    // headlights
    headOn: boolean;
    headColor: string;      // "#rrggbb": road light + light shafts
    spotIntensity: number;  // road light brightness (per lamp)
    spotAngle: number;      // rad, road light half-angle (per lamp)
    spotPenumbra: number;   // 0..1 edge softness
    spotSpread: number;     // m the two pools are pushed apart at 28 m
    spotWidthComp: number;  // 0..1: widening the road light spreads the SAME light (0 = brightness ignores width)
    spotDecay: number;      // road light falloff with distance: 1 = default, lower = flatter pool (less hot near the car)
    beamStrength: number;   // light-shaft opacity
    beamWidth: number;      // m, shaft radius at its far end
    beamLength: number;     // m
    beamWidthComp: number;  // 0..2: 1 = the shaft keeps its overall brightness when widened (0 = old behaviour)
    beamNearFade: number;   // m: the shaft fades in over this distance from the lamp (hides the hot start)
    headRound: boolean;     // true = round lamp, false = the old box-shaped lamp
    headSize: number;       // m, lamp diameter (round) / width (box)
    headX: number;          // lamp position: fraction of the half width (0 = centre, 1 = outer edge)
    headY: number;          // lamp position: fraction of the half height above the centre (negative = below)
    headZ: number;          // lamp position: fraction of the half length in front of the centre (1 = front end)
    headCore: number;       // lamp core brightness (HDR multiplier)
    headTilt: number;       // rad, vertical tilt (0 = level horizontal, >0 = down towards road)
    headYaw: number;        // rad, horizontal outward beam yaw/spread
    // tail lights
    tailOn: boolean;
    tailColor: string;      // "#rrggbb"
    tailX: number;          // lamp position: fraction of the half width (0 = centre, 1 = outer edge)
    tailY: number;          // lamp position: fraction of the half height above the centre (1 = top of the body)
    tailZ: number;          // lamp position: fraction of the half length behind the centre (negative; -1 = rear end of the body)
    tailGlowIdle: number;   // lens HDR multiplier, lights on
    tailGlowBrake: number;  // lens HDR multiplier, braking
    ledBar: number;         // LED bar brightness (1 = default)
    haloSizeIdle: number;   // m
    haloSizeBrake: number;  // m
    haloStrength: number;   // halo brightness (1 = default)
    groundRedIdle: number;  // red ground light intensity, lights on
    groundRedBrake: number; // red ground light intensity, braking
    tailReach: number;      // m: the red ground light is completely gone beyond this distance
    tailAim: number;        // m behind the car where the red light is aimed on the ground
    tailAngle: number;      // rad, red light half-angle
    tailOffset: number;     // m the red ground light sits behind the lamps (keeps it off the body)
    tailBodyIdle: number;   // red wash on the car's own rear panel, lights on
    tailBodyBrake: number;  // red wash on the car's own rear panel, braking
    tailBodyReach: number;  // m: that wash is completely gone beyond this distance
}

export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
    headOn: true,
    headColor: "#dfe6ff",
    spotIntensity: 380,
    spotAngle: 0.42,
    spotPenumbra: 0.85,
    spotSpread: 2.0,
    spotWidthComp: 0.5,
    spotDecay: 1.0,
    beamStrength: 0.24,
    beamWidth: 0.95,
    beamLength: 16,
    beamWidthComp: 1.0,
    beamNearFade: 1.5,
    headRound: true,
    headSize: 0.22,
    headX: 10,
    headY: 10,
    headZ: 10,
    headCore: 4.0,
    headTilt: 0.07,
    headYaw: 0.04,
    tailOn: true,
    tailColor: "#" + new THREE.Color(1.0, 0.012, 0.03).getHexString(), // deep ruby
    tailX: 0.55,
    tailY: 0.50,
    tailZ: -0.315,
    tailGlowIdle: 2.8,
    tailGlowBrake: 7,
    ledBar: 1.0,
    haloSizeIdle: 0.3,
    haloSizeBrake: 0.6,
    haloStrength: 1.0,
    groundRedIdle: 1.5,
    groundRedBrake: 8,
    tailReach: 6,
    tailAim: 1.8,
    tailAngle: 0.8,
    tailOffset: 0.25,
    tailBodyIdle: 0.6,
    tailBodyBrake: 3,
    tailBodyReach: 1.8,
};

const STORAGE_KEY = "rallydouz.lights.v1";

function sanitize(src: Partial<LightSettings>): LightSettings {
    const out = { ...DEFAULT_LIGHT_SETTINGS } as Record<string, unknown>;
    const def = DEFAULT_LIGHT_SETTINGS as unknown as Record<string, unknown>;
    const inp = src as Record<string, unknown>;
    for (const k of Object.keys(def)) {
        const v = inp[k];
        if (typeof v !== typeof def[k]) continue;
        if (typeof v === "number" && !Number.isFinite(v)) continue;
        if (typeof v === "string" && !/^#[0-9a-fA-F]{6}$/.test(v)) continue;
        out[k] = v;
    }
    return out as unknown as LightSettings;
}

function loadSaved(): LightSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return sanitize(JSON.parse(raw) as Partial<LightSettings>);
    } catch { /* no storage / bad json: use the defaults */ }
    return { ...DEFAULT_LIGHT_SETTINGS };
}

let current: LightSettings = loadSaved();
let previewBrake = false;
const instances = new Set<CarLights>();

/** A copy of the settings currently applied to the cars. */
export function getLightSettings(): LightSettings {
    return { ...current };
}

/** Apply settings to every car on screen. persist = also save them for the next visit. */
export function setLightSettings(next: Partial<LightSettings>, persist = false): void {
    current = sanitize({ ...current, ...next });
    if (persist) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* storage full / blocked */ }
    }
    for (const l of instances) {
        if (!l.isAlive()) { instances.delete(l); continue; } // car was removed from the scene
        l.refresh();
    }
}

/** Force the tail lights into their braking look (for tuning them without driving). */
export function setBrakePreview(on: boolean): void {
    previewBrake = on;
}

// ---------------------------------------------------------- pure brightness maths
/** Distance (m) at which the road light's brightness is kept constant when spotDecay changes. */
const SPOT_REF_DIST = 25;

/**
 * Multiplier on the road light's intensity so that
 *  - widening the cone spreads the same light over a bigger area (solid angle ~ 1 - cos(angle)),
 *    scaled by spotWidthComp (0 = ignore width, 1 = fully energy-conserving);
 *  - changing spotDecay keeps the pool at SPOT_REF_DIST metres equally bright, so lowering the
 *    decay only flattens the pool (dimmer right in front of the car, same further out).
 * At the default angle and decay 1 the result is exactly 1, so the default look is unchanged.
 */
export function roadLightFactor(angle: number, widthComp: number, decay: number): number {
    const baseCone = 1 - Math.cos(DEFAULT_LIGHT_SETTINGS.spotAngle);
    const cone = 1 - Math.cos(Math.max(0.05, angle));
    return Math.pow(baseCone / cone, widthComp) * Math.pow(SPOT_REF_DIST, decay - 1);
}

/**
 * Multiplier on the light shaft's opacity when it is widened or narrowed.
 * The same lamp light spread over a wider cone must look dimmer, not brighter.
 * 1.5 is the exponent that works for a chase camera (the cone's own edge shading gets
 * brighter with width, so it needs more than a plain 1/width). Clamped so a very narrow
 * shaft cannot blow out. widthRatio = beamWidth / default width.
 */
export function beamWidthFactor(widthRatio: number, comp: number): number {
    const f = Math.pow(1 / Math.max(widthRatio, 0.01), 1.5 * comp);
    return Math.min(3, Math.max(0.12, f));
}

// ------------------------------------------------------------------- constants
const HEAD_LENS_COLOR = new THREE.Color(1.0, 0.96, 0.85).multiplyScalar(0.9);
const HEAD_CORE_BASE = new THREE.Color(1.0, 0.97, 0.88);

const BEAM_BASE_LENGTH = 16;
const BEAM_BASE_RADIUS = 0.95;
/** Shared clock for the beam dust animation (all beams of all cars). */
const beamTime = { value: 0 };

const SPOT_DISTANCE = 350;
/** Lamp sizes the geometries are built at; the meshes are scaled from these. */
const HEAD_BASE_SIZE = 0.22;   // round lamp diameter
const HEAD_BOX_WIDTH = 0.24;   // the old box lamp width
/** The panel-wash light sits this far (m) behind the tail lamps, shining forward onto the rear panel. */
const BODY_LIGHT_BACK = 0.45;

const WHITE = new THREE.Color(1, 1, 1);
const CORE_IDLE = 3.5, CORE_BRAKE = 9;             // LED bar HDR multipliers
const HALO_IDLE = 1.0, HALO_BRAKE = 2.0;           // halo colour multipliers
const HALO_OPACITY_IDLE = 0.25, HALO_OPACITY_BRAKE = 0.7;
const BRAKE_ATTACK = 50;   // 1/s, how fast the lamps flare up
const BRAKE_RELEASE = 20;   // 1/s, how fast they settle back

export class CarLights {
    private readonly root: THREE.Object3D;
    private readonly halfLen: number;
    private readonly halfH: number;
    private readonly halfW: number;
    private readonly headMeshes: THREE.Mesh[] = [];   // [lens, core] per side, side -1 first
    private readonly headGeos: { lens: THREE.BufferGeometry; core: THREE.BufferGeometry; boxLens: THREE.BufferGeometry; boxCore: THREE.BufferGeometry };
    private readonly beams: THREE.Mesh[] = [];
    private readonly beamSide: number[] = [];
    private readonly beamMats: THREE.ShaderMaterial[] = [];
    private readonly spots: THREE.SpotLight[] = [];
    private readonly spotBaseX: number[] = [];
    private readonly spotBaseY: number[] = [];
    private readonly spotBaseZ: number[] = [];
    private readonly spotSide: number[] = [];
    private readonly tailMeshes: THREE.Mesh[] = [];
    private readonly haloSprites: THREE.Sprite[] = [];
    private readonly headCoreMat: THREE.MeshBasicMaterial;
    private readonly tailLensMat: THREE.MeshBasicMaterial;
    private readonly tailCoreMat: THREE.MeshBasicMaterial;
    private readonly haloMat: THREE.SpriteMaterial;
    private readonly tailLight: THREE.SpotLight | null = null;   // red wash on the ground behind the car
    private readonly bodyLight: THREE.SpotLight | null = null;   // red wash on the car's own rear panel
    private readonly tailRed = new THREE.Color();
    private readonly tailHot = new THREE.Color();
    private level = 0;       // eased 0..1 brake level actually shown
    private target = 0;      // 0 or 1 from the pedal
    private lastT = 0;
    private shown = -1;      // level last written to the materials

    constructor(parent: THREE.Object3D, spec: CarSpec, withRealLights: boolean) {
        this.root = parent;
        const hx = spec.halfWidth;
        const hy = spec.halfHeight;
        const hz = spec.halfLength;
        this.halfLen = hz;
        this.halfH = hy;
        this.halfW = hx;

        const r = HEAD_BASE_SIZE / 2;
        this.headGeos = {
            lens: new THREE.CylinderGeometry(r, r, 0.05, 32).rotateX(Math.PI / 2),            // round lens
            core: new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.06, 32).rotateX(Math.PI / 2), // round hot core
            boxLens: new THREE.BoxGeometry(0.24, 0.12, 0.05),                                 // old box lamp
            boxCore: new THREE.BoxGeometry(0.10, 0.06, 0.06),
        };
        const headLensGeo = current.headRound ? this.headGeos.lens : this.headGeos.boxLens;
        const tailLensGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.05, 24).rotateX(Math.PI / 2);
        const headCoreGeo = current.headRound ? this.headGeos.core : this.headGeos.boxCore;
        const tailCoreGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.06, 24).rotateX(Math.PI / 2);
        const headMat = new THREE.MeshBasicMaterial({ color: HEAD_LENS_COLOR });
        this.headCoreMat = new THREE.MeshBasicMaterial({ color: HEAD_CORE_BASE.clone() });
        this.tailLensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color() });
        this.tailCoreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color() });
        this.haloMat = new THREE.SpriteMaterial({
            map: createGlowTexture(),
            color: new THREE.Color(),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });

        for (const side of [-1, 1]) {
            // --- headlight: lens + hot core, two separate lamps
            const hxp = side * hx * current.headX, hyp = hy * current.headY, hzp = hz * current.headZ;
            const head = new THREE.Mesh(headLensGeo, headMat);
            head.position.set(hxp, hyp, hzp);
            parent.add(head);
            const headCore = new THREE.Mesh(headCoreGeo, this.headCoreMat);
            headCore.position.set(hxp, hyp, hzp + 0.03);
            parent.add(headCore);
            this.headMeshes.push(head, headCore);

            const beamMat = createBeamMaterial();
            const beam = new THREE.Mesh(createBeamGeometry(), beamMat);
            beam.position.set(hxp, hyp, hzp + 0.05);
            beam.rotation.x = current.headTilt;             // tilt down or horizontal
            beam.rotation.y = side * current.headYaw;       // and slightly outward
            beam.renderOrder = 2;
            parent.add(beam);
            this.beams.push(beam);
            this.beamSide.push(side);
            this.beamMats.push(beamMat);

            // --- tail light: ruby lens + LED core bar + halo
            const txp = side * hx * current.tailX, typ = hy * current.tailY, tzp = hz * current.tailZ;
            const tail = new THREE.Mesh(tailLensGeo, this.tailLensMat);
            tail.position.set(txp, typ, tzp);
            parent.add(tail);
            const core = new THREE.Mesh(tailCoreGeo, this.tailCoreMat);
            core.position.set(txp, typ, tzp - 0.03);
            parent.add(core);
            this.tailMeshes.push(tail, core);
            const halo = new THREE.Sprite(this.haloMat);
            halo.position.set(txp, typ, tzp - 0.08);
            halo.renderOrder = 3;
            parent.add(halo);
            this.haloSprites.push(halo);

            // --- real headlight, one per lamp (player only)
            if (withRealLights) {
                const spotY = hyp + 0.15;
                const spotZ = hzp - 0.6;
                const spot = new THREE.SpotLight(0xffffff, 0, SPOT_DISTANCE, 0.4, 0.8, 1.0);
                spot.position.set(hxp, spotY, spotZ);
                spot.castShadow = false;
                const forwardDist = 28 - spotZ;
                spot.target.position.set(
                    hxp + side * (current.spotSpread + Math.tan(current.headYaw) * forwardDist),
                    spotY - Math.tan(current.headTilt) * forwardDist,
                    28
                );
                parent.add(spot);
                parent.add(spot.target);
                this.spots.push(spot);
                this.spotBaseX.push(hxp);
                this.spotBaseY.push(spotY);
                this.spotBaseZ.push(spotZ);
                this.spotSide.push(side);
            }
        }

        // Red lights that hang off the tail lamps (player only; refresh() places them).
        //  - ground wash: a SpotLight a little BEHIND the lamps pointing back-and-down at the road.
        //    Physical falloff (decay 2) plus a short cut-off distance keep it hugging the bumper.
        //  - panel wash: a SpotLight further behind the lamps pointing FORWARD at the rear panel,
        //    so the tailgate / bumper next to the lamps picks up red. Very short reach.
        if (withRealLights) {
            const rear = new THREE.SpotLight(0xff1428, 0, current.tailReach, current.tailAngle, 1.0, 2);
            rear.castShadow = false;
            parent.add(rear);
            parent.add(rear.target);
            this.tailLight = rear;

            const body = new THREE.SpotLight(0xff1428, 0, current.tailBodyReach, 1.25, 1.0, 2);
            body.castShadow = false;
            parent.add(body);
            parent.add(body.target);
            this.bodyLight = body;
        }

        instances.add(this);
        this.refresh();
    }

    /** False once the car has been removed from the scene (car swap / dispose). */
    isAlive(): boolean {
        return this.root.parent !== null;
    }

    /** Re-read the current LightSettings and push them into every mesh, material and light. */
    refresh(): void {
        const S = current;

        // headlight lamps: shape, size and position (live-tunable)
        const hLx = this.halfW * S.headX, hLy = this.halfH * S.headY, hLz = this.halfLen * S.headZ;
        const round = S.headRound;
        const sc = round ? S.headSize / HEAD_BASE_SIZE : S.headSize / HEAD_BOX_WIDTH;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            const lens = this.headMeshes[i * 2], core = this.headMeshes[i * 2 + 1];
            lens.geometry = round ? this.headGeos.lens : this.headGeos.boxLens;
            core.geometry = round ? this.headGeos.core : this.headGeos.boxCore;
            lens.scale.set(sc, sc, 1);
            core.scale.set(sc, sc, 1);
            lens.position.set(side * hLx, hLy, hLz);
            core.position.set(side * hLx, hLy, hLz + 0.03);
            this.beams[i].position.set(side * hLx, hLy, hLz + 0.05);
            if (this.spots[i]) {
                this.spotBaseX[i] = side * hLx;
                this.spotBaseY[i] = hLy + 0.15;
                this.spotBaseZ[i] = hLz - 0.6;
                this.spots[i].position.set(this.spotBaseX[i], this.spotBaseY[i], this.spotBaseZ[i]);
            }
        }
        for (const m of this.headMeshes) m.visible = S.headOn;
        this.headCoreMat.color.copy(HEAD_CORE_BASE).multiplyScalar(S.headCore);
        const spotK = roadLightFactor(S.spotAngle, S.spotWidthComp, S.spotDecay);
        for (let i = 0; i < this.spots.length; i++) {
            const spot = this.spots[i];
            spot.color.set(S.headColor);
            spot.intensity = S.headOn ? S.spotIntensity * spotK : 0;
            spot.decay = S.spotDecay;
            spot.angle = S.spotAngle;
            spot.penumbra = S.spotPenumbra;
            const forwardDist = 28 - this.spotBaseZ[i];
            spot.target.position.x = this.spotBaseX[i] + this.spotSide[i] * (S.spotSpread + Math.tan(S.headYaw) * forwardDist);
            spot.target.position.y = this.spotBaseY[i] - Math.tan(S.headTilt) * forwardDist;
            spot.target.position.z = 28;
        }
        const w = S.beamWidth / BEAM_BASE_RADIUS;
        const len = S.beamLength / BEAM_BASE_LENGTH;
        const beamK = beamWidthFactor(w, S.beamWidthComp);
        for (let i = 0; i < this.beams.length; i++) {
            this.beams[i].visible = S.headOn;
            this.beams[i].scale.set(w, w, len);
            this.beams[i].rotation.x = S.headTilt;
            this.beams[i].rotation.y = this.beamSide[i] * S.headYaw;
            const u = this.beamMats[i].uniforms;
            u.uIntensity.value = S.beamStrength * beamK;
            u.uNear.value = S.beamNearFade;
            u.uLenScale.value = len;
            u.uWidthScale.value = w;
            (u.uColor.value as THREE.Color).set(S.headColor);
        }

        // tail lights
        this.tailRed.set(S.tailColor);
        this.tailHot.copy(this.tailRed).lerp(WHITE, 0.07); // LED bar: a touch hotter than the lens
        for (const m of this.tailMeshes) m.visible = S.tailOn;
        for (const s of this.haloSprites) s.visible = S.tailOn;
        // lamp positions (live-tunable) and the lights that hang off them
        const lx = this.halfW * S.tailX, ly = this.halfH * S.tailY, lz = this.halfLen * S.tailZ;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            this.tailMeshes[i * 2].position.set(side * lx, ly, lz);          // lens
            this.tailMeshes[i * 2 + 1].position.set(side * lx, ly, lz - 0.03); // LED bar
            this.haloSprites[i].position.set(side * lx, ly, lz - 0.08);
        }
        if (this.tailLight) {
            const L = this.tailLight;
            L.distance = S.tailReach;
            L.angle = S.tailAngle;
            L.position.set(0, ly, lz - S.tailOffset);
            L.target.position.set(0, -this.halfH, lz - S.tailAim);
        }
        if (this.bodyLight) {
            const B = this.bodyLight;
            B.distance = S.tailBodyReach;
            B.position.set(0, ly + 0.1, lz - BODY_LIGHT_BACK);
            B.target.position.set(0, ly - 0.05, lz + 0.3);
            // removed from the scene's light count when switched off (one less light per pixel)
            B.visible = S.tailOn && (S.tailBodyIdle > 0 || S.tailBodyBrake > 0);
        }
        this.shown = -1;
        this.apply(this.level);
    }

    /** 0..1 brake pressure → tail lights flare up (eased in and out). */
    setBrake(pressure: number) {
        beamTime.value = (performance.now() * 0.001) % 1000; // runs every frame: also drives the beam dust
        this.target = (pressure > 0.15 || previewBrake) ? 1 : 0;
        const now = performance.now() * 0.001;
        const dt = this.lastT === 0 ? 0.016 : Math.min(0.1, now - this.lastT);
        this.lastT = now;
        const rate = this.target > this.level ? BRAKE_ATTACK : BRAKE_RELEASE;
        this.level += (this.target - this.level) * Math.min(1, rate * dt);
        if (Math.abs(this.level - this.target) < 0.005) this.level = this.target;
        if (Math.abs(this.level - this.shown) < 0.004) return; // only touch materials on change
        this.apply(this.level);
    }

    private apply(l: number) {
        const S = current;
        this.shown = l;
        const mix = (a: number, b: number) => a + (b - a) * l;
        this.tailLensMat.color.copy(this.tailRed).multiplyScalar(mix(S.tailGlowIdle, S.tailGlowBrake));
        this.tailCoreMat.color.copy(this.tailHot).multiplyScalar(mix(CORE_IDLE, CORE_BRAKE) * S.ledBar);
        this.haloMat.color.copy(this.tailRed).multiplyScalar(mix(HALO_IDLE, HALO_BRAKE) * S.haloStrength);
        this.haloMat.opacity = mix(HALO_OPACITY_IDLE, HALO_OPACITY_BRAKE);
        const size = mix(S.haloSizeIdle, S.haloSizeBrake);
        for (const s of this.haloSprites) s.scale.set(size, size, 1);
        if (this.tailLight) {
            this.tailLight.color.copy(this.tailRed);
            this.tailLight.intensity = S.tailOn ? mix(S.groundRedIdle, S.groundRedBrake) : 0;
        }
        if (this.bodyLight) {
            this.bodyLight.color.copy(this.tailRed);
            this.bodyLight.intensity = S.tailOn ? mix(S.tailBodyIdle, S.tailBodyBrake) : 0;
        }
    }
}

/** Soft round glow: white centre fading smoothly to transparent. */
function createGlowTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function createBeamGeometry(): THREE.BufferGeometry {
    // Open cone, apex at the origin, widening along +Z.
    const geo = new THREE.ConeGeometry(BEAM_BASE_RADIUS, BEAM_BASE_LENGTH, 20, 1, true);
    geo.translate(0, -BEAM_BASE_LENGTH / 2, 0); // apex at origin, base at y = -LENGTH
    geo.rotateX(-Math.PI / 2);                  // y → +z
    return geo;
}

function createBeamMaterial(): THREE.ShaderMaterial {
    // Fake volumetric light shaft: soft cone + dust drifting through it + faint
    // streaks around the axis (the "god ray" look). No depth pass needed.
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uColor: { value: new THREE.Color(0.75, 0.82, 1.0) },
            uIntensity: { value: 0.24 },
            uLength: { value: BEAM_BASE_LENGTH },
            uNear: { value: 1.5 },        // m: fade-in distance from the lamp
            uLenScale: { value: 1 },      // mesh z scale (metres per geometry unit along the beam)
            uWidthScale: { value: 1 },    // mesh x/y scale
            uTime: beamTime,
        },
        vertexShader: /* glsl */ `
      uniform float uLength;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      varying float vAng;
      void main() {
        vAlong = clamp(position.z / uLength, 0.0, 1.0);
        vLocal = position;
        vAng = atan(position.y, position.x);
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
        fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      uniform float uNear;
      uniform float uLenScale;
      uniform float uWidthScale;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      varying float vAng;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
          f.z);
      }

      void main() {
        // distance from the lamp in metres (the mesh is scaled, the geometry is not)
        float dist = vLocal.z * uLenScale;

        // brightest near the lamp, fading to nothing at the far end; soft edges
        float along = pow(1.0 - vAlong, 1.5);
        float edge = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.3);

        // The cone's apex is a point: every face of the cone piles up there and, with additive
        // blending, makes a hot start. Fade the shaft in over the first uNear metres instead.
        float nearFade = smoothstep(0.0, max(uNear, 0.001), dist);

        // dust drifting back along the beam as the car drives forward (world-sized specks,
        // so widening or lengthening the shaft does not stretch them)
        float dust = vnoise(vec3(vLocal.xy * uWidthScale * 1.6, dist * 0.28 - uTime * 3.0));
        dust = 0.45 + 1.1 * dust;

        // faint shafts around the axis, slowly shimmering
        float streak = 0.72 + 0.28 * sin(vAng * 9.0 + uTime * 0.35 + vnoise(vec3(vAng * 2.0, vLocal.z * 0.1, uTime * 0.2)) * 3.0);

        float a = along * edge * dust * streak * nearFade * uIntensity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    });
}