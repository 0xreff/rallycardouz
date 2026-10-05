import * as THREE from 'three';

function dampAngle(current, target, rate, dt) {
  const d = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + d * (1 - Math.exp(-rate * dt));
}

/**
 * Low chase camera: frame-rate-independent damping, speed-based FOV kick,
 * acceleration push-back, gentle low-frequency shake and bob. No allocations.
 */
export class CameraRig {
  constructor(camera, vehicle, terrain, config) {
    this.camera = camera;
    this.vehicle = vehicle;
    this.terrain = terrain;
    this.config = config;
    this.yaw = vehicle.heading;
    this.fov = config.camera.fov;
    this.time = 0;
    this.smAccel = 0;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._flat = new THREE.Vector3();
    this.snap();
  }

  _compute(outPos, outLook) {
    const c = this.config.camera, v = this.vehicle, sf = v.speedFrac;
    const f = this._flat.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const push = THREE.MathUtils.clamp(this.smAccel * 0.04, -0.4, 0.8);
    outPos.copy(v.position).addScaledVector(f, -(c.distance + sf * 1.2 + push));
    outPos.y += c.height - sf * 0.3;
    outLook.copy(v.position).addScaledVector(f, c.lookAhead * (1 + sf * 0.6));
    outLook.y += c.lookHeight;
  }

  _clampToGround(p) {
    const g = this.terrain.heightAt(p.x, p.z) + 0.7;
    if (p.y < g) p.y = g;
  }

  snap() {
    this.yaw = this.vehicle.heading;
    this._compute(this._pos, this._look);
    this._clampToGround(this._pos);
    this._apply();
  }

  update(dt) {
    const c = this.config.camera, v = this.vehicle;
    this.time += dt;
    this.yaw = dampAngle(this.yaw, v.heading, 4.5, dt);
    this.smAccel += (v.accelLong - this.smAccel) * (1 - Math.exp(-3 * dt));
    this._compute(this._desired, this._lookTarget);
    this._pos.lerp(this._desired, 1 - Math.exp(-c.followDamping * dt));
    this._clampToGround(this._pos);
    this._look.lerp(this._lookTarget, 1 - Math.exp(-c.lookDamping * dt));
    const targetFov = c.fov + c.fovKick * Math.pow(v.speedFrac, 1.5) + THREE.MathUtils.clamp(this.smAccel * 0.25, -1, 2.5);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-3 * dt));
    this._apply();
  }

  _apply() {
    const c = this.config.camera, v = this.vehicle, t = this.time, cam = this.camera, sf = v.speedFrac;
    cam.position.copy(this._pos);
    cam.position.y += c.bob * 0.04 * sf * Math.sin(t * 8.3);
    cam.lookAt(this._look);
    const amp = c.shake * (0.0015 + 0.008 * sf * sf);
    cam.rotateX(amp * (Math.sin(t * 1.7) + 0.6 * Math.sin(t * 4.1 + 1.3)));
    cam.rotateY(amp * 0.7 * (Math.sin(t * 1.3 + 2.1) + 0.5 * Math.sin(t * 3.7)));
    cam.rotateZ(amp * (Math.sin(t * 0.9 + 0.4) + 0.5 * Math.sin(t * 2.3)) - v.steer * sf * 0.02);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
  }
}
