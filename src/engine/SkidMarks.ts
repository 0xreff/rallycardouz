import * as THREE from "three";
import { TREAD_ASPECT, TREAD_DEPTH_PNG } from "./treadTexture";

/**
 * Tyre tracks + skid marks, drawn as one continuous RIBBON per wheel (one mesh, one draw
 * call each, a fixed ring buffer of quads, no per-frame allocation).
 *
 * LOOSE GROUND (sand) is drawn as real RELIEF, not a painted pattern. Across the ribbon
 * the shader models a cross-section: a pressed groove where the tyre ran, and a ridge of
 * sand pushed up on BOTH sides of the wheel. It then lights that little profile with the
 * game's own sun, so the sun-facing side of each ridge is bright and the far side falls
 * into shade. That is why it reads as sand displaced left and right of the tyre and
 * changes with the sun angle, with no tyre texture involved.
 *
 *  - rolling tyre   : shallow groove, small ridges
 *  - skid / slide   : deeper, wider, darker groove with bigger ridges, and more sand
 *                     piled on the side the tyre is sliding toward (drifts, braking, burnouts)
 *  - tarmac         : flat black rubber mark, no relief
 *
 * Sand tracks hold for a couple of minutes and then soften (the wind fills them in);
 * rubber marks fade sooner.
 *
 * Owned by the Game so the marks persist across car swaps. Slots are chosen by the caller:
 * 4 per car (CarFX uses `carSlot * 4 + wheelIndex`).
 */

const MIN_STEP = 0.35;      // metres between samples (smaller = smoother, more quads)
const MAX_JUMP = 6;         // a bigger step is a teleport/respawn → start a new trail
const LIFT = 0.05;          // metres above the ground (along its normal)
const LIFE_SAND = 160;      // seconds a sand track lasts (holds, then softens over the last 55%)
const LIFE_RUBBER = 45;     // seconds a tarmac skid mark lasts
const HOLD_FRAC = 0.45;     // fraction of life left at which the fade-out begins
const FADE_TICK = 0.5;      // fade is refreshed twice a second, not every frame
const DAB_INTERVAL = 0.1;   // seconds between stationary burnout dabs
const DAB_LENGTH = 0.7;     // metres
const SLIDE_NORM = 3;       // m/s of sideways slide that counts as "full" slip
const ERASE_WINDOW = 256;   // recent quads of each FRONT trail a rear wheel can wipe (~90 m of track)
const ERASE_MAX_DY = 0.6;   // metres: never wipe a track that lies on a different level (ramps)
const ERASE_FULL = 0.55;    // rear wheel within this fraction of the touching distance = fully wiped

interface V3 { x: number; y: number; z: number }

class Trail {
  readonly mesh: THREE.Mesh;
  readonly pos: THREE.BufferAttribute;   // world position
  readonly uv: THREE.BufferAttribute;    // x = across 0..1, y = metres along the ribbon
  readonly side: THREE.BufferAttribute;  // world-space unit vector pointing across the ribbon (u 0 → 1)
  readonly info: THREE.BufferAttribute;  // x = alpha, y = depth 0..1, z = kind (0 rubber / 1 sand), w = half width (m)
  readonly extra: THREE.BufferAttribute; // x = slip -1..1 (sand thrown toward +u), y = random seed, z = ridge keep 1..0 (0 = side ridges wiped)
  readonly born: Float32Array;   // creation time of each quad, -1 = empty
  readonly life: Float32Array;   // lifetime of each quad (s)
  readonly mul: Float32Array;    // fade multiplier currently written for each quad
  readonly ers: Float32Array;    // 1 = untouched .. 0 = side ridges wiped by a rear wheel driving over it (groove stays)
  readonly a0: Float32Array;     // alpha at the quad's trailing edge
  readonly a1: Float32Array;     // alpha at the quad's leading edge
  head = 0;
  hasLast = false;
  hasEdges = false;
  prevA = 0;
  prevV = 0;           // metres along the ribbon at the previous sample
  vAcc = 0;            // metres accumulated along the ribbon
  lastDab = -1;
  readonly last = new THREE.Vector3();
  readonly prevL = new THREE.Vector3();
  readonly prevR = new THREE.Vector3();

  constructor(segments: number, material: THREE.Material) {
    const mk = (n: number) => {
      const a = new THREE.BufferAttribute(new Float32Array(segments * 4 * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.pos = mk(3);
    this.uv = mk(2);
    this.side = mk(3);
    this.info = mk(4);
    this.extra = mk(3);

    const index = new Uint32Array(segments * 6);
    for (let i = 0; i < segments; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.pos);
    geo.setAttribute("uv", this.uv);
    geo.setAttribute("aSide", this.side);
    geo.setAttribute("aInfo", this.info);
    geo.setAttribute("aExtra", this.extra);
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    this.born = new Float32Array(segments).fill(-1);
    this.life = new Float32Array(segments).fill(LIFE_RUBBER);
    this.mul = new Float32Array(segments).fill(1);
    this.ers = new Float32Array(segments).fill(1);
    this.a0 = new Float32Array(segments);
    this.a1 = new Float32Array(segments);

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false; // vertices change every frame
    this.mesh.renderOrder = 1;
    this.mesh.matrixAutoUpdate = false;
  }
}

export class SkidMarks {
  private readonly trails: Trail[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly sunU = { value: new THREE.Vector3(0.3, 0.4, 0.8).normalize() };
  private readonly lightColU = { value: new THREE.Color(1.0, 0.65, 0.35) };
  private readonly ambU = { value: 0.3 };
  private readonly treadTex: THREE.Texture;
  private readonly treadU: { value: THREE.Texture };
  private time = 0;
  private fadeAcc = 0;

  /**
   * On loose ground a rear wheel that drives over the track of a front wheel flattens the
   * sand ridges on both sides of it (the lit and shaded outline), so in a turn you see one
   * clean pair of tracks, not two piled on each other. The pressed groove and tread of the
   * front track stay. Set to false to keep every track untouched.
   */
  rearErasesFront = true;

  // scratch (no allocation in the hot path)
  private readonly _n = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _side = new THREE.Vector3();
  private readonly _sideN = new THREE.Vector3();
  private readonly _pl = new THREE.Vector3();
  private readonly _pr = new THREE.Vector3();
  private readonly _cl = new THREE.Vector3();
  private readonly _cr = new THREE.Vector3();
  private readonly _off = new THREE.Vector3();
  private readonly _half = new THREE.Vector3();
  private readonly _e0 = new THREE.Vector3();
  private readonly _e1 = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, slots = 8, private readonly segments = 2400) {
    // Tyre tread depth map: loaded from the embedded PNG (the tracks look fine, just without
    // tread detail, for the few frames until it decodes).
    this.treadTex = new THREE.TextureLoader().load(TREAD_DEPTH_PNG);
    this.treadTex.wrapS = THREE.ClampToEdgeWrapping;
    this.treadTex.wrapT = THREE.RepeatWrapping;
    this.treadTex.anisotropy = 8;
    this.treadTex.colorSpace = THREE.NoColorSpace;
    this.treadU = { value: this.treadTex };
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uSun: this.sunU, uLightCol: this.lightColU, uAmb: this.ambU, uTread: this.treadU },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      transparent: true,
      depthWrite: false, // darken the ground without occluding the car
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    for (let i = 0; i < slots; i++) {
      const t = new Trail(segments, this.material);
      this.trails.push(t);
      scene.add(t.mesh);
    }
  }

  /**
   * Tell the tracks where the light is so the sand relief is lit like the rest of the map:
   * `dir` = direction towards the sun/moon, `color` = its colour, `ambient` = how much of
   * the lighting is sky fill (higher = flatter, softer relief).
   */
  setLight(dir: THREE.Vector3, color: THREE.Color, ambient = 0.3) {
    this.sunU.value.copy(dir).normalize();
    this.lightColU.value.copy(color);
    this.ambU.value = ambient;
  }

  /**
   * Extend a wheel's ribbon to (p), lying on a surface with normal (n).
   * strength 0..1. A strength of ~0 closes the trail with a fade-out.
   * `sand` = loose ground (relief track that lasts) instead of a tarmac rubber mark.
   * `depth` 0..1 = how hard the tyre dug in (rolling ~0.5, skidding 1).
   * `slide` = the wheel's sideways slide velocity (x, z in m/s): sand piles up on that side.
   */
  addPoint(slot: number, p: V3, n: V3, width: number, strength: number, sand = false, depth = 0.5, slide?: { x: number; z: number }) {
    const t = this.trails[slot];
    if (!t) return;
    const fadeOut = strength <= 0.02;

    if (fadeOut && !(t.hasEdges && t.prevA > 0.02)) {
      t.hasLast = false;
      t.hasEdges = false;
      return;
    }

    if (!t.hasLast) {
      t.last.set(p.x, p.y, p.z);
      t.hasLast = true;
      t.hasEdges = false;
      return;
    }

    this._d.set(p.x - t.last.x, p.y - t.last.y, p.z - t.last.z);
    const dist = this._d.length();
    if (dist < MIN_STEP) return;
    if (dist > MAX_JUMP) {
      t.last.set(p.x, p.y, p.z);
      t.hasEdges = false;
      return;
    }
    this._d.divideScalar(dist);
    this.setNormal(n);

    this.edges(p, this._d, width, this._cl, this._cr);
    const sideX = -this._sideN.x, sideY = -this._sideN.y, sideZ = -this._sideN.z; // L→R across the ribbon
    let a0: number;
    if (t.hasEdges) {
      this._pl.copy(t.prevL);
      this._pr.copy(t.prevR);
      a0 = t.prevA;
    } else {
      this.edges(t.last, this._d, width, this._pl, this._pr);
      a0 = 0; // fade in from nothing
    }
    const a1 = fadeOut ? 0 : Math.min(1, strength);
    const v0 = t.hasEdges ? t.prevV : t.vAcc;
    const v1 = v0 + dist;
    const slip = slide ? THREE.MathUtils.clamp((slide.x * sideX + slide.z * sideZ) / SLIDE_NORM, -1, 1) : 0;
    this.writeQuad(t, this._pl, this._pr, this._cl, this._cr, a0, a1, sand, depth, width * 0.5, slip, sideX, sideY, sideZ, v0, v1);
    if (sand && !fadeOut && this.rearErasesFront && (slot & 3) >= 2) {
      this.eraseFrontTracks(slot, t.last, p, width * 0.5);
    }

    t.prevL.copy(this._cl);
    t.prevR.copy(this._cr);
    t.prevA = a1;
    t.prevV = v1;
    t.vAcc = v1;
    t.hasEdges = true;
    t.last.set(p.x, p.y, p.z);

    if (fadeOut) {
      t.hasLast = false;
      t.hasEdges = false;
    }
  }

  /** Stationary scrub patch (burnout): a short stand-alone mark along `yaw`. */
  stamp(slot: number, p: V3, n: V3, yaw: number, width: number, strength: number, sand = false, depth = 1) {
    const t = this.trails[slot];
    if (!t) return;
    if (this.time - t.lastDab < DAB_INTERVAL) return;
    t.lastDab = this.time;

    this.setNormal(n);
    this._d.set(Math.sin(yaw), 0, Math.cos(yaw));
    // make the direction lie in the ground plane
    this._d.addScaledVector(this._n, -this._d.dot(this._n)).normalize();
    this._half.copy(this._d).multiplyScalar(DAB_LENGTH * 0.5);
    this._e0.set(p.x, p.y, p.z).sub(this._half);
    this._e1.set(p.x, p.y, p.z).add(this._half);
    this.edges(this._e0, this._d, width, this._pl, this._pr);
    this.edges(this._e1, this._d, width, this._cl, this._cr);
    const a = Math.min(1, strength);
    const v0 = t.vAcc;
    t.vAcc = v0 + DAB_LENGTH;
    this.writeQuad(t, this._pl, this._pr, this._cl, this._cr, a, a, sand, depth, width * 0.5, 0, -this._sideN.x, -this._sideN.y, -this._sideN.z, v0, t.vAcc);
  }

  /** The wheel left the ground (or stopped marking): the next point starts a new trail. */
  endTrail(slot: number) {
    const t = this.trails[slot];
    if (!t) return;
    t.hasLast = false;
    t.hasEdges = false;
  }

  /** Call once per frame — advances time and softens old marks (tracks hold, then fade). */
  update(dt: number) {
    this.time += dt;
    this.fadeAcc += dt;
    if (this.fadeAcc < FADE_TICK) return;
    this.fadeAcc = 0;

    for (const t of this.trails) {
      let dirty = false;
      for (let i = 0; i < this.segments; i++) {
        if (t.born[i] < 0) continue;
        const k = 1 - (this.time - t.born[i]) / t.life[i]; // 1 fresh .. 0 gone
        const m = k <= 0 ? 0 : Math.min(1, k / HOLD_FRAC);  // full strength until HOLD_FRAC of life is left
        if (Math.abs(m - t.mul[i]) < 0.01 && m > 0) continue; // nothing visible changed
        const b = i * 4;
        if (m <= 0) {
          t.born[i] = -1;
          t.mul[i] = 0;
          for (let v = 0; v < 4; v++) t.info.setX(b + v, 0);
        } else {
          // Only the age fade goes into alpha. A rear wheel passing over this quad is
          // handled separately (extra.z flattens the side ridges), so the groove survives.
          t.mul[i] = m;
          const w0 = t.a0[i] * m;
          const w1 = t.a1[i] * m;
          t.info.setX(b, w0);
          t.info.setX(b + 1, w0);
          t.info.setX(b + 2, w1);
          t.info.setX(b + 3, w1);
        }
        dirty = true;
      }
      if (dirty) {
        t.info.addUpdateRange(0, t.info.array.length);
        t.info.needsUpdate = true;
      }
    }
  }

  clear() {
    for (const t of this.trails) {
      t.pos.array.fill(0);
      t.info.array.fill(0);
      t.born.fill(-1);
      t.mul.fill(1);
      t.ers.fill(1);
      t.vAcc = 0;
      t.prevV = 0;
      t.head = 0;
      t.hasLast = false;
      t.hasEdges = false;
      t.pos.needsUpdate = true;
      t.info.needsUpdate = true;
    }
  }

  dispose() {
    for (const t of this.trails) {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    this.material.dispose();
    this.treadTex.dispose();
    this.trails.length = 0;
  }

  // ------------------------------------------------------------- internals

  /**
   * A rear wheel just moved from `a` to `b` on sand: flatten the SIDE RIDGES (the lit and
   * shaded outline) of THIS car's two front-wheel sand tracks that lie under that step. The
   * pressed groove and tread of the front track are left as they are. A front quad's ridges
   * are fully flattened when the rear wheel covers most of it and come back gradually as
   * the overlap shrinks, so a partial overlap in a turn leaves a soft edge, not a hard cut.
   * Rubber marks on tarmac are left alone.
   */
  private eraseFrontTracks(rearSlot: number, a: THREE.Vector3, b: V3, rearHalfW: number) {
    const base = rearSlot & ~3; // the car's first slot: wheels 0 (FL) and 1 (FR) are the front
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const segLenSq = sx * sx + sz * sz;

    for (let f = 0; f < 2; f++) {
      const t = this.trails[base + f];
      if (!t) continue;
      const pos = t.pos.array as Float32Array;
      let touched = false;
      let i = t.head;
      for (let n = 0; n < ERASE_WINDOW; n++) {
        i = i === 0 ? this.segments - 1 : i - 1;
        if (t.born[i] < 0) continue;
        const q = i * 4;
        if (t.info.getZ(q) < 0.5) continue; // rubber mark: keep

        // centre of the quad (4 vertices, 3 floats each)
        const o = q * 3;
        const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7] + pos[o + 10]) * 0.25;
        if (Math.abs(cy - b.y) > ERASE_MAX_DY) continue;
        const cx = (pos[o] + pos[o + 3] + pos[o + 6] + pos[o + 9]) * 0.25;
        const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8] + pos[o + 11]) * 0.25;

        // horizontal distance from the quad centre to the rear wheel's step a -> b
        let u = segLenSq > 1e-6 ? ((cx - a.x) * sx + (cz - a.z) * sz) / segLenSq : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = cx - (a.x + sx * u);
        const dz = cz - (a.z + sz * u);
        const d = Math.sqrt(dx * dx + dz * dz);

        const reach = t.info.getW(q) + rearHalfW; // the two ribbons touch at this distance
        if (d >= reach) continue;
        const e0 = ERASE_FULL * reach;
        const k = d <= e0 ? 0 : (d - e0) / (reach - e0);
        const keep = k * k * (3 - 2 * k); // 0 = ridges flattened, 1 = untouched
        if (keep >= t.ers[i]) continue;

        // Only the ridge-keep value changes: alpha is untouched, so the groove and tread
        // stay and the shader just stops drawing the sand piled up beside the tyre.
        t.ers[i] = keep;
        for (let v = 0; v < 4; v++) t.extra.setZ(q + v, keep);
        t.extra.addUpdateRange(q * 3, 12);
        touched = true;
      }
      if (touched) t.extra.needsUpdate = true;
    }
  }

  private setNormal(n: V3) {
    this._n.set(n.x, n.y, n.z);
    if (this._n.lengthSq() < 1e-6) this._n.set(0, 1, 0);
    this._n.normalize();
  }

  /** Left/right edge points of the ribbon at `p`, lifted off the surface. Also sets _sideN. */
  private edges(p: V3, dir: THREE.Vector3, width: number, outL: THREE.Vector3, outR: THREE.Vector3) {
    this._side.crossVectors(this._n, dir);
    if (this._side.lengthSq() < 1e-8) this._side.set(1, 0, 0);
    this._sideN.copy(this._side).normalize();
    this._side.copy(this._sideN).multiplyScalar(width * 0.5);
    this._off.copy(this._n).multiplyScalar(LIFT);
    outL.set(p.x, p.y, p.z).add(this._side).add(this._off);
    outR.set(p.x, p.y, p.z).sub(this._side).add(this._off);
  }

  private writeQuad(
    t: Trail,
    pl: THREE.Vector3, pr: THREE.Vector3,
    cl: THREE.Vector3, cr: THREE.Vector3,
    a0: number, a1: number,
    sand: boolean, depth: number, halfW: number, slip: number,
    sx: number, sy: number, sz: number,
    v0: number, v1: number
  ) {
    const i = t.head;
    const b = i * 4;
    t.pos.setXYZ(b, pl.x, pl.y, pl.z);
    t.pos.setXYZ(b + 1, pr.x, pr.y, pr.z);
    t.pos.setXYZ(b + 2, cl.x, cl.y, cl.z);
    t.pos.setXYZ(b + 3, cr.x, cr.y, cr.z);

    // u: 0 on the left edge, 1 on the right edge. v: metres along the ribbon.
    t.uv.setXY(b, 0, v0);
    t.uv.setXY(b + 1, 1, v0);
    t.uv.setXY(b + 2, 0, v1);
    t.uv.setXY(b + 3, 1, v1);

    const kind = sand ? 1 : 0;
    const seed = Math.random();
    for (let k = 0; k < 4; k++) {
      t.side.setXYZ(b + k, sx, sy, sz);
      t.info.setXYZW(b + k, k < 2 ? a0 : a1, depth, kind, halfW);
      t.extra.setXYZ(b + k, slip, seed, 1); // z = 1: side ridges intact
    }

    t.born[i] = this.time;
    t.life[i] = sand ? LIFE_SAND : LIFE_RUBBER;
    t.mul[i] = 1;
    t.ers[i] = 1;
    t.a0[i] = a0;
    t.a1[i] = a1;
    t.head = (i + 1) % this.segments;

    t.pos.addUpdateRange(b * 3, 12);
    t.pos.needsUpdate = true;
    t.uv.addUpdateRange(b * 2, 8);
    t.uv.needsUpdate = true;
    t.side.addUpdateRange(b * 3, 12);
    t.side.needsUpdate = true;
    t.info.addUpdateRange(b * 4, 16);
    t.info.needsUpdate = true;
    t.extra.addUpdateRange(b * 3, 12);
    t.extra.needsUpdate = true;
  }
}

// ----------------------------------------------------------------- shaders

const VERT = /* glsl */ `
  #include <fog_pars_vertex>
  attribute vec3 aSide;
  attribute vec4 aInfo;
  attribute vec3 aExtra;
  varying vec2 vUv;
  varying vec3 vSide;
  varying vec4 vInfo;
  varying vec3 vExtra;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vSide = aSide;
    vInfo = aInfo;
    vExtra = aExtra;
    vWorld = position;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <fog_pars_fragment>
  uniform vec3 uSun;
  uniform vec3 uLightCol;
  uniform float uAmb;
  uniform sampler2D uTread;

  // ---- Easy tuning for the sun/moon-lit edge of each sand ridge ----
  const float GLOW_STRENGTH = 0.45; // brightness of the lit edge (0 = none, ~0.8 = strong)
  const float GLOW_WIDTH = 0.32;    // thickness of the glow around the crest (smaller = thinner)
  const float GLOW_CREST = 0.2;    // where the crest sits across the track (0 centre .. 1 outer edge)
  // ---- Tyre tread (depth map pressed into the groove) ----
  const float TREAD_DEPTH = 0.035;  // metres the lugs press into the sand (0 = no tread relief)
  const float TREAD_DARK = 0.075;    // extra darkening inside pressed lugs
  const float TREAD_GLOW = 0.45;     // how much of the sun-lit edge shows on the lugs (0..1)
  const float TREAD_ALONG = ${TREAD_ASPECT.toFixed(4)}; // tread tile length / tread width (from the PNG)
  // ---- When a rear wheel drives over a front track: only the side ridges are wiped ----
  const float GROOVE_KEEP_WIPED = 1.0; // 1 = groove + tread fully kept, lower = also fade the groove a bit
  varying vec2 vUv;
  varying vec3 vSide;
  varying vec4 vInfo;
  varying vec3 vExtra;
  varying vec3 vWorld;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  // Groove mask across the ribbon: 1 inside the pressed footprint, 0 outside.
  float grooveMask(float ac, float edge) {
    return 1.0 - smoothstep(edge - 0.14, edge + 0.04, ac);
  }

  // Cross-section height in metres at c in [-1, 1] (0 = wheel centre).
  // A groove pressed into the sand with a ridge of displaced sand on each side.
  // rk = ridge keep (1 = ridges intact, 0 = flattened by a rear wheel). The groove is
  // never scaled by rk, so a wiped track keeps its pressed footprint.
  float profile(float c, float depth, float slip, float edge, float rk) {
    float ac = abs(c);
    float g = grooveMask(ac, edge);
    float ridge = exp(-pow((ac - 0.74) / 0.13, 2.0));
    // more sand is thrown to the side the tyre slides toward
    float amount = (0.030 + 0.055 * depth) * (1.0 + 0.9 * slip * sign(c));
    return -0.050 * depth * g + amount * ridge * (1.0 - g) * rk;
  }

  float treadAt(float c, float tv, float edge) {
    float u = clamp(c / edge * 0.5 + 0.5, 0.0, 1.0);
    return texture2D(uTread, vec2(u, tv)).r;
  }

  // Full surface height: groove + side ridges + the tread pressed into the groove.
  float heightAt(float c, float tv, float depth, float slip, float edge, float rk) {
    float g = grooveMask(abs(c), edge);
    return profile(c, depth, slip, edge, rk) - TREAD_DEPTH * depth * g * treadAt(c, tv, edge);
  }

  void main() {
    float alpha0 = vInfo.x;
    float depth = vInfo.y;
    float kind = vInfo.z;
    float hw = max(vInfo.w, 0.05);
    float slip = vExtra.x;
    float rk = vExtra.z;

    float c = (vUv.x - 0.5) * 2.0;
    float ac = abs(c);
    float outer = 1.0 - smoothstep(0.86, 1.0, ac);

    // Slow wobble of the groove edge along the ribbon, so the track is never ruler-straight.
    float wob = vnoise(vec2(vUv.y * 2.2, vExtra.y * 40.0)) - 0.5;

    if (kind < 0.5) {
      // Rubber on tarmac: flat black mark with a soft, slightly ragged edge.
      float m = 1.0 - smoothstep(0.55 + 0.1 * wob, 0.92, ac);
      float a = alpha0 * m * (0.78 + 0.22 * vnoise(vWorld.xz * 23.0)) * 0.7;
      if (a < 0.004) discard;
      gl_FragColor = vec4(0.014, 0.014, 0.02, a);
      #include <fog_fragment>
      return;
    }

    // ---- Sand: light the little cross-section profile with the sun.
    float edge = 0.52 + wob * 0.07;
    float e = 0.012;
    // Tread depth map across the groove (u) and along the ribbon (v, one tile per TREAD_ALONG widths).
    float tileLen = max(2.0 * edge * hw * TREAD_ALONG, 0.5);
    float tv = vUv.y / tileLen;
    float ev = 0.004;
    float h0 = heightAt(c - e, tv, depth, slip, edge, rk);
    float h1 = heightAt(c + e, tv, depth, slip, edge, rk);
    float hA0 = heightAt(c, tv - ev, depth, slip, edge, rk);
    float hA1 = heightAt(c, tv + ev, depth, slip, edge, rk);
    float sx = (h1 - h0) / (2.0 * e * hw);              // physical slope across the ribbon
    float sy = (hA1 - hA0) / (2.0 * ev * tileLen);      // physical slope along the ribbon

    vec3 sun = normalize(uSun);
    vec3 L = normalize(vSide);                          // across-ribbon axis in world space
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), L));  // along-ribbon axis in world space
    vec3 N = normalize(vec3(0.0, 1.0, 0.0) - sx * L - sy * T);
    float flatLit = max(sun.y, 0.02);
    float tilted = max(dot(N, sun), 0.0);
    float ratio = (uAmb + tilted) / (uAmb + flatLit);   // <1 shaded slope, >1 sun-facing slope

    // Granular clumps on the displaced sand (they go with the ridges when those are wiped).
    float g = grooveMask(ac, edge);
    float grain = vnoise(vWorld.xz * 34.0) - 0.5;
    ratio += grain * 0.16 * (1.0 - g) * depth * rk;

    // Pressed-in sand is compacted and a little darker.
    float tr = treadAt(c, tv, edge);
    float comp = g * (0.14 + 0.24 * depth + TREAD_DARK * tr * depth);

    float darkA = 1.0 - (1.0 - clamp(1.0 - ratio, 0.0, 1.0)) * (1.0 - comp);
    // Lit edge: a soft gradient glow that is strongest on the crest and fades smoothly
    // on both sides (a slope-based highlight, narrowed around the ridge top).
    float crestW = exp(-pow((ac - GLOW_CREST) / GLOW_WIDTH, 2.0));
    float glowW = max(crestW, g * TREAD_GLOW);
    float lightA = clamp(ratio - 1.0, 0.0, 1.0) * GLOW_STRENGTH * glowW;
    float a = clamp(darkA + lightA, 0.0, 0.92) * outer * alpha0;
    // Optional: let a wiped track's groove fade a little too (1.0 = keep it fully).
    a *= mix(1.0, mix(GROOVE_KEEP_WIPED, 1.0, rk), g);
    if (a < 0.004) discard;
    vec3 col = mix(vec3(0.0), uLightCol, lightA / (lightA + darkA + 1e-4));
    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }
`;