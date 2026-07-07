import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../physics/Physics";
import { createRimMaterial } from "../engine/RimMaterial";
import { SurfaceMap } from "./Surfaces";

/**
 * A large open-world rally course — roughly ten times the footprint of the old
 * stunt arena. It is built from three layers:
 *
 *   1. Rolling HILLS: a single big undulating terrain (gentle, drivable slopes)
 *      so the whole map flows up and down. The mesh and its physics collider are
 *      built from one shared vertex/index buffer (a trimesh), so the surface the
 *      car drives on is exactly the surface you see.
 *   2. A winding CURVED road: a closed Catmull-Rom loop laid over the terrain as
 *      a trimesh ribbon with low curbs, so there's a fast line through the hills.
 *   3. JUMP RAMPS scattered along the course: a gap jump, a tabletop, and a few
 *      kickers, each dropped onto the terrain at its local height.
 *
 * Every collider is registered in the SurfaceMap with a surface type — the
 * terrain is DIRT (loose: less grip, dust trails), the road/curbs/ramps are
 * TARMAC (full grip) — so cars handle differently on and off the road.
 */

const MAP = 700; // ground span (old arena was 220 → ~10x the area)
const HALF = MAP / 2;
const SEG = 96; // terrain grid resolution (SEG x SEG cells)

// The course starts here; the terrain is flattened into a pad around this point.
const SPAWN_XZ = new THREE.Vector2(-200, -170);

export class Track {
  readonly spawn = new THREE.Vector3(SPAWN_XZ.x, 2, SPAWN_XZ.y);

  // Collider-handle → surface registry: cars query this to know what each wheel
  // is rolling on (tarmac road grips; dirt terrain slides and kicks up dust).
  readonly surfaces = new SurfaceMap();

  // Dynamic props (cones) whose meshes follow physics each frame.
  private props: { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] = [];

  private mat = {
    wall: new THREE.MeshStandardMaterial({ color: 0x3a4470, roughness: 0.8, metalness: 0.1 }),
    ramp: createRimMaterial({ color: 0x3f57b0, metalness: 0.3, roughness: 0.5, rimStrength: 0.5 }),
    road: new THREE.MeshStandardMaterial({ color: 0x20263e, roughness: 0.9, metalness: 0.05, side: THREE.DoubleSide }),
    curb: createRimMaterial({ color: 0x6f8fff, metalness: 0.25, roughness: 0.5, rimStrength: 0.4 }),
    cone: createRimMaterial({ color: 0xff5a1e, metalness: 0.2, roughness: 0.5, rimStrength: 0.5 }),
  };

  constructor(private physics: Physics, private scene: THREE.Scene) {
    this.buildTerrain();
    this.buildRoad();
    this.buildRamps();
    this.buildPerimeter();
  }

  // -------------------------------------------------------------- terrain

  /** Rolling-hills height at a world (x,z). Flat pad around the spawn. */
  private terrainHeight(x: number, z: number): number {
    const d = Math.hypot(x - SPAWN_XZ.x, z - SPAWN_XZ.y);
    const flat = THREE.MathUtils.smoothstep(d, 26, 90); // 0 on the pad → 1 in the hills
    const h =
      9.0 * Math.cos(x * 0.0155) * Math.cos(z * 0.0175) +
      4.5 * Math.cos(x * 0.034) * Math.cos(z * 0.029) +
      2.0 * Math.cos(x * 0.062) * Math.cos(z * 0.051);
    return h * flat;
  }

  /**
   * Build the rolling-hills terrain. The collider is a TRIMESH built from the
   * exact same vertices/indices as the visual mesh, so the surface the car drives
   * on is guaranteed to be the surface you see — no heightfield axis/layout
   * conventions to get wrong.
   */
  private buildTerrain() {
    const R = this.physics.rapier;
    const n = SEG;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const col = new Float32Array((n + 1) * (n + 1) * 3);
    const low = new THREE.Color(0x1d2640);
    const high = new THREE.Color(0x4a6cff);

    for (let i = 0; i <= n; i++) {        // rows → z
      for (let j = 0; j <= n; j++) {      // cols → x
        const x = (j / n - 0.5) * MAP;
        const z = (i / n - 0.5) * MAP;
        const y = this.terrainHeight(x, z);

        const v = (i * (n + 1) + j) * 3;
        pos[v] = x;
        pos[v + 1] = y;
        pos[v + 2] = z;

        const t = THREE.MathUtils.clamp((y + 6) / 22, 0, 1);
        const c = low.clone().lerp(high, t);
        col[v] = c.r;
        col[v + 1] = c.g;
        col[v + 2] = c.b;
      }
    }

    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j;
        const b = a + 1;
        const c = a + (n + 1);
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
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0 })
    );
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.scene.add(mesh);

    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    const terrainCol = this.physics.world.createCollider(
      R.ColliderDesc.trimesh(pos, new Uint32Array(idx)).setFriction(1.6),
      body
    );
    this.surfaces.register(terrainCol.handle, "dirt");
  }

  // ----------------------------------------------------------------- road

  /** A winding closed loop laid over the hills as a trimesh ribbon with curbs. */
  private buildRoad() {
    const R = this.physics.rapier;
    const raise = 0.5; // sit the road just above the terrain
    const halfW = 9; // road half-width
    const curbH = 0.7;

    // Control points trace a sweeping circuit; the first is the spawn/start line.
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
    const pts = curve.getSpacedPoints(N); // length N+1, pts[N] == pts[0]

    const roadPos: number[] = [];
    const roadIdx: number[] = [];
    const curbPos: number[] = [];
    const curbIdx: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];

    for (let k = 0; k < N; k++) {
      const p = pts[k];
      const next = pts[(k + 1) % N];
      const tan = next.clone().sub(p).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(up, tan).normalize();
      const y = this.terrainHeight(p.x, p.z) + raise;
      const l = new THREE.Vector3(p.x + side.x * halfW, y, p.z + side.z * halfW);
      const r = new THREE.Vector3(p.x - side.x * halfW, y, p.z - side.z * halfW);
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

    // Colliders (static trimeshes) — the paved line through the dirt hills.
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

  /** Jump features dropped onto the terrain along the course. */
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

  /** Tall boundary walls around the map edge so cars can't drive off the world. */
  private buildPerimeter() {
    const R = this.physics.rapier;
    const h = 30;
    const yC = 10; // spans -5..25, comfortably covering the terrain's height range
    const edges: [number, number, number, number][] = [
      [0, HALF, MAP, 2],
      [0, -HALF, MAP, 2],
      [HALF, 0, 2, MAP],
      [-HALF, 0, 2, MAP],
    ];
    for (const [x, z, dw, dd] of edges) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(dw, h, dd), this.mat.wall);
      mesh.position.set(x, yC, z);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
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
