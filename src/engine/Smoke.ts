import * as THREE from "three";

/** Soft round puff texture (white core fading to transparent) used as the smoke sprite. */
function makePuffTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

/**
 * Tyre smoke — soft grey puffs that bloom from the wheels under wheelspin or
 * lockup, growing and rising as they fade. A custom point shader does the per-
 * particle grow + fade-in/out from a single `aLife` (0=born → 1=dead) attribute;
 * the rest (motion, recycling) is CPU-side with a ring-buffer cursor. Owned by the
 * Game, fed by the cars.
 */
export class Smoke {
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private aLife: Float32Array;
  private cursor = 0;

  constructor(scene: THREE.Scene, private max = 600) {
    this.pos = new Float32Array(max * 3).fill(-9999);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.aLife = new Float32Array(max).fill(1); // start dead (invisible)
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aLife", new THREE.BufferAttribute(this.aLife, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: makePuffTexture() }, uSize: { value: 95 } },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aLife;
        varying float vLife;
        uniform float uSize;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float grow = 0.5 + aLife * 1.6;           // puff expands as it ages
          gl_PointSize = uSize * grow / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying float vLife;
        void main() {
          float tex = texture2D(uMap, gl_PointCoord).a;
          float fadeIn = smoothstep(0.0, 0.12, vLife);
          float fadeOut = 1.0 - smoothstep(0.45, 1.0, vLife);
          float a = tex * fadeIn * fadeOut * 0.32;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.82), a);
        }
      `,
    });

    const pts = new THREE.Points(this.geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  /** Puff `count` smoke particles from (x,y,z); `strength` (0..1) widens the spread. */
  emit(x: number, y: number, z: number, count: number, strength: number) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      this.pos[i3] = x + (Math.random() - 0.5) * 0.3;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.3;
      const spread = 0.6 + strength * 1.2;
      this.vel[i3] = (Math.random() - 0.5) * spread;
      this.vel[i3 + 1] = 0.6 + Math.random() * 0.8; // rise
      this.vel[i3 + 2] = (Math.random() - 0.5) * spread;
      this.age[i] = 0;
      this.life[i] = 0.5 + Math.random() * 0.7;
      this.aLife[i] = 0;
    }
  }

  /** Advance all live puffs: rise, drift, expand, fade. Call once per frame. */
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
      this.vel[i3 + 1] += 1.5 * dt; // buoyancy
      this.vel[i3] *= 0.94;
      this.vel[i3 + 2] *= 0.94;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.aLife[i] = this.age[i] / this.life[i];
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
  }
}
