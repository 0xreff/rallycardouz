import * as THREE from "three";
import type { CarSpec } from "./CarSpec";

/**
 * Night driving lights, one design ("rig") per car, attached to the chassis group.
 *
 *  toyota  : head = 2 RECTANGLE lamps + 2 ROUND lamps above them, 2 amber lamps; tail = red lamps.
 *  toyota6 : head = 2 lamps + ONE roof LED BAR, 2 vertical AMBER lamps that light the ground and
 *            the car; tail = 2 rows of red rectangles + 1 middle red bar + 2 amber lamps.
 *  default : the original head pair + red tail pair.
 *
 * EVERY lamp of the tail style (red and amber) is built the same way: lens + LED core + soft halo
 * (HDR, so bloom makes it glow). All values live in LightSettings, one set per rig; the in-game
 * panel (LightsPanel.ts, key L) edits them and Save keeps them in the browser.
 *
 * Glare control: a car close to the camera dims its lamps / halos (the bot's lights no longer
 * blind you), light shafts fade out near the camera, and the washes have a soft near field.
 *
 * +Z is the car's forward axis. Positions are fractions of the spec's half extents measured from
 * the chassis centre (x: half width, y: half height, z: half length).
 */

// ------------------------------------------------------------------ rigs
export type RigId = "toyota" | "toyota6" | "default";
export const RIGS: { id: RigId; label: string }[] = [
    { id: "toyota", label: "Toyota" },
    { id: "toyota6", label: "Toyota6" },
    { id: "default", label: "Other cars" },
];
export function rigOf(name: string): RigId {
    const n = name.toLowerCase();
    return n.includes("toyota6") ? "toyota6" : n.includes("toyota") ? "toyota" : "default";
}

// ------------------------------------------------------------------ settings
export interface LightSettings {
    // headlights (main pair)
    headOn: boolean; headColor: string;
    headRound: boolean;     // true = round lamp, false = rectangle lamp
    headSize: number;       // m, lamp diameter (round) / width (rectangle)
    headX: number; headY: number; headZ: number;
    headCore: number;       // lamp core brightness (HDR multiplier)
    headTilt: number; headYaw: number;
    spotIntensity: number; spotAngle: number; spotPenumbra: number; spotSpread: number;
    spotWidthComp: number;  // 0..1: widening the road light spreads the SAME light
    spotDecay: number;      // 1 = old falloff, lower = flatter pool (less hot right in front of the car)
    beamStrength: number; beamWidth: number; beamLength: number;
    beamWidthComp: number;  // 0..2: 1 = the shaft keeps its brightness when widened
    beamNearFade: number;   // m: shaft fades in over this distance from the lamp
    beamCamFade: number;    // m: shaft fades out when closer to the camera than this
    // upper round lamps (toyota)
    topOn: boolean; topSize: number; topX: number; topY: number; topZ: number;
    // roof LED bar (toyota6)
    barOn: boolean; barW: number; barH: number; barY: number; barZ: number;
    barGlow: number;        // bar brightness (HDR)
    barHalo: number;        // soft glow around the bar
    barBeam: number;        // fan-shaped light shaft strength
    barBeamLen: number;     // m
    barLight: number;       // real light on the road (0 = off, saves GPU)
    // amber lamps, front
    amberOn: boolean; amberColor: string; amberRect: boolean;   // rect = vertical rectangle, else round
    amberX: number; amberY: number; amberZ: number; amberW: number; amberH: number;
    amberGlow: number;      // lens brightness (HDR)
    amberWash: number;      // amber light on the ground and the car (0 = off)
    amberReach: number;     // m
    // amber lamps, rear
    amberTailOn: boolean; amberTailX: number; amberTailY: number; amberTailZ: number;
    amberTailW: number; amberTailH: number;
    // tail lights (red)
    tailOn: boolean; tailColor: string;
    tailRect: boolean;      // true = rectangle lamps, false = round lamps
    tailW: number; tailH: number;                   // m, lamp size
    tailX: number; tailY: number; tailZ: number;
    tail2On: boolean; tail2Y: number;               // second row of lamps
    tailMidOn: boolean; tailMidY: number; tailMidW: number; tailMidH: number;   // middle bar
    tailGlowIdle: number; tailGlowBrake: number; ledBar: number;
    haloSizeIdle: number; haloSizeBrake: number; haloStrength: number;
    groundRedIdle: number; groundRedBrake: number;
    tailReach: number; tailAim: number; tailAngle: number; tailOffset: number;
    tailBodyIdle: number; tailBodyBrake: number; tailBodyReach: number;
    // glare control
    lampFadeDist: number;   // m: a car closer than this to the camera dims its lamps
    lampNearMin: number;    // 0..1: how bright they stay when the camera is right next to them
}

const BASE: LightSettings = {
    headOn: true, headColor: "#dfe6ff", headRound: false, headSize: 0.24,
    headX: 0.55, headY: 0.30, headZ: 0.315, headCore: 3.0, headTilt: 0.07, headYaw: 0.04,
    spotIntensity: 380, spotAngle: 0.42, spotPenumbra: 0.85, spotSpread: 2.0, spotWidthComp: 0.5, spotDecay: 0.4,
    beamStrength: 0.24, beamWidth: 0.95, beamLength: 16, beamWidthComp: 1.0, beamNearFade: 1.5, beamCamFade: 7,
    topOn: false, topSize: 0.2, topX: 0.55, topY: 0.75, topZ: 0.335,
    barOn: false, barW: 1.1, barH: 0.09, barY: 2.0, barZ: 0.08, barGlow: 4, barHalo: 0.8, barBeam: 0.14, barBeamLen: 22, barLight: 70,
    amberOn: false, amberColor: "#ffa010", amberRect: false,
    amberX: 0.86, amberY: 0.30, amberZ: 0.335, amberW: 0.16, amberH: 0.16, amberGlow: 2.8, amberWash: 0, amberReach: 4,
    amberTailOn: false, amberTailX: 0.86, amberTailY: 0.5, amberTailZ: -0.315, amberTailW: 0.08, amberTailH: 0.2,
    tailOn: true, tailColor: "#" + new THREE.Color(1.0, 0.012, 0.03).getHexString(), // deep ruby
    tailRect: false, tailW: 0.18, tailH: 0.18, tailX: 0.55, tailY: 0.50, tailZ: -0.315,
    tail2On: false, tail2Y: 0.22, tailMidOn: false, tailMidY: 0.62, tailMidW: 0.5, tailMidH: 0.07,
    tailGlowIdle: 2.8, tailGlowBrake: 5, ledBar: 1.0, haloSizeIdle: 0.3, haloSizeBrake: 0.6, haloStrength: 1.0,
    groundRedIdle: 1.5, groundRedBrake: 6, tailReach: 6, tailAim: 1.8, tailAngle: 0.8, tailOffset: 0.25,
    tailBodyIdle: 0.3, tailBodyBrake: 1.5, tailBodyReach: 2.2,
    lampFadeDist: 9, lampNearMin: 0.25,
};
export const DEFAULT_LIGHT_SETTINGS = BASE;

const RIG_OVERRIDES: Record<RigId, Partial<LightSettings>> = {
    // 2 rectangle + 2 round head lamps, 2 amber lamps in the red lamps' design, red round tail as before
    toyota: { headRound: false, topOn: true, amberOn: true, amberRect: false },
    // 2 lamps + roof bar, vertical amber lamps that wash ground and car, 2 rows + middle red bar, amber tail pair
    toyota6: {
        headRound: false, barOn: true,
        amberOn: true, amberRect: true, amberW: 0.07, amberH: 0.22, amberX: 0.86, amberY: 0.22, amberWash: 1.2,
        tailRect: true, tailW: 0.2, tailH: 0.1, tail2On: true, tailMidOn: true,
        amberTailOn: true, amberTailY: 0.36,
    },
    // original look of the other cars: round head pair, round red tail pair
    default: { headRound: true, headSize: 0.22 },
};

export function getRigDefaults(rig: RigId): LightSettings {
    return { ...BASE, ...RIG_OVERRIDES[rig] };
}

const STORAGE_PREFIX = "rallydouz.lights.v2.";

function sanitize(src: Partial<LightSettings>, rig: RigId): LightSettings {
    const def = getRigDefaults(rig);
    const out = { ...def } as Record<string, unknown>;
    const d = def as unknown as Record<string, unknown>;
    const inp = src as Record<string, unknown>;
    for (const k of Object.keys(d)) {
        const v = inp[k];
        if (typeof v !== typeof d[k]) continue;
        if (typeof v === "number" && !Number.isFinite(v)) continue;
        if (typeof v === "string" && !/^#[0-9a-fA-F]{6}$/.test(v)) continue;
        out[k] = v;
    }
    return out as unknown as LightSettings;
}

function loadSaved(rig: RigId): LightSettings {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + rig);
        if (raw) return sanitize(JSON.parse(raw) as Partial<LightSettings>, rig);
    } catch { /* no storage / bad json: defaults */ }
    return getRigDefaults(rig);
}

const store: Record<RigId, LightSettings> = {
    toyota: loadSaved("toyota"), toyota6: loadSaved("toyota6"), default: loadSaved("default"),
};
let previewBrake = false;
let playerRig: RigId = "toyota";
const instances = new Set<CarLights>();
const viewerPos = new THREE.Vector3(1e6, 0, 0);

/** The rig of the player's car (the panel opens on it). */
export function getPlayerRig(): RigId { return playerRig; }

/** A copy of the settings of a rig (default: the player's car). */
export function getLightSettings(rig: RigId = playerRig): LightSettings {
    return { ...store[rig] };
}

/** Apply settings to every car of that rig. persist = also save them for the next visit. */
export function setLightSettings(next: Partial<LightSettings>, persist = false, rig: RigId = playerRig): void {
    store[rig] = sanitize({ ...store[rig], ...next }, rig);
    if (persist) {
        try { localStorage.setItem(STORAGE_PREFIX + rig, JSON.stringify(store[rig])); } catch { /* storage full / blocked */ }
    }
    for (const l of instances) {
        if (!l.isAlive()) { instances.delete(l); continue; }
        if (l.rig === rig) l.refresh();
    }
}

/** Force the tail lights into their braking look (for tuning them without driving). */
export function setBrakePreview(on: boolean): void { previewBrake = on; }

/** Call once per frame with the camera position (glare control). */
export function setLightViewer(p: THREE.Vector3): void { viewerPos.copy(p); }

// ---------------------------------------------------------- pure brightness maths
const SPOT_REF_DIST = 25;

/** Road-light intensity multiplier: spreads the same light when widened; keeps the pool at 25 m
 *  equally bright when the decay changes (lower decay = dimmer right in front of the car). */
export function roadLightFactor(angle: number, widthComp: number, decay: number): number {
    const baseCone = 1 - Math.cos(BASE.spotAngle);
    const cone = 1 - Math.cos(Math.max(0.05, angle));
    return Math.pow(baseCone / cone, widthComp) * Math.pow(SPOT_REF_DIST, decay - 1);
}

/** Light-shaft opacity multiplier when widened / narrowed (wider must look dimmer, not hotter). */
export function beamWidthFactor(widthRatio: number, comp: number): number {
    const f = Math.pow(1 / Math.max(widthRatio, 0.01), 1.5 * comp);
    return Math.min(3, Math.max(0.12, f));
}

/** 1 = far from the camera, minK when the camera is right next to the lamps (smooth in between). */
export function proximityFactor(dist: number, fadeDist: number, minK: number): number {
    const t = Math.min(1, Math.max(0, (dist - 1.2) / Math.max(0.01, fadeDist - 1.2)));
    return minK + (1 - minK) * t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------- constants
const HEAD_LENS_COLOR = new THREE.Color(1.0, 0.96, 0.85).multiplyScalar(0.9);
const HEAD_CORE_BASE = new THREE.Color(1.0, 0.97, 0.88);
const BEAM_BASE_LENGTH = 16;
const BEAM_BASE_RADIUS = 0.95;
const beamTime = { value: 0 };               // shared clock for the beam dust
const SPOT_DISTANCE = 350;
const HEAD_BASE_SIZE = 0.22;
const HEAD_BOX_WIDTH = 0.24;
const BODY_LIGHT_BACK = 0.8;                 // panel-wash light sits this far behind the tail lamps
const GROUND_Y = -1.1;                       // approx. road level relative to the chassis centre
const WHITE = new THREE.Color(1, 1, 1);
const CORE_IDLE = 3.5, CORE_BRAKE = 6;       // LED bar HDR multipliers
const HALO_IDLE = 1.0, HALO_BRAKE = 2.0;
const HALO_OPACITY_IDLE = 0.25, HALO_OPACITY_BRAKE = 0.55;
const BRAKE_ATTACK = 50, BRAKE_RELEASE = 20;
const RED_LAMP = 0.18;                       // reference lamp size (m) of the original red tail lamps

interface LampMats { lens: THREE.MeshBasicMaterial; core: THREE.MeshBasicMaterial; halo: THREE.SpriteMaterial }
/** The red-tail-lamp design: lens + LED core + halo. Used for every red and amber lamp. */
interface Lamp { lens: THREE.Mesh; core: THREE.Mesh; halo: THREE.Sprite; k: number }

let GEO: { roundLens: THREE.BufferGeometry; roundCore: THREE.BufferGeometry; boxLens: THREE.BufferGeometry; boxCore: THREE.BufferGeometry; unit: THREE.BufferGeometry } | null = null;
function lampGeo() {
    if (!GEO) GEO = {
        roundLens: new THREE.CylinderGeometry(0.5, 0.5, 0.05, 28).rotateX(Math.PI / 2),
        roundCore: new THREE.CylinderGeometry(0.444, 0.444, 0.06, 28).rotateX(Math.PI / 2),
        boxLens: new THREE.BoxGeometry(1, 1, 0.05),
        boxCore: new THREE.BoxGeometry(0.78, 0.78, 0.06),
        unit: new THREE.BoxGeometry(1, 1, 1),
    };
    return GEO;
}

export class CarLights {
    readonly rig: RigId;
    private readonly isPlayer: boolean;
    private readonly root: THREE.Object3D;
    private readonly halfLen: number;
    private readonly halfH: number;
    private readonly halfW: number;
    // main head pair [lens, core] per side, upper round pair, beams, road lights
    private readonly headMeshes: THREE.Mesh[] = [];
    private readonly topMeshes: THREE.Mesh[] = [];
    private readonly headGeos: { lens: THREE.BufferGeometry; core: THREE.BufferGeometry; boxLens: THREE.BufferGeometry; boxCore: THREE.BufferGeometry };
    private readonly beams: THREE.Mesh[] = [];
    private readonly beamSide: number[] = [];
    private readonly beamMats: THREE.ShaderMaterial[] = [];
    private readonly spots: THREE.SpotLight[] = [];
    private readonly spotBaseX: number[] = [];
    private readonly spotBaseY: number[] = [];
    private readonly spotBaseZ: number[] = [];
    private readonly spotSide: number[] = [];
    // red + amber lamps (tail-lamp design)
    private readonly redMain: Lamp[] = [];
    private readonly redRow2: Lamp[] = [];
    private readonly redMid: Lamp[] = [];
    private readonly amberF: Lamp[] = [];
    private readonly amberR: Lamp[] = [];
    private readonly redMats: LampMats;
    private readonly amberMats: LampMats;
    private readonly headCoreMat: THREE.MeshBasicMaterial;
    // roof bar
    private readonly barMat: THREE.MeshBasicMaterial;
    private readonly barMesh: THREE.Mesh;
    private readonly barGlow: THREE.Sprite;
    private readonly barGlowMat: THREE.SpriteMaterial;
    private readonly barBeam: THREE.Mesh;
    private readonly barBeamMat: THREE.ShaderMaterial;
    private readonly barSpot: THREE.SpotLight | null = null;
    // real lights
    private readonly tailLight: THREE.SpotLight | null = null;
    private readonly bodyLight: THREE.SpotLight | null = null;
    private readonly amberSpots: THREE.SpotLight[] = [];
    private readonly tailRed = new THREE.Color();
    private readonly tailHot = new THREE.Color();
    private readonly amberCol = new THREE.Color();
    private level = 0;
    private target = 0;
    private lastT = 0;
    private shown = -1;
    private nearK = 1;
    private nearShown = -1;
    private readonly wp = new THREE.Vector3();

    private get S(): LightSettings { return store[this.rig]; }

    constructor(parent: THREE.Object3D, spec: CarSpec, withRealLights: boolean) {
        this.root = parent;
        this.rig = rigOf(spec.name);
        this.isPlayer = withRealLights;
        if (withRealLights) playerRig = this.rig;
        this.halfW = spec.halfWidth;
        this.halfH = spec.halfHeight;
        this.halfLen = spec.halfLength;
        const S = this.S;

        // ---- main head pair + upper round pair (shared materials)
        const r = HEAD_BASE_SIZE / 2;
        this.headGeos = {
            lens: new THREE.CylinderGeometry(r, r, 0.05, 32).rotateX(Math.PI / 2),
            core: new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.06, 32).rotateX(Math.PI / 2),
            boxLens: new THREE.BoxGeometry(0.24, 0.12, 0.05),
            boxCore: new THREE.BoxGeometry(0.10, 0.06, 0.06),
        };
        const headMat = new THREE.MeshBasicMaterial({ color: HEAD_LENS_COLOR });
        this.headCoreMat = new THREE.MeshBasicMaterial({ color: HEAD_CORE_BASE.clone() });
        for (const side of [-1, 1]) {
            const lens = new THREE.Mesh(S.headRound ? this.headGeos.lens : this.headGeos.boxLens, headMat);
            const core = new THREE.Mesh(S.headRound ? this.headGeos.core : this.headGeos.boxCore, this.headCoreMat);
            parent.add(lens, core);
            this.headMeshes.push(lens, core);
            const tl = new THREE.Mesh(this.headGeos.lens, headMat);
            const tc = new THREE.Mesh(this.headGeos.core, this.headCoreMat);
            parent.add(tl, tc);
            this.topMeshes.push(tl, tc);

            const beamMat = createBeamMaterial();
            const beam = new THREE.Mesh(createBeamGeometry(), beamMat);
            beam.renderOrder = 2;
            parent.add(beam);
            this.beams.push(beam);
            this.beamSide.push(side);
            this.beamMats.push(beamMat);

            if (withRealLights) {
                const spot = new THREE.SpotLight(0xffffff, 0, SPOT_DISTANCE, 0.4, 0.8, 1.0);
                spot.castShadow = false;
                parent.add(spot, spot.target);
                this.spots.push(spot);
                this.spotBaseX.push(0); this.spotBaseY.push(0); this.spotBaseZ.push(0);
                this.spotSide.push(side);
            }
        }

        // ---- red and amber lamps: the same design (lens + LED core + halo)
        const glow = createGlowTexture();
        const mats = (): LampMats => ({
            lens: new THREE.MeshBasicMaterial({ color: new THREE.Color() }),
            core: new THREE.MeshBasicMaterial({ color: new THREE.Color() }),
            halo: new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
        });
        this.redMats = mats();
        this.amberMats = mats();
        for (let i = 0; i < 2; i++) {
            this.redMain.push(this.mkLamp(parent, this.redMats));
            this.redRow2.push(this.mkLamp(parent, this.redMats));
            this.amberF.push(this.mkLamp(parent, this.amberMats));
            this.amberR.push(this.mkLamp(parent, this.amberMats));
        }
        this.redMid.push(this.mkLamp(parent, this.redMats));

        // ---- roof LED bar: emissive bar + soft glow + fan-shaped shaft (+ a real light for the road)
        this.barMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1) });
        this.barMesh = new THREE.Mesh(lampGeo().unit, this.barMat);
        this.barGlowMat = new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(0.8, 0.88, 1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
        this.barGlow = new THREE.Sprite(this.barGlowMat);
        this.barGlow.renderOrder = 3;
        this.barBeamMat = createBeamMaterial();
        this.barBeam = new THREE.Mesh(createBeamGeometry(), this.barBeamMat);
        this.barBeam.renderOrder = 2;
        parent.add(this.barMesh, this.barGlow, this.barBeam);

        if (withRealLights) {
            const bs = new THREE.SpotLight(0xdfe8ff, 0, 120, 0.8, 1.0, 0.6);
            bs.castShadow = false;
            parent.add(bs, bs.target);
            this.barSpot = bs;

            // red washes: ground behind the car + the car's own rear panel
            const rear = new THREE.SpotLight(0xff1428, 0, S.tailReach, S.tailAngle, 1.0, 2);
            rear.castShadow = false;
            parent.add(rear, rear.target);
            this.tailLight = rear;
            const body = new THREE.SpotLight(0xff1428, 0, S.tailBodyReach, 1.25, 1.0, 2);
            body.castShadow = false;
            parent.add(body, body.target);
            this.bodyLight = body;
            // amber washes: ground + the car's side, one per front amber lamp
            for (let i = 0; i < 2; i++) {
                const a = new THREE.SpotLight(0xffa010, 0, S.amberReach, 1.0, 1.0, 2);
                a.castShadow = false;
                parent.add(a, a.target);
                this.amberSpots.push(a);
            }
        }

        instances.add(this);
        this.refresh();
    }

    private mkLamp(parent: THREE.Object3D, m: LampMats): Lamp {
        const g = lampGeo();
        const lens = new THREE.Mesh(g.roundLens, m.lens);
        const core = new THREE.Mesh(g.roundCore, m.core);
        const halo = new THREE.Sprite(m.halo);
        halo.renderOrder = 3;
        parent.add(lens, core, halo);
        return { lens, core, halo, k: 1 };
    }

    /** dir: +1 = faces forward (core / halo in front of the lens), -1 = faces backward. */
    private placeLamp(l: Lamp, x: number, y: number, z: number, w: number, h: number, round: boolean, dir: number, visible: boolean) {
        const g = lampGeo();
        l.lens.geometry = round ? g.roundLens : g.boxLens;
        l.core.geometry = round ? g.roundCore : g.boxCore;
        l.lens.scale.set(w, h, 1);
        l.core.scale.set(w, h, 1);
        l.lens.position.set(x, y, z);
        l.core.position.set(x, y, z + dir * 0.03);
        l.halo.position.set(x, y, z + dir * 0.08);
        l.k = Math.min(2.2, Math.max(0.6, Math.max(w, h) / RED_LAMP));
        l.lens.visible = l.core.visible = l.halo.visible = visible;
    }

    isAlive(): boolean { return this.root.parent !== null; }

    /** Re-read this rig's settings and push them into every mesh, material and light. */
    refresh(): void {
        const S = this.S, hw = this.halfW, hh = this.halfH, hl = this.halfLen;

        // ---- main head pair
        const hX = hw * S.headX, hY = hh * S.headY, hZ = hl * S.headZ;
        const round = S.headRound;
        const sc = round ? S.headSize / HEAD_BASE_SIZE : S.headSize / HEAD_BOX_WIDTH;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            const lens = this.headMeshes[i * 2], core = this.headMeshes[i * 2 + 1];
            lens.geometry = round ? this.headGeos.lens : this.headGeos.boxLens;
            core.geometry = round ? this.headGeos.core : this.headGeos.boxCore;
            lens.scale.set(sc, sc, 1); core.scale.set(sc, sc, 1);
            lens.position.set(side * hX, hY, hZ);
            core.position.set(side * hX, hY, hZ + 0.03);
            lens.visible = core.visible = S.headOn;
            this.beams[i].position.set(side * hX, hY, hZ + 0.05);
            if (this.spots[i]) {
                this.spotBaseX[i] = side * hX; this.spotBaseY[i] = hY + 0.15; this.spotBaseZ[i] = hZ - 0.6;
                this.spots[i].position.set(this.spotBaseX[i], this.spotBaseY[i], this.spotBaseZ[i]);
            }
            // upper round pair (visual only)
            const tsc = S.topSize / HEAD_BASE_SIZE;
            const tl = this.topMeshes[i * 2], tc = this.topMeshes[i * 2 + 1];
            tl.scale.set(tsc, tsc, 1); tc.scale.set(tsc, tsc, 1);
            tl.position.set(side * hw * S.topX, hh * S.topY, hl * S.topZ);
            tc.position.set(side * hw * S.topX, hh * S.topY, hl * S.topZ + 0.03);
            tl.visible = tc.visible = S.topOn && S.headOn;
        }
        this.applyHeadCore();
        const spotK = roadLightFactor(S.spotAngle, S.spotWidthComp, S.spotDecay);
        for (let i = 0; i < this.spots.length; i++) {
            const spot = this.spots[i];
            spot.color.set(S.headColor);
            spot.intensity = S.headOn ? S.spotIntensity * spotK : 0;
            spot.decay = S.spotDecay; spot.angle = S.spotAngle; spot.penumbra = S.spotPenumbra;
            const fwd = 28 - this.spotBaseZ[i];
            spot.target.position.set(
                this.spotBaseX[i] + this.spotSide[i] * (S.spotSpread + Math.tan(S.headYaw) * fwd),
                this.spotBaseY[i] - Math.tan(S.headTilt) * fwd, 28);
        }
        const w = S.beamWidth / BEAM_BASE_RADIUS, len = S.beamLength / BEAM_BASE_LENGTH;
        const beamK = beamWidthFactor(w, S.beamWidthComp);
        for (let i = 0; i < this.beams.length; i++) {
            this.beams[i].visible = S.headOn;
            this.beams[i].scale.set(w, w, len);
            this.beams[i].rotation.set(S.headTilt, this.beamSide[i] * S.headYaw, 0);
            this.setBeamUniforms(this.beamMats[i], S.beamStrength * beamK, len, w, S.headColor);
        }

        // ---- roof LED bar (toyota6)
        const bY = hh * S.barY, bZ = hl * S.barZ;
        this.barMesh.scale.set(S.barW, S.barH, 0.06);
        this.barMesh.position.set(0, bY, bZ);
        this.barMesh.visible = S.barOn && S.headOn;
        this.barGlow.position.set(0, bY, bZ + 0.1);
        this.barGlow.scale.set(S.barW * 1.5 * Math.max(0.1, S.barHalo), 0.45 * Math.max(0.1, S.barHalo), 1);
        this.barGlow.visible = S.barOn && S.headOn && S.barHalo > 0;
        // wide, flat fan of light in front of the bar
        const fanW = S.barW / BEAM_BASE_RADIUS * 1.6;
        this.barBeam.position.set(0, bY, bZ + 0.05);
        this.barBeam.scale.set(fanW, fanW * 0.22, S.barBeamLen / BEAM_BASE_LENGTH);
        this.barBeam.rotation.set(0.12, 0, 0);
        this.barBeam.visible = S.barOn && S.headOn && S.barBeam > 0;
        this.setBeamUniforms(this.barBeamMat, S.barBeam * beamWidthFactor(fanW * 0.5, 0.5), S.barBeamLen / BEAM_BASE_LENGTH, fanW, "#e4ecff");
        if (this.barSpot) {
            const b = this.barSpot;
            b.position.set(0, bY, bZ + 0.2);
            b.target.position.set(0, bY - Math.tan(0.14) * 24, bZ + 24);
            b.intensity = S.barOn && S.headOn ? S.barLight * Math.pow(25, S.spotDecay - 1) : 0;
            b.visible = S.barOn && S.headOn && S.barLight > 0;
        }

        // ---- red lamps (tail-lamp design): main pair, second row, middle bar
        this.tailRed.set(S.tailColor);
        this.tailHot.copy(this.tailRed).lerp(WHITE, 0.07);
        const tx = hw * S.tailX, ty = hh * S.tailY, tz = hl * S.tailZ;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            this.placeLamp(this.redMain[i], side * tx, ty, tz, S.tailW, S.tailH, !S.tailRect, -1, S.tailOn);
            this.placeLamp(this.redRow2[i], side * tx, hh * S.tail2Y, tz, S.tailW, S.tailH, !S.tailRect, -1, S.tailOn && S.tail2On);
        }
        this.placeLamp(this.redMid[0], 0, hh * S.tailMidY, tz, S.tailMidW, S.tailMidH, false, -1, S.tailOn && S.tailMidOn);
        if (this.tailLight) {
            const L = this.tailLight;
            L.distance = S.tailReach; L.angle = S.tailAngle;
            L.position.set(0, ty, tz - S.tailOffset);
            L.target.position.set(0, -hh, tz - S.tailAim);
        }
        if (this.bodyLight) {
            const B = this.bodyLight;
            B.distance = S.tailBodyReach;
            B.position.set(0, ty + 0.1, tz - BODY_LIGHT_BACK);
            B.target.position.set(0, ty - 0.05, tz + 0.3);
            B.visible = S.tailOn && (S.tailBodyIdle > 0 || S.tailBodyBrake > 0);
        }

        // ---- amber lamps: same design, own colour
        this.amberCol.set(S.amberColor);
        const ax = hw * S.amberX, ay = hh * S.amberY, az = hl * S.amberZ;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            this.placeLamp(this.amberF[i], side * ax, ay, az, S.amberW, S.amberH, !S.amberRect, 1, S.amberOn);
            this.placeLamp(this.amberR[i], side * hw * S.amberTailX, hh * S.amberTailY, hl * S.amberTailZ,
                S.amberTailW, S.amberTailH, !S.amberRect, -1, S.amberTailOn);
            const a = this.amberSpots[i];
            if (a) {
                a.color.copy(this.amberCol);
                a.distance = S.amberReach;
                a.position.set(side * ax + side * 0.1, ay, az + 0.15);
                a.target.position.set(side * (ax + 1.4), GROUND_Y, az + 0.5);
                a.intensity = S.amberOn ? S.amberWash : 0;
                a.visible = S.amberOn && S.amberWash > 0;
            }
        }
        this.shown = -1;
        this.nearShown = -1;
        this.apply(this.level);
    }

    private setBeamUniforms(m: THREE.ShaderMaterial, intensity: number, lenScale: number, widthScale: number, color: string) {
        const u = m.uniforms;
        u.uIntensity.value = intensity;
        u.uNear.value = this.S.beamNearFade;
        u.uLenScale.value = lenScale;
        u.uWidthScale.value = widthScale;
        (u.uCamFade.value as THREE.Vector2).set(1.0, this.S.beamCamFade);
        (u.uColor.value as THREE.Color).set(color);
    }

    private applyHeadCore() {
        this.headCoreMat.color.copy(HEAD_CORE_BASE).multiplyScalar(this.S.headCore * this.nearK);
    }

    /** 0..1 brake pressure: tail lights flare up (eased). Also runs the glare control every frame. */
    setBrake(pressure: number) {
        beamTime.value = (performance.now() * 0.001) % 1000; // also drives the beam dust
        this.target = (pressure > 0.15 || previewBrake) ? 1 : 0;
        const now = performance.now() * 0.001;
        const dt = this.lastT === 0 ? 0.016 : Math.min(0.1, now - this.lastT);
        this.lastT = now;
        const rate = this.target > this.level ? BRAKE_ATTACK : BRAKE_RELEASE;
        this.level += (this.target - this.level) * Math.min(1, rate * dt);
        if (Math.abs(this.level - this.target) < 0.005) this.level = this.target;

        // glare control: lamps of a car close to the camera are dimmed (the player's own car is
        // always ~6-8 m from the chase camera, so it only starts dimming much closer)
        this.root.getWorldPosition(this.wp);
        const fade = this.isPlayer ? Math.min(this.S.lampFadeDist, 4.5) : this.S.lampFadeDist;
        this.nearK = proximityFactor(this.wp.distanceTo(viewerPos), fade, this.S.lampNearMin);
        const nearMoved = Math.abs(this.nearK - this.nearShown) > 0.01;
        if (!nearMoved && Math.abs(this.level - this.shown) < 0.004) return;
        this.nearShown = this.nearK;
        this.applyHeadCore();
        this.apply(this.level);
    }

    private apply(l: number) {
        const S = this.S, n = this.nearK;
        this.shown = l;
        const mix = (a: number, b: number) => a + (b - a) * l;
        // red lamps
        const R = this.redMats;
        R.lens.color.copy(this.tailRed).multiplyScalar(mix(S.tailGlowIdle, S.tailGlowBrake) * n);
        R.core.color.copy(this.tailHot).multiplyScalar(mix(CORE_IDLE, CORE_BRAKE) * S.ledBar * n);
        R.halo.color.copy(this.tailRed).multiplyScalar(mix(HALO_IDLE, HALO_BRAKE) * S.haloStrength);
        R.halo.opacity = mix(HALO_OPACITY_IDLE, HALO_OPACITY_BRAKE) * n;
        const size = mix(S.haloSizeIdle, S.haloSizeBrake);
        for (const lamp of [...this.redMain, ...this.redRow2, ...this.redMid]) lamp.halo.scale.set(size * lamp.k, size * lamp.k, 1);
        // amber lamps (steady, same design)
        const A = this.amberMats;
        const hot = this.amberCol.clone().lerp(WHITE, 0.07);
        A.lens.color.copy(this.amberCol).multiplyScalar(S.amberGlow * n);
        A.core.color.copy(hot).multiplyScalar(CORE_IDLE * S.ledBar * n);
        A.halo.color.copy(this.amberCol).multiplyScalar(HALO_IDLE * S.haloStrength);
        A.halo.opacity = HALO_OPACITY_IDLE * n;
        for (const lamp of [...this.amberF, ...this.amberR]) lamp.halo.scale.set(S.haloSizeIdle * lamp.k, S.haloSizeIdle * lamp.k, 1);
        // roof bar
        this.barMat.color.setRGB(1, 1, 1).multiplyScalar(S.barGlow * n);
        this.barGlowMat.opacity = Math.min(1, 0.5 * n);
        // red washes
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
    geo.translate(0, -BEAM_BASE_LENGTH / 2, 0);
    geo.rotateX(-Math.PI / 2);
    return geo;
}

function createBeamMaterial(): THREE.ShaderMaterial {
    // Fake volumetric light shaft: soft cone + dust + faint streaks. No depth pass needed.
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uColor: { value: new THREE.Color(0.75, 0.82, 1.0) },
            uIntensity: { value: 0.24 },
            uLength: { value: BEAM_BASE_LENGTH },
            uNear: { value: 1.5 },
            uLenScale: { value: 1 },
            uWidthScale: { value: 1 },
            uCamFade: { value: new THREE.Vector2(1.0, 7.0) },   // m: fully faded / fully visible distance from the camera
            uTime: beamTime,
        },
        vertexShader: /* glsl */ `
      uniform float uLength;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      varying float vAng;
      varying float vCamDist;
      void main() {
        vAlong = clamp(position.z / uLength, 0.0, 1.0);
        vLocal = position;
        vAng = atan(position.y, position.x);
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        vCamDist = length(mv.xyz);
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
      uniform vec2 uCamFade;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      varying float vAng;
      varying float vCamDist;

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
        float dist = vLocal.z * uLenScale;                     // metres from the lamp
        float along = pow(1.0 - vAlong, 1.5);
        float edge = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.3);
        float nearFade = smoothstep(0.0, max(uNear, 0.001), dist);           // no hot start at the lamp
        float camFade = smoothstep(uCamFade.x, max(uCamFade.y, uCamFade.x + 0.01), vCamDist); // no white-out near the camera
        float dust = vnoise(vec3(vLocal.xy * uWidthScale * 1.6, dist * 0.28 - uTime * 3.0));
        dust = 0.45 + 1.1 * dust;
        float streak = 0.72 + 0.28 * sin(vAng * 9.0 + uTime * 0.35 + vnoise(vec3(vAng * 2.0, vLocal.z * 0.1, uTime * 0.2)) * 3.0);
        float a = along * edge * dust * streak * nearFade * camFade * uIntensity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    });
}