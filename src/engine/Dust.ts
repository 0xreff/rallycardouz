import * as THREE from "three";
import { getPuffTexture } from "./PuffTexture";

/**
 * Loose-surface dust — warm, earthy clouds kicked up behind the wheels on dirt,
 * scaled by speed and slip. Same pooled ring-buffer + point-shader design as
 * Smoke, but the particles are thrown back along the wheel's travel, hang lower,
 * grow bigger and linger longer — a rally dust trail, not tyre smoke. Owned by
 * the Game, fed by the cars (via CarFX).
 */
export class Dust {
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private aLife: Float32Array;
  private cursor = 0;

  constructor(scene: THREE.Scene, private max = 1300) {
    this.pos = new Float32Array(max * 3).fill(-9999);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.aLife = new Float32Array(max).fill(1); // start dead (invisible)
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aLife", new THREE.BufferAttribute(this.aLife, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: getPuffTexture() }, uSize: { value: 115 } },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aLife;
        varying float vLife;
        uniform float uSize;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float grow = 0.6 + aLife * 2.4;           // dust billows wide as it ages
          gl_PointSize = uSize * grow / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying float vLife;
        void main() {
          float tex = texture2D(uMap, gl_PointCoord).a;
          float fadeIn = smoothstep(0.0, 0.1, vLife);
          float fadeOut = 1.0 - smoothstep(0.35, 1.0, vLife);
          float a = tex * fadeIn * fadeOut * 0.4;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.80, 0.55, 0.34), a); // warm amber desert dust (lit by the low sun)
        }
      `,
    });

    const pts = new THREE.Points(this.geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  /**
   * Kick `count` dust particles up at (x,y,z). `strength` (0..1) scales spread
   * and loft; (vx,vz) is the wheel's ground velocity — dust is thrown back
   * along the travel direction so it trails the car.
   */
  emit(x: number, y: number, z: number, count: number, strength: number, vx = 0, vz = 0) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      this.pos[i3] = x + (Math.random() - 0.5) * 0.4;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.4;
      const spread = 0.8 + strength * 1.4;
      this.vel[i3] = -vx * 0.22 + (Math.random() - 0.5) * spread;
      this.vel[i3 + 1] = 0.3 + Math.random() * 0.8 * strength; // low loft — dust hangs
      this.vel[i3 + 2] = -vz * 0.22 + (Math.random() - 0.5) * spread;
      this.age[i] = 0;
      this.life[i] = 0.7 + Math.random() * 0.9; // lingers longer than smoke
      this.aLife[i] = 0;
    }
  }

  /** Advance all live dust: drift, settle, expand, fade. Call once per frame. */
  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      const i3 = i * 3;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.aLife[i] = 1;
        this.pos[i3 + 1] = -9999;
        continue;
      }
      this.vel[i3 + 1] += 0.5 * dt; // slight buoyancy — dust rises less than smoke
      this.vel[i3] *= 0.92;
      this.vel[i3 + 2] *= 0.92;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.aLife[i] = this.age[i] / this.life[i];
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
  }
}
