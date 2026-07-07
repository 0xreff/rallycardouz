import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { SkidMarks } from "../engine/SkidMarks";
import { Sparks } from "../engine/Sparks";
import { Smoke } from "../engine/Smoke";
import { Dust } from "../engine/Dust";

/**
 * Visual effects emitter for a Car — collision sparks, wheel skid marks, tyre
 * smoke and surface dust. Pure side-effects: it reads car/contact state and feeds
 * the effect pools, and never touches physics, so it can't change how the car
 * drives. Extracted from Car to keep that class focused on the vehicle itself.
 */
export class CarFX {
  constructor(
    private skids: SkidMarks,
    private sparks: Sparks,
    private smoke: Smoke,
    private dust: Dust
  ) {}

  /**
   * Throw sparks from the chassis wherever it actually touches something — at the
   * real (geometric) contact points, scaled by the grind/scrape speed and the
   * collision impact.
   */
  collisionSparks(
    world: RAPIER.World,
    collider: RAPIER.Collider,
    body: RAPIER.RigidBody,
    velVec: THREE.Vector3,
    impact: number
  ) {
    const ct = collider.translation();
    const cr = collider.rotation();
    const cq = new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w);
    const cpos = new THREE.Vector3(ct.x, ct.y, ct.z);
    const linV = velVec;
    const ang = body.angvel();
    const angV = new THREE.Vector3(ang.x, ang.y, ang.z);
    world.contactPairsWith(collider, (other) => {
      world.contactPair(collider, other, (manifold, flipped) => {
        const nrm = manifold.normal();
        const n = new THREE.Vector3(nrm.x, nrm.y, nrm.z);
        for (let i = 0; i < manifold.numContacts(); i++) {
          if (manifold.contactDist(i) > 0.02) continue; // skip points not actually touching
          const lp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
          if (!lp) continue;
          const p = new THREE.Vector3(lp.x, lp.y, lp.z).applyQuaternion(cq).add(cpos); // world contact point
          const vp = linV.clone().add(angV.clone().cross(p.clone().sub(cpos))); // velocity at the point
          const scrape = vp.clone().addScaledVector(n, -vp.dot(n)).length();
          const intensity = scrape * 0.4 + impact * 9;
          if (intensity < 1.5) continue;
          const dir = scrape > 0.5 ? vp.addScaledVector(n, -vp.dot(n)).multiplyScalar(-1).normalize() : n.clone().negate();
          const count = Math.min(4, Math.ceil(intensity * 0.25));
          this.sparks.emit(p.x, p.y, p.z, dir, count, Math.min(6, 1.2 + scrape * 0.22 + impact * 3.5));
        }
      });
    });
  }

  /** Lay a skid mark, tyre smoke and/or surface dust at one wheel's ground contact. */
  wheelContact(
    cp: { x: number; y: number; z: number },
    smokeIntensity: number,
    skidding: boolean,
    burningOut: boolean,
    vx: number,
    vz: number,
    heading: number,
    wheelWidth: number,
    dustIntensity = 0
  ) {
    if (skidding) {
      const sp = Math.hypot(vx, vz);
      if (sp > 1.5 || burningOut) {
        const yaw = sp > 1.0 ? Math.atan2(vx, vz) : heading; // use heading when ~stationary
        this.skids.add(cp.x, cp.y + 0.02, cp.z, yaw, wheelWidth * 1.1);
      }
    }
    if (smokeIntensity > 0.25) {
      this.smoke.emit(cp.x, cp.y + 0.05, cp.z, Math.min(3, Math.round(smokeIntensity * 3)), smokeIntensity);
    }
    // Loose-surface dust trail, thrown back along the wheel's travel.
    if (dustIntensity > 0.15) {
      this.dust.emit(cp.x, cp.y + 0.05, cp.z, Math.min(3, Math.round(dustIntensity * 3)), dustIntensity, vx, vz);
    }
  }
}
