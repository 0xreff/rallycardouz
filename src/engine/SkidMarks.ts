import * as THREE from "three";

/**
 * Tyre tracks + skid marks, drawn as one continuous RIBBON per wheel instead of
 * thousands of separate stamps (the old InstancedMesh approach looked broken up
 * at speed because stamps only overlapped when the car crawled).
 *
 * How it works
 *  - Every wheel owns a "slot": a fixed-size ring buffer of quads (one mesh, one
 *    draw call). Each new sample extends the ribbon from the previous sample, so
 *    the trail is gap-free at any speed and follows the ground normal on hills.
 *  - Each quad owns its 4 vertices, so when the ring wraps the oldest quad is
 *    simply overwritten — no seam, no index rewriting, no per-frame allocation.
 *  - Opacity is per-vertex: a mark fades IN when a skid starts, fades OUT when it
 *    ends, and slowly fades with age. `strength` 1 = hard skid, ~0.3 = tread
 *    print left by a rolling tyre on loose ground.
 *  - Only the quad that changed is uploaded to the GPU (addUpdateRange).
 *
 * Sand tracks: a ribbon is textured with a procedural tyre print (a pressed groove with
 * chevron tread blocks, solid shoulders and a ridge of sand pushed up to each side), tinted
 * sand-brown on loose ground and near-black rubber on tarmac. Sand tracks last much longer
 * than skid marks, hold at full strength and then soften as the wind fills them in.
 *
 * Owned by the Game so the marks persist across car swaps. Slots are chosen by
 * the caller: 4 per car (CarFX uses `carSlot * 4 + wheelIndex`).
 */

const MIN_STEP = 0.45;      // metres between samples (smaller = smoother, more quads)
const MAX_JUMP = 6;         // a bigger step is a teleport/respawn → start a new trail
const LIFT = 0.05;          // metres above the ground (along its normal)
const MAX_ALPHA = 0.95;
const LIFE_SAND = 160;      // seconds a track on sand lasts (holds, then softens over the last 55%)
const LIFE_RUBBER = 45;     // seconds a tarmac skid mark lasts
const HOLD_FRAC = 0.45;     // fraction of life left at which the fade-out begins
const FADE_TICK = 0.5;      // fade is refreshed twice a second, not every frame
const DAB_INTERVAL = 0.1;   // seconds between stationary burnout dabs
const DAB_LENGTH = 0.6;     // metres
const TILE = 0.9;           // metres of ground per repeat of the tread texture

// Texture is grey × tint: grooves darken the tint, the side ridges show it at full strength.
const SAND_TINT = new THREE.Color(0.95, 0.52, 0.26);   // compressed rust-brown groove, pale sand ridge
const RUBBER_TINT = new THREE.Color(0.12, 0.12, 0.14); // black rubber

/** Procedural tyre print, one tread repeat tall. RGB = grey (groove dark / ridge white), A = coverage. */
function makeTreadTexture(): THREE.DataTexture {
  const W = 64, H = 128;
  const data = new Uint8Array(W * H * 4);
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      const c = Math.abs(u - 0.5) * 2;                 // 0 at the centre line .. 1 at the edge
      const groove = 1 - ss(0.6, 0.7, c);              // the pressed tyre footprint
      const ph = (v * 3 + c * 0.6) % 1;                // chevron lugs, three per repeat
      const lug = ss(0.05, 0.12, ph) * (1 - ss(0.5, 0.57, ph));
      const block = Math.max(lug, ss(0.4, 0.46, c));   // lugs in the middle, solid shoulders
      const gGrey = 0.15 + 0.12 * (1 - block);         // lugs press deepest, gaps are lighter
      const gAlpha = groove * (0.62 + 0.3 * block);
      const ridge = Math.exp(-Math.pow((c - 0.8) / 0.07, 2)) * 0.38; // sand pushed aside
      const a = gAlpha + ridge * (1 - gAlpha);
      const grey = a > 0 ? (gGrey * gAlpha + 1.0 * ridge * (1 - gAlpha)) / a : 0;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(grey * 255);
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

interface V3 { x: number; y: number; z: number }

class Trail {
  readonly mesh: THREE.Mesh;
  readonly pos: THREE.BufferAttribute;
  readonly col: THREE.BufferAttribute;
  readonly uv: THREE.BufferAttribute;
  readonly born: Float32Array;   // creation time of each quad, -1 = empty
  readonly life: Float32Array;   // lifetime of each quad (s)
  readonly mul: Float32Array;    // fade multiplier currently written for each quad
  readonly a0: Float32Array;     // alpha at the quad's trailing edge
  readonly a1: Float32Array;     // alpha at the quad's leading edge
  head = 0;
  hasLast = false;
  hasEdges = false;
  prevA = 0;
  prevV = 0;           // texture v at the previous sample
  vAcc = 0;            // texture v accumulated along the ribbon
  lastDab = -1;
  readonly last = new THREE.Vector3();
  readonly prevL = new THREE.Vector3();
  readonly prevR = new THREE.Vector3();

  constructor(segments: number, material: THREE.Material) {
    this.pos = new THREE.BufferAttribute(new Float32Array(segments * 4 * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(segments * 4 * 4), 4);
    this.uv = new THREE.BufferAttribute(new Float32Array(segments * 4 * 2), 2);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.uv.setUsage(THREE.DynamicDrawUsage);

    const index = new Uint32Array(segments * 6);
    for (let i = 0; i < segments; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.pos);
    geo.setAttribute("color", this.col);
    geo.setAttribute("uv", this.uv);
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    this.born = new Float32Array(segments).fill(-1);
    this.life = new Float32Array(segments).fill(LIFE_RUBBER);
    this.mul = new Float32Array(segments).fill(1);
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
  private readonly material: THREE.MeshBasicMaterial;
  private readonly tread = makeTreadTexture();
  private time = 0;
  private fadeAcc = 0;

  // scratch (no allocation in the hot path)
  private readonly _n = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _side = new THREE.Vector3();
  private readonly _pl = new THREE.Vector3();
  private readonly _pr = new THREE.Vector3();
  private readonly _cl = new THREE.Vector3();
  private readonly _cr = new THREE.Vector3();
  private readonly _off = new THREE.Vector3();
  private readonly _half = new THREE.Vector3();
  private readonly _e0 = new THREE.Vector3();
  private readonly _e1 = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, slots = 8, private readonly segments = 2000) {
    this.material = new THREE.MeshBasicMaterial({
      map: this.tread,
      vertexColors: true,
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
   * Extend a wheel's ribbon to (p), lying on a surface with normal (n).
   * strength 0..1. A strength of ~0 closes the trail with a fade-out.
   * `sand` = loose ground (sand-brown track that lasts) instead of a tarmac rubber mark.
   */
  addPoint(slot: number, p: V3, n: V3, width: number, strength: number, sand = false) {
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
    const v1 = v0 + dist / TILE;
    this.writeQuad(t, this._pl, this._pr, this._cl, this._cr, a0, a1, sand, v0, v1);

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
  stamp(slot: number, p: V3, n: V3, yaw: number, width: number, strength: number, sand = false) {
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
    t.vAcc = v0 + DAB_LENGTH / TILE;
    this.writeQuad(t, this._pl, this._pr, this._cl, this._cr, a, a, sand, v0, t.vAcc);
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
          for (let v = 0; v < 4; v++) t.col.setW(b + v, 0);
        } else {
          t.mul[i] = m;
          const w0 = t.a0[i] * m * MAX_ALPHA;
          const w1 = t.a1[i] * m * MAX_ALPHA;
          t.col.setW(b, w0);
          t.col.setW(b + 1, w0);
          t.col.setW(b + 2, w1);
          t.col.setW(b + 3, w1);
        }
        dirty = true;
      }
      if (dirty) {
        t.col.addUpdateRange(0, t.col.array.length);
        t.col.needsUpdate = true;
      }
    }
  }

  clear() {
    for (const t of this.trails) {
      t.pos.array.fill(0);
      t.col.array.fill(0);
      t.uv.array.fill(0);
      t.born.fill(-1);
      t.mul.fill(1);
      t.vAcc = 0;
      t.prevV = 0;
      t.head = 0;
      t.hasLast = false;
      t.hasEdges = false;
      t.pos.needsUpdate = true;
      t.col.needsUpdate = true;
      t.uv.needsUpdate = true;
    }
  }

  dispose() {
    for (const t of this.trails) {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    this.material.dispose();
    this.tread.dispose();
    this.trails.length = 0;
  }

  // ------------------------------------------------------------- internals

  private setNormal(n: V3) {
    this._n.set(n.x, n.y, n.z);
    if (this._n.lengthSq() < 1e-6) this._n.set(0, 1, 0);
    this._n.normalize();
  }

  /** Left/right edge points of the ribbon at `p`, lifted off the surface. */
  private edges(p: V3, dir: THREE.Vector3, width: number, outL: THREE.Vector3, outR: THREE.Vector3) {
    this._side.crossVectors(this._n, dir);
    if (this._side.lengthSq() < 1e-8) this._side.set(1, 0, 0);
    this._side.normalize().multiplyScalar(width * 0.5);
    this._off.copy(this._n).multiplyScalar(LIFT);
    outL.set(p.x, p.y, p.z).add(this._side).add(this._off);
    outR.set(p.x, p.y, p.z).sub(this._side).add(this._off);
  }

  private writeQuad(
    t: Trail,
    pl: THREE.Vector3, pr: THREE.Vector3,
    cl: THREE.Vector3, cr: THREE.Vector3,
    a0: number, a1: number,
    sand: boolean, v0: number, v1: number
  ) {
    const i = t.head;
    const b = i * 4;
    t.pos.setXYZ(b, pl.x, pl.y, pl.z);
    t.pos.setXYZ(b + 1, pr.x, pr.y, pr.z);
    t.pos.setXYZ(b + 2, cl.x, cl.y, cl.z);
    t.pos.setXYZ(b + 3, cr.x, cr.y, cr.z);

    t.uv.setXY(b, 0, v0);
    t.uv.setXY(b + 1, 1, v0);
    t.uv.setXY(b + 2, 0, v1);
    t.uv.setXY(b + 3, 1, v1);

    const w0 = a0 * MAX_ALPHA;
    const w1 = a1 * MAX_ALPHA;
    const { r, g, b: bl } = sand ? SAND_TINT : RUBBER_TINT;
    t.col.setXYZW(b, r, g, bl, w0);
    t.col.setXYZW(b + 1, r, g, bl, w0);
    t.col.setXYZW(b + 2, r, g, bl, w1);
    t.col.setXYZW(b + 3, r, g, bl, w1);

    t.born[i] = this.time;
    t.life[i] = sand ? LIFE_SAND : LIFE_RUBBER;
    t.mul[i] = 1;
    t.a0[i] = a0;
    t.a1[i] = a1;
    t.head = (i + 1) % this.segments;

    t.pos.addUpdateRange(b * 3, 12);
    t.pos.needsUpdate = true;
    t.col.addUpdateRange(b * 4, 16);
    t.col.needsUpdate = true;
    t.uv.addUpdateRange(b * 2, 8);
    t.uv.needsUpdate = true;
  }
}
