import * as THREE from "three";
import type { CarSpec } from "./CarSpec";

/**
 * Night driving lights for a car, attached to its chassis group so they follow
 * the body (including the cosmetic lean).
 *
 *  - HEADLIGHTS: two separate lamps, each with a lens, a hot core, a light-shaft cone
 *    (dust drifting through it) and (player only) its own SpotLight.
 *  - TAIL LIGHTS: deep red LED lamps (lens + LED bar + soft halo sprite), HDR so the
 *    bloom pass makes them glow, flaring when braking. A red PointLight behind the
 *    player car throws red onto the ground and the rear of the body.
 *  - Real lights cost every material in the scene, so they are player-only
 *    (withRealLights); the bot gets all the glow, halos and shafts but no real light.
 *
 * Every look value lives in LightSettings. The in-game panel (LightsPanel.ts) edits
 * them; setLightSettings() applies them to every car on screen and, with persist=true,
 * saves them so they come back next time the game loads.
 *
 * +Z is the car's forward axis (same as the physics controller).
 * Tune HEAD / TAIL if the lights don't sit on a particular model's grille:
 * values are fractions of the spec's half extents, measured from the chassis centre.
 */
const HEAD = { x: 0.80, y: -0.37, z: 0.89 };
const TAIL = {
    x: 0.5, y: 0.40, z: -0.35
};

// ------------------------------------------------------------------ settings
export interface LightSettings {
    // headlights
    headOn: boolean;
    headColor: string;      // "#rrggbb": road light + light shafts
    spotIntensity: number;  // road light brightness (per lamp)
    spotAngle: number;      // rad, road light half-angle (per lamp)
    spotPenumbra: number;   // 0..1 edge softness
    spotSpread: number;     // m the two pools are pushed apart at 28 m
    beamStrength: number;   // light-shaft opacity
    beamWidth: number;      // m, shaft radius at its far end
    beamLength: number;     // m
    headCore: number;       // lamp core brightness (HDR multiplier)
    // tail lights
    tailOn: boolean;
    tailColor: string;      // "#rrggbb"
    tailGlowIdle: number;   // lens HDR multiplier, lights on
    tailGlowBrake: number;  // lens HDR multiplier, braking
    ledBar: number;         // LED bar brightness (1 = default)
    haloSizeIdle: number;   // m
    haloSizeBrake: number;  // m
    haloStrength: number;   // halo brightness (1 = default)
    groundRedIdle: number;  // red PointLight intensity, lights on
    groundRedBrake: number; // red PointLight intensity, braking
}

export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
    headOn: true,
    headColor: "#dfe6ff",
    spotIntensity: 380,
    spotAngle: 0.42,
    spotPenumbra: 0.85,
    spotSpread: 2.0,
    beamStrength: 0.24,
    beamWidth: 0.95,
    beamLength: 16,
    headCore: 4.0,
    tailOn: true,
    tailColor: "#" + new THREE.Color(1.0, 0.012, 0.03).getHexString(), // deep ruby
    tailGlowIdle: 2.8,
    tailGlowBrake: 7,
    ledBar: 1.0,
    haloSizeIdle: 0.3,
    haloSizeBrake: 0.6,
    haloStrength: 1.0,
    groundRedIdle: 0.6,
    groundRedBrake: 3.5,
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

// ------------------------------------------------------------------- constants
const HEAD_LENS_COLOR = new THREE.Color(1.0, 0.96, 0.85).multiplyScalar(0.9);
const HEAD_CORE_BASE = new THREE.Color(1.0, 0.97, 0.88);

const BEAM_BASE_LENGTH = 16;
const BEAM_BASE_RADIUS = 0.95;
const BEAM_YAW = 0.04;      // rad, each beam leans slightly outward
/** Shared clock for the beam dust animation (all beams of all cars). */
const beamTime = { value: 0 };

const SPOT_DISTANCE = 350;

const WHITE = new THREE.Color(1, 1, 1);
const CORE_IDLE = 3.5, CORE_BRAKE = 9;             // LED bar HDR multipliers
const HALO_IDLE = 1.0, HALO_BRAKE = 2.0;           // halo colour multipliers
const HALO_OPACITY_IDLE = 0.25, HALO_OPACITY_BRAKE = 0.7;
const TAIL_LIGHT_DISTANCE = 7;
const TAIL_LIGHT_BACK = 1.4; // m behind the rear bumper: far enough that it can't make a hotspot on the body
const TAIL_LIGHT_UP = 0.9;   // × halfHeight above the chassis centre
const BRAKE_ATTACK = 28;   // 1/s, how fast the lamps flare up
const BRAKE_RELEASE = 9;   // 1/s, how fast they settle back

export class CarLights {
    private readonly root: THREE.Object3D;
    private readonly headMeshes: THREE.Mesh[] = [];
    private readonly beams: THREE.Mesh[] = [];
    private readonly beamMats: THREE.ShaderMaterial[] = [];
    private readonly spots: THREE.SpotLight[] = [];
    private readonly spotBaseX: number[] = [];
    private readonly spotSide: number[] = [];
    private readonly tailMeshes: THREE.Mesh[] = [];
    private readonly haloSprites: THREE.Sprite[] = [];
    private readonly headCoreMat: THREE.MeshBasicMaterial;
    private readonly tailLensMat: THREE.MeshBasicMaterial;
    private readonly tailCoreMat: THREE.MeshBasicMaterial;
    private readonly haloMat: THREE.SpriteMaterial;
    private readonly tailLight: THREE.PointLight | null = null;
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

        const lensGeo = new THREE.BoxGeometry(0.24, 0.12, 0.05);
        const headCoreGeo = new THREE.BoxGeometry(0.10, 0.06, 0.06);
        const tailCoreGeo = new THREE.BoxGeometry(0.20, 0.035, 0.06); // thin LED bar
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
            const hxp = side * hx * HEAD.x, hyp = hy * HEAD.y, hzp = hz * HEAD.z;
            const head = new THREE.Mesh(lensGeo, headMat);
            head.position.set(hxp, hyp, hzp);
            parent.add(head);
            const headCore = new THREE.Mesh(headCoreGeo, this.headCoreMat);
            headCore.position.set(hxp, hyp, hzp + 0.03);
            parent.add(headCore);
            this.headMeshes.push(head, headCore);

            const beamMat = createBeamMaterial();
            const beam = new THREE.Mesh(createBeamGeometry(), beamMat);
            beam.position.set(hxp, hyp, hzp + 0.05);
            beam.rotation.x = 0.07;             // tilt slightly down onto the road
            beam.rotation.y = side * BEAM_YAW;  // and slightly outward
            beam.renderOrder = 2;
            parent.add(beam);
            this.beams.push(beam);
            this.beamMats.push(beamMat);

            // --- tail light: ruby lens + LED core bar + halo
            const txp = side * hx * TAIL.x, typ = hy * TAIL.y, tzp = hz * TAIL.z;
            const tail = new THREE.Mesh(lensGeo, this.tailLensMat);
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
                const spot = new THREE.SpotLight(0xffffff, 0, SPOT_DISTANCE, 0.4, 0.8, 2);
                spot.position.set(hxp, hyp, hzp);
                spot.castShadow = false;
                spot.target.position.set(hxp, -0.2, 28);
                parent.add(spot);
                parent.add(spot.target);
                this.spots.push(spot);
                this.spotBaseX.push(hxp);
                this.spotSide.push(side);
            }
        }

        // One red light just behind the car: tints the ground behind it and the body's rear.
        if (withRealLights) {
            this.tailLight = new THREE.PointLight(0xff1428, 0, TAIL_LIGHT_DISTANCE, 2);
            this.tailLight.position.set(0, hy * TAIL_LIGHT_UP, -hz - TAIL_LIGHT_BACK);
            this.tailLight.castShadow = false;
            parent.add(this.tailLight);
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

        // headlights
        for (const m of this.headMeshes) m.visible = S.headOn;
        this.headCoreMat.color.copy(HEAD_CORE_BASE).multiplyScalar(S.headCore);
        for (let i = 0; i < this.spots.length; i++) {
            const spot = this.spots[i];
            spot.color.set(S.headColor);
            spot.intensity = S.headOn ? S.spotIntensity : 0;
            spot.angle = S.spotAngle;
            spot.penumbra = S.spotPenumbra;
            spot.target.position.x = this.spotBaseX[i] + this.spotSide[i] * S.spotSpread;
        }
        const w = S.beamWidth / BEAM_BASE_RADIUS;
        const len = S.beamLength / BEAM_BASE_LENGTH;
        for (let i = 0; i < this.beams.length; i++) {
            this.beams[i].visible = S.headOn;
            this.beams[i].scale.set(w, w, len);
            const u = this.beamMats[i].uniforms;
            u.uIntensity.value = S.beamStrength;
            (u.uColor.value as THREE.Color).set(S.headColor);
        }

        // tail lights
        this.tailRed.set(S.tailColor);
        this.tailHot.copy(this.tailRed).lerp(WHITE, 0.07); // LED bar: a touch hotter than the lens
        for (const m of this.tailMeshes) m.visible = S.tailOn;
        for (const s of this.haloSprites) s.visible = S.tailOn;
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
        // brightest near the lamp, fading to nothing at the far end; soft edges
        float along = pow(1.0 - vAlong, 1.5);
        float edge = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.3);

        // dust drifting back along the beam as the car drives forward
        float dust = vnoise(vec3(vLocal.xy * 1.6, vLocal.z * 0.28 - uTime * 3.0));
        dust = 0.45 + 1.1 * dust;

        // faint shafts around the axis, slowly shimmering
        float streak = 0.72 + 0.28 * sin(vAng * 9.0 + uTime * 0.35 + vnoise(vec3(vAng * 2.0, vLocal.z * 0.1, uTime * 0.2)) * 3.0);

        float a = along * edge * dust * streak * uIntensity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    });
}