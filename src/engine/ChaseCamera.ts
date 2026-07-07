import * as THREE from "three";

/** Everything the dynamic camera needs to react to, sampled from the car each frame. */
export interface CameraTarget {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  velocity: THREE.Vector3;
  speedFrac: number; // 0..1 of the car's true max speed
  steer: number;     // -1..1 steering input
  airborne: boolean;
  impact: number;    // 0..1 collision / hard-landing shake intensity (decays in Car)
}

/**
 * Dynamic chase camera. Trails the car but reacts to the drive: FOV opens with
 * speed, acceleration shoves it back (braking pulls it in), it banks and looks
 * into corners, floats back & up in the air, and shakes on impacts. Built to feel
 * alive without ever losing the car.
 */
export class ChaseCamera {
  private currentPos = new THREE.Vector3(0, 6, -10);
  private currentLook = new THREE.Vector3();
  private baseFov: number;
  private fov: number;
  private smAccel = 0;   // smoothed longitudinal acceleration (the "shove")
  private prevVLong = 0; // last frame's forward speed, for accel
  private roll = 0;      // banked-horizon angle (radians)
  private shakeTrauma = 0; // 0..1 shake energy from impacts (decays back to 0)
  private shakeTime = 0;   // running clock for the smooth shake oscillation
  private wasAirborne = false; // last frame's airborne state, to detect touchdown
  private landingDip = 0;      // transient on landing: sinks the cam & flattens the look

  constructor(private camera: THREE.PerspectiveCamera, private distance = 7, private height = 3.2) {
    this.baseFov = camera.fov;
    this.fov = camera.fov;
  }

  update(t: CameraTarget, dt: number) {
    // Frame-rate-independent smoothing factor: fraction to move toward target this frame.
    const k = (rate: number) => 1 - Math.pow(rate, dt);

    // Flatten forward to the ground for a stable chase basis.
    const flatFwd = t.forward.clone();
    flatFwd.y = 0;
    if (flatFwd.lengthSq() < 1e-4) flatFwd.set(0, 0, 1);
    flatFwd.normalize();

    const vLong = t.velocity.dot(t.forward);    // forward speed
    const lateralVel = t.velocity.dot(t.right); // sideways slide (signed)

    // Smoothed longitudinal acceleration drives the push/pull "shove".
    const accel = (vLong - this.prevVLong) / Math.max(dt, 1e-4);
    this.prevVLong = vLong;
    this.smAccel += (accel - this.smAccel) * Math.min(1, 8 * dt);

    // --- Landing settle: on touchdown (airborne -> grounded) the camera briefly
    //     sinks lower and flattens toward the horizon, like the view sitting down
    //     into the ground, then springs back. A harder landing (impact) dips more. ---
    if (this.wasAirborne && !t.airborne) {
      this.landingDip = Math.min(1, 0.6 + t.impact * 1.2); // spike on touchdown
    }
    this.wasAirborne = t.airborne;
    this.landingDip *= Math.pow(0.015, dt); // decay back over ~0.35s

    // --- FOV: opens with speed (sense of speed) + a kick under hard acceleration. ---
    const targetFov = this.baseFov + 8 * t.speedFrac + THREE.MathUtils.clamp(this.smAccel * 0.12, -1.5, 4);
    this.fov += (targetFov - this.fov) * k(0.002);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    // --- Distance & height: pull back/up with speed, more in the air; accel shoves
    //     the camera back, braking draws it in. ---
    let dist = this.distance + t.speedFrac * 0.5 + THREE.MathUtils.clamp(this.smAccel * 0.04, -0.7, 1.0);
    let height = this.height - t.speedFrac * 0.4; // sit lower at speed → flatter, more horizontal view
    if (t.airborne) {
      dist += 1.8;
      height += 0.9;
    }
    height -= this.landingDip * 1.4; // sink the camera on touchdown

    const desired = t.position
      .clone()
      .addScaledVector(flatFwd, -dist)
      .add(new THREE.Vector3(0, height, 0))
      // ease sideways opposite the slide so we see into the drift
      .addScaledVector(t.right, -THREE.MathUtils.clamp(lateralVel * 0.06, -1.2, 1.2));

    // Floatier follow in the air, snappy on the ground.
    this.currentPos.lerp(desired, k(t.airborne ? 0.02 : 0.0016));

    // --- Look target: lead ahead, and look INTO the corner (steer + slide). ---
    const lookAhead = 4 + t.speedFrac * 3;
    const sideLook = THREE.MathUtils.clamp(lateralVel * 0.1 + t.steer * 1.0, -2.2, 2.2);
    const lookTarget = t.position
      .clone()
      .addScaledVector(flatFwd, lookAhead)
      // raise the look point toward the horizon (flatter view); drop it on landing
      .add(new THREE.Vector3(0, 1.3 - this.landingDip * 1.1, 0))
      .addScaledVector(t.right, sideLook);
    this.currentLook.lerp(lookTarget, k(0.0006));

    // --- Bank: roll the horizon into the turn for a dynamic, leaning feel. ---
    const targetRoll = THREE.MathUtils.clamp(-(lateralVel * 0.012 + t.steer * 0.03), -0.08, 0.08);
    this.roll += (targetRoll - this.roll) * k(0.004);

    // --- Shake: smooth & damped. A hit injects "trauma" scaled by its strength;
    //     that rings the camera with decaying sine waves and settles exactly back
    //     to rest (the offset reaches 0 as trauma fades). Stronger impacts → bigger,
    //     longer shake (quadratic weighting), so the weight follows the hit. ---
    this.shakeTrauma = Math.max(this.shakeTrauma * Math.pow(0.008, dt), t.impact); // settles a touch quicker
    this.shakeTime += dt;
    const amp = this.shakeTrauma * this.shakeTrauma * 0.38 + Math.max(0, t.speedFrac - 0.9) * 0.012; // gentler shudder

    // Compose: position (+ smooth shake), banked up-vector, look-at.
    this.camera.position.copy(this.currentPos);
    if (amp > 1e-4) {
      this.camera.position.x += amp * Math.sin(this.shakeTime * 46);
      this.camera.position.y += amp * Math.sin(this.shakeTime * 58 + 1.7);
      this.camera.position.z += amp * Math.sin(this.shakeTime * 39 + 3.1);
    }
    const viewDir = this.currentLook.clone().sub(this.camera.position).normalize();
    this.camera.up.set(0, 1, 0).applyAxisAngle(viewDir, this.roll);
    this.camera.lookAt(this.currentLook);
  }
}
