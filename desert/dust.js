import * as THREE from 'three';
import { atmosphereUniforms, ATMOSPHERE_GLSL } from './atmosphere.js';
import { mulberry32, GLSL_NOISE } from './noise.js';

// Soft cloudy puff generated on a canvas (alpha only).
function makePuffTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rand = mulberry32(11);
  for (let i = 0; i < 26; i++) {
    const r = size * (0.12 + rand() * 0.22);
    const a = rand() * Math.PI * 2, d = rand() * size * 0.22;
    const x = size / 2 + Math.cos(a) * d, y = size / 2 + Math.sin(a) * d;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(size / 2, size / 2, size * 0.15, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Wheel dust: one instanced billboard draw call. CPU simulation over flat typed
 * arrays (no per-frame allocations), swap-remove compaction, unsorted with
 * depthWrite off (fine for similar-coloured soft particles).
 */
export class DustSystem {
  constructor(scene, terrain, config, capacity) {
    this.config = config;
    this.capacity = capacity;
    this.limit = capacity;
    this.count = 0;
    this.rand = mulberry32(5);
    this.spawnAcc = [0, 0, 0, 0];
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.rotSpeed = new Float32Array(capacity);
    this.ground = new Float32Array(capacity);
    this.intensity = new Float32Array(capacity);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this.aPosLife = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPosLife', this.aPosLife);
    geo.setAttribute('iData', this.aData);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.uniforms = {
      ...atmosphereUniforms,
      uTex: { value: makePuffTexture() },
      uDustColor: { value: new THREE.Color() },
      uDustLit: { value: new THREE.Color() },
      uOpacity: { value: 0.55 },
      uBacklight: { value: 1.4 },
      uBackPower: { value: 4 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec4 iPosLife; // xyz world position, w life 0..1
        attribute vec4 iData;    // x size, y rotation, z ground height, w intensity
        varying vec2 vUv; varying vec3 vWorld; varying float vLife; varying float vIntensity;
        varying float vGroundY; varying float vSize; varying float vViewZ;
        void main() {
          vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(iData.y), s = sin(iData.y);
          vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iData.x;
          vec3 world = iPosLife.xyz + camRight * q.x + camUp * q.y;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          vUv = uv; vWorld = world; vLife = iPosLife.w; vIntensity = iData.w;
          vGroundY = iData.z; vSize = iData.x; vViewZ = -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        uniform vec3 uDustColor;
        uniform vec3 uDustLit;
        uniform float uOpacity;
        uniform float uBacklight;
        uniform float uBackPower;
        varying vec2 vUv; varying vec3 vWorld; varying float vLife; varying float vIntensity;
        varying float vGroundY; varying float vSize; varying float vViewZ;
        ${ATMOSPHERE_GLSL}
        void main() {
          float a = texture2D(uTex, vUv).a;
          float lifeA = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.35, 1.0, vLife));
          float ground = smoothstep(0.0, vSize * 0.35, vWorld.y - vGroundY + vSize * 0.05); // soft ground contact
          float nearCam = smoothstep(0.8, 4.0, vViewZ);
          float alpha = a * lifeA * vIntensity * uOpacity * ground * nearCam;
          if (alpha < 0.003) discard;
          vec3 viewDir = normalize(vWorld - cameraPosition);
          float mu = max(dot(viewDir, uSunDir), 0.0);
          float fwd = pow(mu, uBackPower) * uBacklight; // forward scattering
          float thin = 1.0 - smoothstep(0.0, 0.6, a);     // thin edges glow most
          vec3 col = mix(uDustColor * (0.7 + 0.3 * mu), uDustLit, clamp(fwd * 0.6, 0.0, 1.0));
          col += uSunColor * fwd * (0.25 + thin * 0.9);
          gl_FragColor = vec4(applyAtmosphere(col, vWorld), alpha);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
    this.sync(config);
  }

  setLimit(n) {
    this.limit = Math.min(n, this.capacity);
    if (this.count > this.limit) this.count = this.limit;
  }

  _spawn(vehicle, at, sf) {
    if (this.count >= this.limit) return;
    const i = this.count++, i3 = i * 3, r = this.rand, cfg = this.config.dust;
    const v = vehicle.velocity, f = vehicle.forwardFlat;
    this.pos[i3] = at.x + (r() - 0.5) * 0.5;
    this.pos[i3 + 1] = at.y + 0.25 + r() * 0.2;
    this.pos[i3 + 2] = at.z + (r() - 0.5) * 0.5;
    this.vel[i3] = v.x * 0.3 - f.x * sf * 3 + (r() - 0.5) * 2.4;
    this.vel[i3 + 1] = 0.5 + r() * 1.6 * (0.4 + sf);
    this.vel[i3 + 2] = v.z * 0.3 - f.z * sf * 3 + (r() - 0.5) * 2.4;
    this.age[i] = 0;
    this.life[i] = (2.5 + r() * 3) * cfg.lifetime;
    this.size0[i] = (0.9 + r() * 1.1) * cfg.size * (0.6 + sf * 0.6);
    this.rot[i] = r() * Math.PI * 2;
    this.rotSpeed[i] = (r() - 0.5) * 0.6;
    this.ground[i] = at.y;
    this.intensity[i] = (0.55 + r() * 0.45) * (0.4 + 0.6 * sf);
  }

  _copy(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) { this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k]; }
    this.age[to] = this.age[from]; this.life[to] = this.life[from]; this.size0[to] = this.size0[from];
    this.rot[to] = this.rot[from]; this.rotSpeed[to] = this.rotSpeed[from];
    this.ground[to] = this.ground[from]; this.intensity[to] = this.intensity[from];
  }

  update(dt, vehicle) {
    const cfg = this.config.dust;
    const sf = Math.min(1, Math.abs(vehicle.speed) / this.config.vehicle.maxSpeed);
    if (sf > 0.04 && cfg.amount > 0) {
      for (let w = 0; w < 4; w++) {
        const rate = 30 * cfg.amount * Math.pow(sf, 1.2) * (vehicle.wheelIsRear[w] ? 1 : 0.4) * (1 + vehicle.slip * 1.5);
        this.spawnAcc[w] += rate * dt;
        while (this.spawnAcc[w] >= 1) {
          this.spawnAcc[w] -= 1;
          this._spawn(vehicle, vehicle.wheelContacts[w], sf);
        }
      }
    }

    const wd = atmosphereUniforms.uWindDir.value, ws = atmosphereUniforms.uWindSpeed.value;
    const wx = wd.x * ws, wz = wd.y * ws;
    const k = 1 - Math.exp(-1.1 * dt), kv = 1 - Math.exp(-0.7 * dt);
    const pl = this.aPosLife.array, da = this.aData.array;
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this._copy(this.count - 1, i);
        this.count--;
        continue;
      }
      const i3 = i * 3, i4 = i * 4;
      this.vel[i3] += (wx - this.vel[i3]) * k;
      this.vel[i3 + 2] += (wz - this.vel[i3 + 2]) * k;
      this.vel[i3 + 1] += (0.35 - this.vel[i3 + 1]) * kv; // gentle buoyancy
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < this.ground[i] + 0.1) this.pos[i3 + 1] = this.ground[i] + 0.1;
      this.rot[i] += this.rotSpeed[i] * dt;
      const t = this.age[i] / this.life[i];
      pl[i4] = this.pos[i3]; pl[i4 + 1] = this.pos[i3 + 1]; pl[i4 + 2] = this.pos[i3 + 2]; pl[i4 + 3] = t;
      da[i4] = this.size0[i] * (1 + cfg.growth * Math.pow(t, 0.6));
      da[i4 + 1] = this.rot[i]; da[i4 + 2] = this.ground[i]; da[i4 + 3] = this.intensity[i];
      i++;
    }
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    this.aPosLife.needsUpdate = true;
    this.aData.needsUpdate = true;
  }

  sync(config) {
    const u = this.uniforms, d = config.dust;
    u.uDustColor.value.set(config.palette.dust);
    u.uDustLit.value.set(config.palette.dustLit);
    u.uOpacity.value = d.opacity;
    u.uBacklight.value = d.backlight;
    u.uBackPower.value = d.backPower;
  }
}

/**
 * Ground haze: a few large, low-opacity, camera-facing sheets at increasing
 * distances. Wispy noise is sampled in world space and drifts with the wind.
 * Cheaper than a screen-space height-fog pass; the main fog does the heavy lifting.
 */
export class HazeSheets {
  constructor(scene, terrain, config, maxSheets) {
    this.terrain = terrain;
    this.config = config;
    this.dists = [35, 80, 150, 260, 420, 650].slice(0, maxSheets);
    this.shared = {
      ...atmosphereUniforms,
      uOpacity: { value: 0.16 },
      uHazeSpeed: { value: 1 },
      uDustColor: { value: new THREE.Color() },
      uDustLit: { value: new THREE.Color() },
    };
    this.meshes = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < this.dists.length; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uSheetSeed: { value: i * 3.17 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv; varying vec3 vWorld;
          void main() {
            vUv = uv;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uOpacity; uniform float uHazeSpeed; uniform float uSheetSeed;
          uniform float uTime; uniform vec2 uWindDir; uniform float uWindSpeed;
          uniform vec3 uDustColor; uniform vec3 uDustLit;
          varying vec2 vUv; varying vec3 vWorld;
          ${GLSL_NOISE}
          ${ATMOSPHERE_GLSL}
          void main() {
            vec2 drift = uWindDir * uTime * uWindSpeed * 0.6 * uHazeSpeed;
            vec2 p = (vWorld.xz - drift) * 0.025 + vec2(uSheetSeed * 7.0, 0.0);
            float wisps = smoothstep(0.35, 0.85, fbm3(p + vec2(0.0, vWorld.y * 0.06)));
            float vertical = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.25, 1.0, vUv.y));
            float edges = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
            float nearCam = smoothstep(6.0, 30.0, length(vWorld - cameraPosition));
            float alpha = wisps * vertical * edges * nearCam * uOpacity;
            if (alpha < 0.002) discard;
            vec3 viewDir = normalize(vWorld - cameraPosition);
            float mu = max(dot(viewDir, uSunDir), 0.0);
            vec3 col = mix(uDustColor, uDustLit, pow(mu, 3.0)) + uSunColor * pow(mu, 8.0) * 0.6;
            gl_FragColor = vec4(applyAtmosphere(col, vWorld), alpha);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
    this.active = this.meshes.length;
    this._fwd = new THREE.Vector3();
    this.sync(config);
  }

  setCount(n) {
    this.active = Math.min(n, this.meshes.length);
    this.meshes.forEach((m, i) => (m.visible = i < this.active));
  }

  update(camera) {
    const f = camera.getWorldDirection(this._fwd);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
    f.normalize();
    const yaw = Math.atan2(-f.x, -f.z);
    const H0 = this.config.haze.height;
    for (let i = 0; i < this.active; i++) {
      const d = this.dists[i], m = this.meshes[i];
      const x = camera.position.x + f.x * d, z = camera.position.z + f.z * d;
      const h = H0 * (0.5 + d / 250), w = d * 2.4 + 40;
      m.scale.set(w, h, 1);
      m.position.set(x, this.terrain.heightAt(x, z) - h * 0.15 + h * 0.5, z);
      m.rotation.set(0, yaw, 0);
    }
  }

  sync(config) {
    this.shared.uOpacity.value = config.haze.opacity;
    this.shared.uHazeSpeed.value = config.haze.speed;
    this.shared.uDustColor.value.set(config.palette.dust);
    this.shared.uDustLit.value.set(config.palette.dustLit);
  }
}
