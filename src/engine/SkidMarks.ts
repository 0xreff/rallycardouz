import * as THREE from "three";

/**
 * Tyre skid marks — dark stamps laid flat on the ground wherever a wheel is
 * sliding, so drifts and handbrake slides are clearly *visible*. A fixed pool of
 * InstancedMesh quads cycles through a write cursor; once the pool wraps, the
 * oldest marks are overwritten — a long, free-running trail with no per-frame
 * allocation. Owned by the Game so the marks persist across car swaps.
 */
export class SkidMarks {
  private mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private cursor = 0;
  private readonly length = 0.55; // stamp length along travel (overlaps at speed)

  constructor(scene: THREE.Scene, private max = 4000) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // lie flat, +Z = length
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a12,
      transparent: true,
      opacity: 0.5,
      depthWrite: false, // don't occlude the car; just darken the ground
      polygonOffset: true, // lift off the floor to avoid z-fighting
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;

    // Start with every instance scaled to zero (invisible until stamped).
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** Stamp a mark flat on the ground at (x,y,z), its length aligned to `yaw`. */
  add(x: number, y: number, z: number, yaw: number, width: number) {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, yaw, 0);
    this.dummy.scale.set(width, 1, this.length);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(this.cursor, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cursor = (this.cursor + 1) % this.max;
  }
}
