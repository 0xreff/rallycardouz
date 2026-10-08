import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../physics/Physics";
import { createRimMaterial } from "../engine/RimMaterial";
import { SurfaceMap } from "./Surfaces";

/**
 * A large open-world DESERT rally course made of nothing but sand:
 *
 *   1. DUNES: wind-driven sand dunes with a gentle windward slope and a steeper slip
 *      face, sinuous crests and a slow rolling swell under them. The dunes ease down to
 *      flat sand at the map edge, where the ground carries on to the horizon. The mesh and
 *      its physics collider are built from one shared vertex/index buffer (a trimesh), so
 *      the surface the car drives on is exactly the surface you see.
 *   2. A winding CURVED road: a closed Catmull-Rom loop laid over the sand as a trimesh
 *      ribbon with low curbs. The dunes are CUT AND FILLED along it (a smoothed height
 *      profile, flat across the road) so the road never gets buried or floats, but it
 *      still rolls gently so the car can get light.
 *   3. JUMP RAMPS along the course (gap jump, tabletop, kickers), each on a levelled pad.
 *
 * The map edge is closed by invisible walls (colliders only). Every collider is
 * registered in the SurfaceMap with a surface type: the sand is DIRT (loose: less grip,
 * dust trails, tyre tracks), the road/curbs/ramps are TARMAC (full grip). Handling is
 * unchanged from the old map.
 */

const MAP = 700; // ground span
const HALF = MAP / 2;
const SEG = 128; // terrain grid resolution (SEG x SEG cells, ~5.5 m)

// The course starts here; the terrain is flattened into a pad around this point.
const SPAWN_XZ = new THREE.Vector2(-200, -170);

// --- Look & shape tuning -----------------------------------------------------
const WIND_YAW = 0.42;      // rad: dune crests run perpendicular to this heading
const DUNE_LAMBDA = 118;    // m between crests
const DUNE_CREST = 0.78;    // fraction of a wavelength spent climbing the windward side
const ROAD_HALF_W = 9;      // road half-width
const ROAD_BLEND_NEAR = 3;  // sand is levelled flat to the road this far beyond its edge...
const ROAD_BLEND_FAR = 32;  // ...and blends back to full dunes by here

interface Pad { x: number; z: number; r: number; h: number }

const sstep = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(x, a, b);

export class Track {
  readonly spawn = new THREE.Vector3(SPAWN_XZ.x, 2, SPAWN_XZ.y);

  /** The desert floor mesh (the Game adds the wind-ripple shader to its material). */
  terrain!: THREE.Mesh;

  // Collider-handle → surface registry: cars query this to know what each wheel
  // is rolling on (tarmac road grips; sand terrain slides and kicks up dust).
  readonly surfaces = new SurfaceMap();

  // Dynamic props (cones) whose meshes follow physics each frame.
  private props: { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] = [];

  // Road centreline (x,z pairs) and its smoothed height profile, built before the terrain.
  private roadPts!: Float32Array;
  private roadY!: Float32Array;
  private roadN = 0;
  private pads: Pad[] = [];
  private padsReady = false;

  private warm = new THREE.Color(1.0, 0.72, 0.42); // sun-warmed rim light on props

  private mat = {
    ramp: createRimMaterial({ color: 0x55505c, metalness: 0.45, roughness: 0.55, rimColor: this.warm, rimStrength: 0.4 }),
    road: new THREE.MeshStandardMaterial({ color: 0x51443d, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide }),
    curb: createRimMaterial({ color: 0xcdbfa3, metalness: 0.0, roughness: 0.85, rimColor: this.warm, rimStrength: 0.25 }),
    cone: createRimMaterial({ color: 0xff5a1e, metalness: 0.2, roughness: 0.5, rimColor: this.warm, rimStrength: 0.4 }),
  };

  constructor(private physics: Physics, private scene: THREE.Scene) {
    this.prepareRoad();
    this.preparePads();
    this.buildTerrain();
    this.buildRoad();
    this.buildRamps();
    this.buildPerimeter();
  }

  // -------------------------------------------------------------- terrain

  /** Raw sand dunes at a world (x,z), before the road corridor and ramp pads. */
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
    const edge = 1 - sstep(Math.max(Math.abs(x), Math.abs(z)), 295, 345);

    return (amp * p + swell) * flat * edge;
  }

  /** Nearest point on the road centreline: distance and the road's height there. */
  private nearRoad(x: number, z: number): { d: number; y: number } {
    const P = this.roadPts, Y = this.roadY, N = this.roadN;
    let best = Infinity, bk = 0;
    for (let k = 0; k < N; k++) {
      const dx = P[2 * k] - x, dz = P[2 * k + 1] - z;
      const dd = dx * dx + dz * dz;
      if (dd < best) { best = dd; bk = k; }
    }
    let bd = Infinity, by = Y[bk];
    for (let m = 0; m < 2; m++) {
      const a = (bk - 1 + m + N) % N, b = (a + 1) % N;
      const ax = P[2 * a], az = P[2 * a + 1], bx = P[2 * b], bz = P[2 * b + 1];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez || 1;
      const t = THREE.MathUtils.clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
      const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
      if (d < bd) { bd = d; by = Y[a] + (Y[b] - Y[a]) * t; }
    }
    return { d: bd, y: by };
  }

  /** Height with the road corridor levelled in, but without ramp pads. */
  private heightWithRoad(x: number, z: number): { h: number; w: number } {
    const b = this.baseHeight(x, z);
    const r = this.nearRoad(x, z);
    const w = sstep(r.d, ROAD_HALF_W + ROAD_BLEND_NEAR, ROAD_HALF_W + ROAD_BLEND_FAR); // 0 on the road → 1 in the dunes
    return { h: r.y * (1 - w) + b * w, w };
  }

  /** Final terrain height at a world (x,z): dunes + road corridor + levelled ramp pads. */
  private terrainHeight(x: number, z: number): number {
    const { h, w } = this.heightWithRoad(x, z);
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

  /** Centreline of the road (closed loop) and a gently smoothed height profile along it. */
  private prepareRoad() {
    const ctrl: [number, number][] = [
      [SPAWN_XZ.x, SPAWN_XZ.y],
      [-70, -250],
      [130, -220],
      [250, -90],
      [200, 70],
      [250, 220],
      [70, 250],
      [-110, 200],
      [-250, 120],
      [-280, -40],
    ];
    const curve = new THREE.CatmullRomCurve3(
      ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      "catmullrom",
      0.5
    );
    const N = 320;
    const pts = curve.getSpacedPoints(N); // pts[N] == pts[0]
    this.roadN = N;
    this.roadPts = new Float32Array(N * 2);
    const raw = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      this.roadPts[2 * k] = pts[k].x;
      this.roadPts[2 * k + 1] = pts[k].z;
      raw[k] = this.baseHeight(pts[k].x, pts[k].z);
    }
    // Moving average over +-5 samples (~65 m): keeps about half of each dune's height,
    // so the road rolls over the dunes instead of cutting dead flat through them.
    this.roadY = new Float32Array(N);
    const W = 5;
    for (let k = 0; k < N; k++) {
      let sum = 0;
      for (let j = -W; j <= W; j++) sum += raw[(k + j + N) % N];
      this.roadY[k] = sum / (2 * W + 1);
    }
  }

  /** Levelled circles under the ramps, so dunes never poke through them. */
  private preparePads() {
    const spots: [number, number, number][] = [
      [40, -210, 17], [40, -164, 17], // gap jump: launch + landing
      [230, 10, 24],                  // tabletop
      [-180, 150, 12], [-166, 150, 12], [-152, 150, 12], [-138, 150, 12], // kickers
    ];
    this.pads = spots.map(([x, z, r]) => ({ x, z, r, h: this.heightWithRoad(x, z).h }));
    this.padsReady = true;
  }

  private static readonly SAND_LOW = new THREE.Color(0xb4602f);
  private static readonly SAND_MID = new THREE.Color(0xd98a45);
  private static readonly SAND_HIGH = new THREE.Color(0xf0b878);

  /** Sand colour for a given ground height (used by the terrain and the far ground). */
  private sandColor(y: number, out: THREE.Color): THREE.Color {
    const t = THREE.MathUtils.clamp((y + 6) / 20, 0, 1);
    if (t < 0.5) return out.copy(Track.SAND_LOW).lerp(Track.SAND_MID, t * 2);
    return out.copy(Track.SAND_MID).lerp(Track.SAND_HIGH, (t - 0.5) * 2);
  }

  /**
   * Build the dune terrain. The collider is a TRIMESH built from the exact same
   * vertices/indices as the visual mesh, so the surface the car drives on is
   * guaranteed to be the surface you see.
   */
  private buildTerrain() {
    const R = this.physics.rapier;
    const n = SEG;
    const stride = n + 1;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(stride * stride * 3);
    const col = new Float32Array(stride * stride * 3);
    const hs = new Float32Array(stride * stride);

    for (let i = 0; i <= n; i++) {        // rows → z
      for (let j = 0; j <= n; j++) {      // cols → x
        const x = (j / n - 0.5) * MAP;
        const z = (i / n - 0.5) * MAP;
        const y = this.terrainHeight(x, z);
        const v = i * stride + j;
        hs[v] = y;
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
      }
    }

    // Sand colour: one smooth gradient with height (rust in the hollows, orange mid-slopes,
    // pale gold on the crests). No patches or bands: the dune shapes and the low sun do
    // the shading, so the ground never reads as a painted texture.
    const tmp = new THREE.Color();
    for (let v = 0; v < stride * stride; v++) {
      this.sandColor(hs[v], tmp);
      col[v * 3] = tmp.r;
      col[v * 3 + 1] = tmp.g;
      col[v * 3 + 2] = tmp.b;
    }

    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0.0 })
    );
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.terrain = mesh;

    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    const terrainCol = this.physics.world.createCollider(
      R.ColliderDesc.trimesh(pos, new Uint32Array(idx)).setFriction(1.6),
      body
    );
    this.surfaces.register(terrainCol.handle, "dirt");

    // Endless sand beyond the map edge: four big flat strips around the terrain (a single
    // plane would cover the dune hollows), same colour and material as the sand at the edge.
    const farMat = new THREE.MeshStandardMaterial({ color: this.sandColor(0, new THREE.Color()), roughness: 0.97, metalness: 0 });
    const FAR = 3000;
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

  // ----------------------------------------------------------------- road

  /** The closed loop laid over the dunes as a trimesh ribbon with curbs. */
  private buildRoad() {
    const R = this.physics.rapier;
    const raise = 0.5; // sit the road just above the terrain
    const halfW = ROAD_HALF_W;
    const curbH = 0.7;
    const N = this.roadN;

    const roadPos: number[] = [];
    const roadIdx: number[] = [];
    const curbPos: number[] = [];
    const curbIdx: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];

    for (let k = 0; k < N; k++) {
      const px = this.roadPts[2 * k], pz = this.roadPts[2 * k + 1];
      const nx = this.roadPts[2 * ((k + 1) % N)], nz = this.roadPts[2 * ((k + 1) % N) + 1];
      const tan = new THREE.Vector3(nx - px, 0, nz - pz).normalize();
      const side = new THREE.Vector3().crossVectors(up, tan).normalize();
      const y = this.roadY[k] + raise;
      const l = new THREE.Vector3(px + side.x * halfW, y, pz + side.z * halfW);
      const r = new THREE.Vector3(px - side.x * halfW, y, pz - side.z * halfW);
      left.push(l);
      right.push(r);
      roadPos.push(l.x, l.y, l.z, r.x, r.y, r.z);
    }
    for (let k = 0; k < N; k++) {
      const a = (k * 2) % (N * 2); // left k
      const b = a + 1; // right k
      const c = (((k + 1) % N) * 2) % (N * 2); // left k+1
      const d = c + 1; // right k+1
      roadIdx.push(a, b, c, b, d, c);
    }

    // Curbs: a low vertical lip along each edge.
    const pushCurb = (edge: THREE.Vector3[]) => {
      const base = curbPos.length / 3;
      for (const e of edge) {
        curbPos.push(e.x, e.y, e.z, e.x, e.y + curbH, e.z);
      }
      for (let k = 0; k < N; k++) {
        const a = base + (k * 2) % (N * 2);
        const b = a + 1;
        const c = base + (((k + 1) % N) * 2) % (N * 2);
        const d = c + 1;
        curbIdx.push(a, b, c, b, d, c);
      }
    };
    pushCurb(left);
    pushCurb(right);

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(roadPos), 3));
    roadGeo.setIndex(roadIdx);
    roadGeo.computeVertexNormals();
    const roadMesh = new THREE.Mesh(roadGeo, this.mat.road);
    roadMesh.receiveShadow = true;
    this.scene.add(roadMesh);

    const curbGeo = new THREE.BufferGeometry();
    curbGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(curbPos), 3));
    curbGeo.setIndex(curbIdx);
    curbGeo.computeVertexNormals();
    const curbMesh = new THREE.Mesh(curbGeo, this.mat.curb);
    curbMesh.castShadow = true;
    this.scene.add(curbMesh);

    // Colliders (static trimeshes) — the paved line through the dunes.
    const roadBody = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    const roadCol = this.physics.world.createCollider(
      R.ColliderDesc.trimesh(new Float32Array(roadPos), new Uint32Array(roadIdx)).setFriction(1.8),
      roadBody
    );
    this.surfaces.register(roadCol.handle, "tarmac");
    const curbBody = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    const curbCol = this.physics.world.createCollider(
      R.ColliderDesc.trimesh(new Float32Array(curbPos), new Uint32Array(curbIdx)).setFriction(1.0),
      curbBody
    );
    this.surfaces.register(curbCol.handle, "tarmac");
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
      [240, -95], [255, -75], [185, 75], [205, 60],
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
