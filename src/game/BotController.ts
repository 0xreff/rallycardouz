import * as THREE from "three";
import { Physics } from "../physics/Physics";
import { Car } from "./Car";
import { avoidanceControl } from "./handling";
import type { ControlState } from "../engine/Input";

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A simple AI driver: cruises the arena, wanders with a slowly drifting random
 * steer, and avoids crashing by casting three rays ahead (left / centre / right)
 * and steering toward the most open side, easing off the throttle when something
 * is close. If it gets pinned, it backs up and turns to free itself.
 *
 * It produces a ControlState each frame, exactly like keyboard Input, so the bot
 * drives a normal Car with no special-casing in the physics.
 */
export class BotController {
  private wander = 0;       // smoothed wander steer
  private wanderTarget = 0; // current random steer goal
  private wanderTimer = 0;  // time until the goal is re-rolled
  private stuckTime = 0;    // how long we've been barely moving
  private reverseTimer = 0; // >0 while backing out of being stuck
  private reverseDir = 1;

  constructor(private physics: Physics, private car: Car) {}

  sample(dt: number): ControlState {
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false, reset: false, recover: false, cycleCar: false };

    const pos = this.car.position();
    const fwd = this.car.forwardVector();
    const vel = this.car.velocity();
    const speed = vel.dot(fwd);

    // --- Stuck recovery: pinned for a while → back up and turn out. ---
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      return { ...idle, brake: 1, steer: this.reverseDir };
    }
    if (Math.abs(speed) < 0.6) {
      this.stuckTime += dt;
      if (this.stuckTime > 1.2) {
        this.reverseTimer = 0.9;
        this.reverseDir = Math.random() < 0.5 ? -1 : 1;
        this.stuckTime = 0;
      }
    } else {
      this.stuckTime = 0;
    }

    // --- Wander: a lazily drifting random steer goal. ---
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTarget = (Math.random() * 2 - 1) * 0.5;
      this.wanderTimer = 1.5 + Math.random() * 2;
    }
    this.wander += (this.wanderTarget - this.wander) * Math.min(1, 2 * dt);

    // --- Obstacle avoidance: three rays ahead, look further the faster we go. ---
    const look = THREE.MathUtils.clamp(Math.abs(speed) * 0.6 + 6, 6, 18);
    const origin = pos.clone().addScaledVector(fwd, 1.2); // just ahead of the nose
    const right = fwd.clone().applyAxisAngle(UP, 0.45); // +angle = car's right side
    const left = fwd.clone().applyAxisAngle(UP, -0.45);
    const dC = this.cast(origin, fwd, look);
    const dR = this.cast(origin, right, look);
    const dL = this.cast(origin, left, look);

    const { steer, throttle } = avoidanceControl(dC, dL, dR, look, this.wander);

    return { ...idle, throttle, steer };
  }

  /** Distance to the nearest obstacle along `dir` (normalised), or `look` if clear. */
  private cast(origin: THREE.Vector3, dir: THREE.Vector3, look: number): number {
    const ray = new this.physics.rapier.Ray(origin, dir.clone().normalize());
    const hit = this.physics.world.castRay(ray, look, true, undefined, undefined, undefined, this.car.body);
    return hit ? hit.timeOfImpact : look;
  }
}
