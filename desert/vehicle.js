import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const WHEEL_RADIUS = 0.46;
const WHEELBASE = 2.5;
const TRACK = 1.96;
// Object space: +Z forward, +X left. Order: FL, FR, RL, RR.
const WHEEL_LOCAL = [
  new THREE.Vector3(0.98, 0, 1.25), new THREE.Vector3(-0.98, 0, 1.25),
  new THREE.Vector3(0.98, 0, -1.25), new THREE.Vector3(-0.98, 0, -1.25),
];
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function makeBeamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uIntensity: { value: 0.12 }, uLength: { value: 14 } },
    vertexShader: /* glsl */ `
      uniform float uLength; varying float vT; varying vec3 vN; varying vec3 vViewPos;
      void main() {
        vT = clamp(position.z / uLength, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uIntensity; varying float vT; varying vec3 vN; varying vec3 vViewPos;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(-vViewPos)));
        float a = pow(1.0 - vT, 2.2) * facing * facing * uIntensity;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Keyboard: W/S or arrows, A/D steer, Space brake. Steering keys disable auto-drive. */
export class KeyboardInput {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.touched = false;
    this.state = { throttle: 0, brake: 0, steer: 0 };
    const driveKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (driveKeys.includes(e.code)) this.touched = true;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  sample() {
    const k = this.keys, s = this.state;
    s.throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    s.brake = k.has('KeyS') || k.has('ArrowDown') || k.has('Space') ? 1 : 0;
    s.steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    return s;
  }
  consumePress(code) { return this.pressed.delete(code); }
  consumeTouched() { const t = this.touched; this.touched = false; return t; }
}

/**
 * Arcade placeholder buggy that hugs the terrain. Swap the visuals for a GLB
 * with loadModel(url) - the driving, dust and camera keep working unchanged.
 */
export class Vehicle {
  constructor(scene, terrain, config, heading = 0) {
    this.terrain = terrain;
    this.config = config;
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.placeholder = new THREE.Group();
    this.group.add(this.body);
    this.body.add(this.placeholder);
    scene.add(this.group);

    this.heading = heading;
    this.speed = 0;
    this.speedFrac = 0;
    this.steer = 0;
    this.slip = 0;
    this.accelLong = 0;
    this.position = this.group.position;
    this.forwardFlat = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    this.velocity = new THREE.Vector3();
    this.wheelContacts = WHEEL_LOCAL.map(() => new THREE.Vector3());
    this.wheelIsRear = [false, false, true, true];
    this._autoT = 0;
    this._time = 0;
    this._fwdT = new THREE.Vector3();
    this._leftT = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._basis = new THREE.Matrix4();
    this._targetQ = new THREE.Quaternion();

    this._buildPlaceholder();
    this._buildLights();
    this.position.set(0, terrain.heightAt(0, 0), 0);
    this._orient(1, true);
    this.sync(config);
  }

  _buildPlaceholder() {
    const paint = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.45, metalness: 0.6 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.8, metalness: 0.2 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.95 });
    const box = (w, h, d, x, y, z, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.placeholder.add(m);
      return m;
    };
    box(1.7, 0.45, 3.4, 0, 0.8, 0, paint);
    box(1.5, 0.3, 0.7, 0, 0.72, 1.85, paint);
    for (const x of [0.7, -0.7]) for (const z of [0.3, -0.8]) box(0.08, 0.9, 0.08, x, 1.35, z, trim);
    box(1.5, 0.06, 1.3, 0, 1.8, -0.25, trim);
    box(1.8, 0.06, 0.4, 0, 1.35, -1.75, trim);
    for (const x of [0.5, -0.5]) box(0.06, 0.3, 0.06, x, 1.18, -1.7, trim);

    const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.38, 20);
    wheelGeo.rotateZ(Math.PI / 2);
    this.wheelPivots = [];
    this.wheelMeshes = [];
    for (const p of WHEEL_LOCAL) {
      const pivot = new THREE.Group();
      pivot.position.set(p.x, WHEEL_RADIUS, p.z);
      const m = new THREE.Mesh(wheelGeo, tyre);
      m.castShadow = true;
      pivot.add(m);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelMeshes.push(m);
    }
  }

  _buildLights() {
    // HDR emissive (values > 1) so only these and the sun cross the bloom threshold.
    this.headlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lightBarMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const x of [0.5, -0.5]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.05), this.headlightMat);
      m.position.set(x, 0.86, 2.21);
      this.body.add(m);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.08), this.lightBarMat);
    bar.position.set(0, 1.86, 0.4);
    this.body.add(bar);

    this.spot = new THREE.SpotLight(0xffffff, 40, 70, 0.45, 0.7, 1.0);
    this.spot.position.set(0, 0.9, 2.2);
    this.spot.target.position.set(0, 0, 20);
    this.body.add(this.spot, this.spot.target);

    // Fake light cones: apex at the lamp, opening forward (+Z).
    const coneGeo = new THREE.ConeGeometry(2.4, 14, 24, 1, true);
    coneGeo.rotateX(-Math.PI / 2);
    coneGeo.translate(0, 0, 7);
    this.beamMat = makeBeamMaterial();
    for (const x of [0.5, -0.5]) {
      const cone = new THREE.Mesh(coneGeo, this.beamMat);
      cone.position.set(x, 0.86, 2.24);
      cone.rotation.x = 0.06;
      cone.renderOrder = 20;
      this.body.add(cone);
    }
  }

  /** Replace the placeholder visuals with any Object3D (lights stay). */
  setModel(object, hideWheels = true) {
    this.placeholder.visible = false;
    if (hideWheels) this.wheelPivots.forEach((p) => (p.visible = false));
    this.body.add(object);
  }

  /** Load a GLB, scale it to `length` metres, sit it on the ground. */
  loadModel(url, { length = 3.6, yaw = 0, hideWheels = true } = {}) {
    return new GLTFLoader().loadAsync(url).then((gltf) => {
      const model = gltf.scene;
      model.rotation.y = yaw;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      model.scale.setScalar(length / Math.max(size.x, size.z));
      box.setFromObject(model);
      const c = box.getCenter(new THREE.Vector3());
      model.position.set(-c.x, -box.min.y, -c.z);
      model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.setModel(model, hideWheels);
      return model;
    });
  }

  _orient(dt, instant = false) {
    const t = this.terrain, h = this.heading, p = this.position;
    const sx = Math.sin(h), cz = Math.cos(h);
    const hw = WHEELBASE / 2, ht = TRACK / 2;
    const hF = t.heightAt(p.x + sx * hw, p.z + cz * hw);
    const hR = t.heightAt(p.x - sx * hw, p.z - cz * hw);
    const hL = t.heightAt(p.x + cz * ht, p.z - sx * ht);
    const hRt = t.heightAt(p.x - cz * ht, p.z + sx * ht);
    const fwd = this._fwdT.set(sx, (hF - hR) / WHEELBASE, cz).normalize();
    const left = this._leftT.set(cz, (hL - hRt) / TRACK, -sx).normalize();
    const up = this._up.crossVectors(fwd, left).normalize();
    left.crossVectors(up, fwd).normalize();
    this._targetQ.setFromRotationMatrix(this._basis.makeBasis(left, up, fwd));
    const groundY = (hF + hR + hL + hRt) / 4;
    if (instant) {
      this.group.quaternion.copy(this._targetQ);
      p.y = groundY;
    } else {
      this.group.quaternion.slerp(this._targetQ, 1 - Math.exp(-12 * dt));
      p.y += (groundY - p.y) * (1 - Math.exp(-18 * dt));
      if (p.y < groundY - 0.05) p.y = groundY - 0.05;
    }
    this.slopeY = fwd.y;
  }

  update(input, dt) {
    const c = this.config.vehicle, p = this.position;
    this._time += dt;
    let { throttle, brake, steer } = input;

    if (c.autoDrive) {
      // Wander, and arc back toward the centre near the edge of the map.
      this._autoT += dt;
      throttle = 0.8;
      brake = 0;
      steer = Math.sin(this._autoT * 0.21) * 0.35 + Math.sin(this._autoT * 0.67 + 1.3) * 0.18;
      if (Math.hypot(p.x, p.z) > 1100) {
        const d = wrapAngle(Math.atan2(-p.x, -p.z) - this.heading);
        steer = -THREE.MathUtils.clamp(d * 1.5, -1, 1);
      }
    }

    const prevSpeed = this.speed;
    const sf = this.speed / c.maxSpeed;
    if (throttle > 0) this.speed += c.accel * throttle * Math.max(0, 1 - sf * sf) * dt;
    if (brake > 0) {
      if (this.speed > 0.5) this.speed -= c.brake * brake * dt;
      else this.speed = Math.max(this.speed - c.accel * 0.6 * brake * dt, -c.maxSpeed * 0.3);
    }
    this.speed -= this.speed * c.drag * dt;
    this.speed -= 9.81 * (this.slopeY || 0) * 0.55 * dt; // uphill slows, downhill speeds up
    if (throttle === 0 && brake === 0 && Math.abs(this.speed) < 0.05) this.speed = 0;
    this.speedFrac = Math.min(1, Math.abs(this.speed) / c.maxSpeed);
    const a = (this.speed - prevSpeed) / Math.max(dt, 1e-4);
    this.accelLong += (a - this.accelLong) * (1 - Math.exp(-6 * dt));

    // Steering: +steer = right = heading decreases (+Z turns toward +X when heading grows).
    this.steer += (steer - this.steer) * (1 - Math.exp(-6 * dt));
    const yawRate = this.steer * c.turnRate * THREE.MathUtils.clamp(this.speed / 6, -1, 1) * (1 - 0.45 * this.speedFrac);
    this.heading -= yawRate * dt;
    this.slip = THREE.MathUtils.clamp(Math.abs(yawRate) * this.speedFrac * 0.8, 0, 1);

    const f = this.forwardFlat.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    p.x += f.x * this.speed * dt;
    p.z += f.z * this.speed * dt;
    const r = Math.hypot(p.x, p.z);
    if (r > 2400) { p.x *= 2400 / r; p.z *= 2400 / r; }
    const prevY = p.y;
    this._orient(dt);
    this.velocity.set(f.x * this.speed, (p.y - prevY) / Math.max(dt, 1e-4), f.z * this.speed);

    // Cosmetic body motion: squat under accel, lean out of turns, bob on rough sand.
    this.body.rotation.x = THREE.MathUtils.clamp(-this.accelLong * 0.006, -0.06, 0.06);
    this.body.rotation.z = -this.steer * this.speedFrac * 0.05;
    this.body.position.y = Math.sin(this._time * 13) * 0.015 * this.speedFrac;
    for (let i = 0; i < 4; i++) {
      this.wheelMeshes[i].rotation.x += (this.speed / WHEEL_RADIUS) * dt;
      if (i < 2) this.wheelPivots[i].rotation.y = -this.steer * 0.45;
    }

    this.group.updateMatrixWorld();
    for (let i = 0; i < 4; i++) {
      const w = this.wheelContacts[i].copy(WHEEL_LOCAL[i]).applyMatrix4(this.group.matrixWorld);
      w.y = this.terrain.heightAt(w.x, w.z);
    }
  }

  sync(config) {
    const v = config.vehicle;
    this.headlightMat.color.set(v.headlightColor).multiplyScalar(v.headlightIntensity);
    this.lightBarMat.color.set(v.headlightColor).multiplyScalar(v.headlightIntensity * 0.6);
    this.spot.color.set(v.headlightColor);
    this.spot.intensity = v.spotIntensity;
    this.beamMat.uniforms.uColor.value.set(v.headlightColor);
  }
}
