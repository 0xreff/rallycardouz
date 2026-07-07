import * as THREE from "three";

/**
 * Collision sparks — a pool of small additive points sprayed from a contact point
 * and thrown by gravity, so a chassis grind/hit throws a shower of bright flecks
 * the bloom pass makes glow. When a spark lands it leaves a small black scorch mark
 * on the ground (a separate persistent decal pool), like real sparks burning the
 * floor. Ring-buffer cursors recycle the oldest, so there's no per-frame allocation.
 */
export class Sparks {
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private cursor = 0;

  // Black scorch decals left where sparks hit the ground.
  private scorch: THREE.InstancedMesh;
  private scorchDummy = new THREE.Object3D();
  private scorchCursor = 0;

  constructor(scene: THREE.Scene, private max = 800, private maxScorch = 500) {
    this.pos = new Float32Array(max * 3).fill(-9999); // park unused particles offscreen
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xffd27a,
      size: 0.09, // small flecks
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(this.geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    // --- Scorch decal pool: small dark quads lying flat on the ground. ---
    const sgeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const smat = new THREE.MeshBasicMaterial({
      color: 0x050505,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.scorch = new THREE.InstancedMesh(sgeo, smat, maxScorch);
    this.scorch.frustumCulled = false;
    this.scorch.renderOrder = 1;
    this.scorchDummy.scale.set(0, 0, 0);
    this.scorchDummy.updateMatrix();
    for (let i = 0; i < maxScorch; i++) this.scorch.setMatrixAt(i, this.scorchDummy.matrix);
    this.scorch.instanceMatrix.needsUpdate = true;
    scene.add(this.scorch);
  }

  /** Spray `count` sparks from (x,y,z) roughly along `dir`, with random spread. */
  emit(x: number, y: number, z: number, dir: THREE.Vector3, count: number, speed: number) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      this.pos[i3] = x;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z;
      const s = speed * (0.5 + Math.random());
      this.vel[i3] = dir.x * s + (Math.random() - 0.5) * speed;
      this.vel[i3 + 1] = dir.y * s + Math.random() * speed * 0.7 + 1.0; // bias upward
      this.vel[i3 + 2] = dir.z * s + (Math.random() - 0.5) * speed;
      this.life[i] = 0.15 + Math.random() * 0.3;
    }
  }

  /** Advance all live sparks: gravity, drag, fade; scorch the ground on landing. */
  update(dt: number) {
    let scorchDirty = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3 + 1] -= 22 * dt; // gravity
      this.vel[i3] *= 0.96;
      this.vel[i3 + 2] *= 0.96;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      // Landed (or faded): if it hit the ground going down, leave a scorch mark.
      if (this.pos[i3 + 1] <= 0.04 && this.vel[i3 + 1] < 0) {
        this.stampScorch(this.pos[i3], this.pos[i3 + 2]);
        scorchDirty = true;
        this.life[i] = 0;
      }
      if (this.life[i] <= 0) this.pos[i3 + 1] = -9999; // dead → park offscreen
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    if (scorchDirty) this.scorch.instanceMatrix.needsUpdate = true;
  }

  private stampScorch(x: number, z: number) {
    const s = 0.14 + Math.random() * 0.18;
    this.scorchDummy.position.set(x, 0.02, z);
    this.scorchDummy.rotation.set(0, Math.random() * Math.PI, 0);
    this.scorchDummy.scale.set(s, 1, s);
    this.scorchDummy.updateMatrix();
    this.scorch.setMatrixAt(this.scorchCursor, this.scorchDummy.matrix);
    this.scorchCursor = (this.scorchCursor + 1) % this.maxScorch;
  }
}
