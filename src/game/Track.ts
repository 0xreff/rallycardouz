import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../physics/Physics";
import { createRimMaterial } from "../engine/RimMaterial";
import { SurfaceMap } from "./Surfaces";

/**
 * A HUGE open-world DESERT rally course made of nothing but sand:
 *
 *   1. DUNES: wind-driven sand dunes with a gentle windward slope and a steeper slip
 *      face, sinuous crests and a slow rolling swell under them. The same dune field is
 *      simply carried on across a map MAP_SCALE (10) times bigger than the old one, and
 *      eases down to flat sand at the map edge where the ground carries on to the horizon.
 *      The visual mesh is cut into chunks (so the GPU can cull it) and the physics collider
 *      is ONE heightfield built from the same height grid with the same triangulation, so
 *      the surface the car drives on is exactly the surface you see.
 *   2. SAND ROADS (no tarmac, no curbs): closed loops carved into the dunes as a flat,
 *      packed-sand corridor. Both sides are walled by sand banks of DIFFERENT heights: a tall
 *      wall on one side and a low berm on the other, each swelling and shrinking along the
 *      road so the difference is easy to see from the driver's seat.
 *   3. JUMP RAMPS (gap jump, tabletop, kickers), each on a levelled pad, and a few cones.
 *
 * The map edge is closed by invisible walls (colliders only). Every collider is registered
 * in the SurfaceMap: the sand (dunes, roads and banks alike) is DIRT (loose: less grip, dust
 * trails, tyre tracks), the ramps are TARMAC (full grip). Handling is unchanged.
 */

const MAP_SCALE = 10;           // the map is this many times bigger than the original 700 m
const MAP = 700 * MAP_SCALE;    // ground span (m)
const HALF = MAP / 2;
const SEG = 1280;               // terrain grid resolution (SEG x SEG cells, ~5.5 m like before)
const CHUNK = 64;               // cells per visual chunk side (SEG must be a multiple)

// The course starts here; the terrain is flattened into a pad around this point.
const SPAWN_XZ = new THREE.Vector2(-200, -170);

// --- Look & shape tuning -----------------------------------------------------
const WIND_YAW = 0.02;      // rad: dune crests run perpendicular to this heading
const DUNE_LAMBDA = 218;    // m between crests
const DUNE_CREST = 0.78;    // fraction of a wavelength spent climbing the windward side
const ROAD_HALF_W = 11;     // sand road half-width (flat packed floor)
const ROAD_SHOULDER = 6;    // sand is levelled flat to the road this far beyond its edge...
const ROAD_BLEND_FAR = 42;  // ...and blends back to full dunes by here
const ROAD_SPACING = 6;     // m between road centreline samples
const BANK_RISE = [1, 9];   // bank climbs from the road edge over these distances (m)
const BANK_FALL = [13, 31]; // ...and falls back to the ground between these (m)
const HASH_CELL = 128;      // road spatial-hash cell (m); must exceed ROAD_HALF_W + ROAD_BLEND_FAR

interface Pad { x: number; z: number; r: number; h: number }

/** One closed sand road. */
interface Road {
  pts: Float32Array;               // x,z pairs of the centreline
  y: Float32Array;                 // smoothed height profile along it
  n: number;                       // sample count (the loop is closed)
  tallLeft: boolean;               // which side gets the tall sand wall
  tall: [number, number, number, number]; // amp, swell1, swell2, phase of the tall wall
  low: [number, number, number, number];  // same for the low berm
  m: [number, number];             // whole number of wall swells around the loop (keeps the loop seamless)
  hash: Map<number, number[]>;     // spatial hash: cell -> sample indices
}

const sstep = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(x, a, b);
const hashKey = (ix: number, iz: number) => (ix + 128) * 512 + (iz + 128);

export class Track {
  readonly spawn = new THREE.Vector3(SPAWN_XZ.x, 2, SPAWN_XZ.y);

  /**
   * One chunk of the desert floor. The terrain is cut into many chunks that ALL share
   * `terrainMaterial`, so anything applied to `terrain.material` (the wind-ripple shader)
   * covers the whole map.
   */
  terrain!: THREE.Mesh;
  readonly terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0.0 });
  private readonly terrainGroup = new THREE.Group();

  // Collider-handle → surface registry: cars query this to know what each wheel
  // is rolling on (sand terrain slides and kicks up dust; ramps grip).
  readonly surfaces = new SurfaceMap();

  // Dynamic props (cones) whose meshes follow physics each frame.
  private props: { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] = [];

  // Sand roads (centreline + height profile + spatial hash), built before the terrain.
  private roads: Road[] = [];
  private pads: Pad[] = [];
  private padsReady = false;

  // Scratch results of the last sample()/nearRoad() call (avoids millions of allocations).
  private hit = { d: 0, y: 0, k: 0, lat: 0, road: null as Road | null };
  private sw = 1;   // dune weight of the last sample: 0 on the road corridor → 1 in the open dunes
  private sm = 0;   // road-floor mask of the last sample: 1 on the packed road → 0 off it

  private warm = new THREE.Color(1.0, 0.72, 0.42); // sun-warmed rim light on props

  private mat = {
    ramp: createRimMaterial({ color: 0x55505c, metalness: 0.45, roughness: 0.55, rimColor: this.warm, rimStrength: 0.4 }),
    cone: createRimMaterial({ color: 0xff5a1e, metalness: 0.2, roughness: 0.5, rimColor: this.warm, rimStrength: 0.4 }),
  };

  constructor(private physics: Physics, private scene: THREE.Scene) {
    this.prepareRoads();
    this.preparePads();
    this.buildTerrain();
    this.buildRamps();
    this.buildPerimeter();
  }

  // -------------------------------------------------------------- terrain

  /** Raw sand dunes at a world (x,z), before the sand roads and ramp pads. */
  private baseHeight(x: number, z: number): number {
    const d = Math.hypot(x - SPAWN_XZ.x, z - SPAWN_XZ.y);
    const flat = sstep(d, 26, 90); // 0 on the spawn pad → 1 in the dunes

    // Wind-aligned coordinates: u runs along the wind, v across it.
    const c = Math.cos(WIND_YAW), s = Math.sin(WIND_YAW);
    const u = x * c + z * s;
    const v = -x * s + z * c;

    // Sinuous crests: bend the phase with a few slow lateral waves.
    const warp = 14 * Math.sin(v * 0.012 + 1.3) + 7 * Math.sin(v * 0.031 + 0.4) + 5 * Math.sin(u * 0.008);
    const ph = (u + warp) / DUNE_LAMBDA;
    const f = ph - Math.floor(ph); // sawtooth 0..1 across one dune

    // Asymmetric profile: long gentle windward rise, short steep slip face behind the crest.
    let p: number;
    if (f < DUNE_CREST) {
      p = Math.pow(f / DUNE_CREST, 1.6);
    } else {
      p = Math.pow(1 - (f - DUNE_CREST) / (1 - DUNE_CREST), 1.3);
    }

    // Dune height varies slowly across the map (big dunes here, low sand sheets there).
    const amp = 2.6 + 4.6 * (0.5 + 0.5 * Math.sin(u * 0.0047 + v * 0.0031 + 0.8));

    // Slow rolling swell underneath so the whole map is not made of one repeating shape.
    const swell =
      5.0 * Math.cos(x * 0.011 + 0.7) * Math.cos(z * 0.0135) +
      2.2 * Math.cos(x * 0.03) * Math.cos(z * 0.026 + 1.0);

    // Ease the dunes down to flat sand at the map edge so the ground meets the endless
    // sand plane beyond it with no step.
    const edge = 1 - sstep(Math.max(Math.abs(x), Math.abs(z)), 295 * MAP_SCALE, 345 * MAP_SCALE);

    return (amp * p + swell) * flat * edge;
  }

  /**
   * Nearest sand road to a world (x,z). Fills `this.hit` with the distance to its centreline,
   * the road height there, the fractional sample index along the road, and the signed
   * lateral offset (+ = left of the driving direction). Returns false if no road is near.
   */
  private nearRoad(x: number, z: number): boolean {
    const hit = this.hit;
    hit.d = Infinity;
    hit.road = null;
    const ix = Math.floor(x / HASH_CELL), iz = Math.floor(z / HASH_CELL);
    for (const road of this.roads) {
      const P = road.pts, Y = road.y, N = road.n;
      let best = Infinity, bk = -1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = road.hash.get(hashKey(ix + dx, iz + dz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const k = list[i];
            const ex = P[2 * k] - x, ez = P[2 * k + 1] - z;
            const dd = ex * ex + ez * ez;
            if (dd < best) { best = dd; bk = k; }
          }
        }
      }
      if (bk < 0) continue;
      // Refine on the two segments touching the nearest sample.
      for (let m = 0; m < 2; m++) {
        const a = (bk - 1 + m + N) % N, b = (a + 1) % N;
        const ax = P[2 * a], az = P[2 * a + 1], bx = P[2 * b], bz = P[2 * b + 1];
        const ex = bx - ax, ez = bz - az;
        const len2 = ex * ex + ez * ez || 1;
        const t = THREE.MathUtils.clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
        const cx = ax + ex * t, cz = az + ez * t;
        const d = Math.hypot(cx - x, cz - z);
        if (d < hit.d) {
          hit.d = d;
          hit.y = Y[a] + (Y[b] - Y[a]) * t;
          hit.k = a + t;
          // left of travel = up × tangent = (tz, -tx)
          hit.lat = ((x - cx) * ez - (z - cz) * ex) / Math.sqrt(len2);
          hit.road = road;
        }
      }
    }
    return hit.road !== null;
  }

  /** Height of one bank (tall wall or low berm) beside a road at sample index k. */
  private bankHeight(road: Road, k: number, tall: boolean): number {
    const p = tall ? road.tall : road.low;
    const th = (2 * Math.PI * k) / road.n; // periodic along the closed loop → no seam
    return p[0] + p[1] * Math.sin(road.m[0] * th + p[3]) + p[2] * Math.sin(road.m[1] * th + p[3] * 1.7);
  }

  /**
   * Ground height at a world (x,z): dunes, with the sand roads cut and filled in and their
   * left/right banks raised on top. No ramp pads. Also sets `this.sw` and `this.sm`.
   */
  private sample(x: number, z: number): number {
    const b = this.baseHeight(x, z);
    if (!this.nearRoad(x, z)) { this.sw = 1; this.sm = 0; return b; }
    const hit = this.hit, road = hit.road!;
    const e = hit.d - ROAD_HALF_W; // distance beyond the road edge (negative on the road)
    const w = sstep(hit.d, ROAD_HALF_W + ROAD_SHOULDER, ROAD_HALF_W + ROAD_BLEND_FAR);
    this.sw = w;
    this.sm = 1 - sstep(e, -2, 3);
    let h = hit.y * (1 - w) + b * w;
    const prof = sstep(e, BANK_RISE[0], BANK_RISE[1]) * (1 - sstep(e, BANK_FALL[0], BANK_FALL[1]));
    if (prof > 0) h += prof * this.bankHeight(road, hit.k, hit.lat > 0 === road.tallLeft);
    return h;
  }

  /** Final terrain height at a world (x,z): dunes + sand roads/banks + levelled ramp pads. */
  private terrainHeight(x: number, z: number): number {
    const h = this.sample(x, z);
    const w = this.sw;
    if (!this.padsReady) return h;
    let out = h;
    for (const p of this.pads) {
      const dd = Math.hypot(x - p.x, z - p.z);
      if (dd >= p.r + 20) continue;
      const pw = (1 - sstep(dd, p.r, p.r + 20)) * w; // never touch the road itself
      out = out * (1 - pw) + p.h * pw;
    }
    return out;
  }

  /** Closed loop of control points around (cx,cz), starting at angle phi0, going `dir` (±1) around. */
  private static loopCtrl(cx: number, cz: number, r0: number, a1: number, a2: number, ph: number, dir: number, phi0: number) {
    const pts: [number, number][] = [];
    const K = 16;
    for (let k = 0; k < K; k++) {
      const phi = phi0 + (dir * 2 * Math.PI * k) / K;
      const away = Math.abs(THREE.MathUtils.euclideanModulo(phi - phi0 + Math.PI, 2 * Math.PI) - Math.PI);
      const wob = sstep(away, 0.45, 1.2); // calm around the start so the first straight is clean
      const r = r0 + wob * (a1 * Math.sin(3 * phi + ph) + a2 * Math.sin(5 * phi + 2 * ph));
      pts.push([cx + r * Math.cos(phi), cz + r * Math.sin(phi)]);
    }
    return pts;
  }

  /**
   * The sand roads: closed Catmull-Rom loops with a gently smoothed height profile.
   *   A: the big west loop. It passes exactly through the spawn, heading +Z; the TALL wall is
   *      on the left, the low berm on the right.
   *   B: the east loop, which has the tall wall on the RIGHT instead.
   */
  private prepareRoads() {
    const defs: { ctrl: [number, number][]; tallLeft: boolean; tall: Road["tall"]; low: Road["low"] }[] = [
      {
        ctrl: Track.loopCtrl(SPAWN_XZ.x - 1350, SPAWN_XZ.y, 1350, 150, 70, 0.7, +1, 0),
        tallLeft: true,
        tall: [5.6, 1.6, 0.9, 0.5],
        low: [1.9, 0.6, 0.3, 2.0],
      },
      {
        ctrl: Track.loopCtrl(1700, 0, 1150, 130, 60, 2.1, -1, Math.PI),
        tallLeft: false,
        tall: [6.2, 1.8, 1.0, 1.4],
        low: [2.2, 0.7, 0.35, 0.3],
      },
    ];

    for (const def of defs) {
      const curve = new THREE.CatmullRomCurve3(
        def.ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)),
        true,
        "catmullrom",
        0.5
      );
      const len = curve.getLength();
      const N = Math.ceil(len / ROAD_SPACING);
      const sp = curve.getSpacedPoints(N); // sp[N] == sp[0]
      const pts = new Float32Array(N * 2);
      const raw = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        pts[2 * k] = sp[k].x;
        pts[2 * k + 1] = sp[k].z;
        raw[k] = this.baseHeight(sp[k].x, sp[k].z);
      }
      // Moving average over +-5 samples (~60 m): keeps about half of each dune's height,
      // so the road rolls over the dunes instead of cutting dead flat through them.
      const y = new Float32Array(N);
      const W = 5;
      for (let k = 0; k < N; k++) {
        let sum = 0;
        for (let j = -W; j <= W; j++) sum += raw[(k + j + N) % N];
        y[k] = sum / (2 * W + 1);
      }
      const hash = new Map<number, number[]>();
      for (let k = 0; k < N; k++) {
        const key = hashKey(Math.floor(pts[2 * k] / HASH_CELL), Math.floor(pts[2 * k + 1] / HASH_CELL));
        let list = hash.get(key);
        if (!list) hash.set(key, (list = []));
        list.push(k);
      }
      this.roads.push({
        pts, y, n: N, hash,
        tallLeft: def.tallLeft, tall: def.tall, low: def.low,
        m: [Math.max(2, Math.round(len / 450)), Math.max(3, Math.round(len / 150))],
      });
    }
  }

  /** Levelled circles under the ramps, so dunes never poke through them. */
  private preparePads() {
    const spots: [number, number, number][] = [
      [40, -210, 17], [40, -164, 17], // gap jump: launch + landing
      [230, 10, 24],                  // tabletop
      [-180, 150, 12], [-166, 150, 12], [-152, 150, 12], [-138, 150, 12], // kickers
    ];
    this.pads = spots.map(([x, z, r]) => ({ x, z, r, h: this.sample(x, z) }));
    this.padsReady = true;
  }

  private static readonly SAND_LOW = new THREE.Color(0xb4602f);
  private static readonly SAND_MID = new THREE.Color(0xd98a45);
  private static readonly SAND_HIGH = new THREE.Color(0xf0b878);
  private static readonly SAND_PACKED = new THREE.Color(0x8a5a38); // the trodden road floor

  /** Sand colour for a given ground height (used by the terrain and the far ground). */
  private sandColor(y: number, out: THREE.Color): THREE.Color {
    const t = THREE.MathUtils.clamp((y + 6) / 20, 0, 1);
    if (t < 0.5) return out.copy(Track.SAND_LOW).lerp(Track.SAND_MID, t * 2);
    return out.copy(Track.SAND_MID).lerp(Track.SAND_HIGH, (t - 0.5) * 2);
  }

  /**
   * Build the dune terrain. One shared height grid feeds BOTH the visual chunks and a single
   * heightfield collider with the same triangulation, so the surface the car drives on is
   * guaranteed to be the surface you see.
   */
  private buildTerrain() {
    const R = this.physics.rapier;
    const n = SEG;
    const stride = n + 1;
    const cell = MAP / n;

    // 1. Height + road-floor mask grid (rows → z, cols → x).
    const hs = new Float32Array(stride * stride);
    const mk = new Float32Array(stride * stride);
    for (let i = 0; i <= n; i++) {
      const z = (i / n - 0.5) * MAP;
      for (let j = 0; j <= n; j++) {
        const x = (j / n - 0.5) * MAP;
        const v = i * stride + j;
        hs[v] = this.terrainHeight(x, z);
        mk[v] = this.sm; // set by the sample() call inside terrainHeight
      }
    }

    // 2. Visual chunks. Normals come from the global grid (central differences), so the
    //    lighting is seamless across chunk borders.
    const tmp = new THREE.Color();
    const cs = CHUNK + 1;
    const idx = new Uint16Array(CHUNK * CHUNK * 6);
    let q = 0;
    for (let i = 0; i < CHUNK; i++) {
      for (let j = 0; j < CHUNK; j++) {
        const a = i * cs + j, b = a + 1, c = a + cs, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    const idxAttr = new THREE.BufferAttribute(idx, 1);

    const chunks = n / CHUNK;
    for (let ci = 0; ci < chunks; ci++) {
      for (let cj = 0; cj < chunks; cj++) {
        const pos = new Float32Array(cs * cs * 3);
        const nrm = new Float32Array(cs * cs * 3);
        const col = new Float32Array(cs * cs * 3);
        for (let i = 0; i < cs; i++) {
          const gi = ci * CHUNK + i;
          for (let j = 0; j < cs; j++) {
            const gj = cj * CHUNK + j;
            const g = gi * stride + gj;
            const o = (i * cs + j) * 3;
            pos[o] = (gj / n - 0.5) * MAP;
            pos[o + 1] = hs[g];
            pos[o + 2] = (gi / n - 0.5) * MAP;

            const hL = hs[gi * stride + Math.max(gj - 1, 0)], hR = hs[gi * stride + Math.min(gj + 1, n)];
            const hU = hs[Math.max(gi - 1, 0) * stride + gj], hD = hs[Math.min(gi + 1, n) * stride + gj];
            const nx = (hL - hR) / (2 * cell), nz = (hU - hD) / (2 * cell);
            const il = 1 / Math.hypot(nx, 1, nz);
            nrm[o] = nx * il; nrm[o + 1] = il; nrm[o + 2] = nz * il;

            // One smooth gradient with height (rust in the hollows, orange mid-slopes, pale
            // gold on the crests: the tall bank reads paler than the low one), darkened on
            // the packed road floor so the road is easy to follow.
            this.sandColor(hs[g], tmp);
            if (mk[g] > 0) tmp.lerp(Track.SAND_PACKED, mk[g] * 0.6);
            col[o] = tmp.r; col[o + 1] = tmp.g; col[o + 2] = tmp.b;
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        geo.setIndex(idxAttr);
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        const mesh = new THREE.Mesh(geo, this.terrainMaterial);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        this.terrainGroup.add(mesh);
        if (!this.terrain) this.terrain = mesh;
      }
    }
    this.scene.add(this.terrainGroup);

    // 3. One heightfield collider (column-major: heights[row + col * (n + 1)], rows → z, cols → x).
    const heights = new Float32Array(stride * stride);
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) heights[r + c * stride] = hs[r * stride + c];
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    const terrainCol = this.physics.world.createCollider(
      R.ColliderDesc.heightfield(n, n, heights, { x: MAP, y: 1, z: MAP }).setFriction(1.6),
      body
    );
    this.surfaces.register(terrainCol.handle, "dirt");

    // Endless sand beyond the map edge: four big flat strips around the terrain (a single
    // plane would cover the dune hollows), same colour and material as the sand at the edge.
    const farMat = new THREE.MeshStandardMaterial({ color: this.sandColor(0, new THREE.Color()), roughness: 0.97, metalness: 0 });
    const FAR = HALF + 3000;
    const strip = (x0: number, x1: number, z0: number, z1: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), farMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    strip(-FAR, FAR, HALF, FAR);          // north
    strip(-FAR, FAR, -FAR, -HALF);        // south
    strip(-FAR, -HALF, -HALF, HALF);      // west
    strip(HALF, FAR, -HALF, HALF);        // east
  }

  // ---------------------------------------------------------------- ramps

  /** Inclined ramp rising toward +Z, yawed about Y, sitting on terrain at baseY. */
  private ramp(pos: THREE.Vector3, w: number, h: number, len: number, yaw = 0, baseY = 0) {
    const R = this.physics.rapier;
    const angle = Math.atan2(h, len);
    const rampLen = Math.hypot(h, len);
    const quat = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, yaw, 0))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -angle));

    const y = baseY + h / 2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, rampLen), this.mat.ramp);
    mesh.position.set(pos.x, y, pos.z);
    mesh.quaternion.copy(quat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(pos.x, y, pos.z).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
    );
    const col = this.physics.world.createCollider(R.ColliderDesc.cuboid(w / 2, 0.2, rampLen / 2).setFriction(2.0), body);
    this.surfaces.register(col.handle, "tarmac");
  }

  /** Flat-topped static box (used as a tabletop deck), sitting on terrain at baseY. */
  private deck(cx: number, cz: number, w: number, h: number, len: number, baseY: number) {
    const R = this.physics.rapier;
    const y = baseY + h - 0.2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, len), this.mat.ramp);
    mesh.position.set(cx, y, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(cx, y, cz));
    const col = this.physics.world.createCollider(R.ColliderDesc.cuboid(w / 2, 0.2, len / 2).setFriction(2.0), body);
    this.surfaces.register(col.handle, "tarmac");
  }

  /** Knockable traffic cone (light dynamic body) standing on the terrain. */
  private cone(x: number, z: number) {
    const R = this.physics.rapier;
    const h = 0.9;
    const r = 0.32;
    const baseY = this.terrainHeight(x, z);
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, 12), this.mat.cone);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, baseY + h / 2, z).setLinearDamping(0.5).setAngularDamping(0.8)
    );
    const col = this.physics.world.createCollider(R.ColliderDesc.cone(h / 2, r).setMass(0.3).setFriction(0.7), body);
    this.surfaces.register(col.handle, "tarmac"); // riding over a cone shouldn't dust
    this.props.push({ mesh, body });
  }

  /** Jump features dropped onto the (levelled) terrain along the course. */
  private buildRamps() {
    // Gap jump: launch ramp, an open gap, then a down-slope to land on.
    const g = new THREE.Vector2(40, -210);
    this.ramp(new THREE.Vector3(g.x, 0, g.y), 16, 6, 20, 0, this.terrainHeight(g.x, g.y));
    this.ramp(new THREE.Vector3(g.x, 0, g.y + 46), 22, 5, 18, Math.PI, this.terrainHeight(g.x, g.y + 46));

    // Tabletop: up ramp · flat deck · down ramp.
    const t = new THREE.Vector2(230, 10);
    const by = this.terrainHeight(t.x, t.y);
    this.ramp(new THREE.Vector3(t.x, 0, t.y - 17), 13, 3.5, 13, 0, by);
    this.deck(t.x, t.y, 13, 3.5, 14, by);
    this.ramp(new THREE.Vector3(t.x, 0, t.y + 17), 13, 3.5, 13, Math.PI, by);

    // A rhythm line of kickers.
    for (let i = 0; i < 4; i++) {
      const x = -180 + i * 14;
      const z = 150;
      this.ramp(new THREE.Vector3(x, 0, z), 9, 2.2, 10, 0, this.terrainHeight(x, z));
    }

    // Cone gates marking a couple of the sharper curves.
    const gates: [number, number][] = [
      [145, -45], [205, -25], [85, 45], [105, 30],
    ];
    for (const [x, z] of gates) this.cone(x, z);
  }

  // ------------------------------------------------------------- perimeter

  /** Invisible boundary walls (colliders only) so cars can't drive off the world. */
  private buildPerimeter() {
    const R = this.physics.rapier;
    const h = 40;
    const yC = 15; // spans -5..35, comfortably covering the dunes
    const edges: [number, number, number, number][] = [
      [0, HALF, MAP, 2],
      [0, -HALF, MAP, 2],
      [HALF, 0, 2, MAP],
      [-HALF, 0, 2, MAP],
    ];
    for (const [x, z, dw, dd] of edges) {
      const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, yC, z));
      const col = this.physics.world.createCollider(R.ColliderDesc.cuboid(dw / 2, h / 2, dd / 2), body);
      this.surfaces.register(col.handle, "wall");
    }
  }

  /**
   * Hide terrain chunks that lie entirely beyond `maxDist` (horizontal distance) from
   * the camera. Past the fog's far distance a chunk is drawn fully fog-coloured, so it
   * costs triangles and shows nothing. Call every few frames; pass Infinity to show all.
   */
  cullFarChunks(camX: number, camZ: number, maxDist: number) {
    for (const obj of this.terrainGroup.children) {
      const sphere = (obj as THREE.Mesh).geometry.boundingSphere;
      if (!sphere) continue;
      const dx = sphere.center.x - camX;
      const dz = sphere.center.z - camZ;
      const reach = maxDist + sphere.radius;
      obj.visible = dx * dx + dz * dz < reach * reach;
    }
  }

  /** Sync dynamic-prop meshes (cones) to their physics bodies. Once per frame. */
  syncProps() {
    for (const { mesh, body } of this.props) {
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}