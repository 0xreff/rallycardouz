import * as THREE from "three";

/**
 * Collision sparks: a pool of small additive points sprayed from a contact point and
 * thrown by gravity. Ring-buffer cursor recycles the oldest, so there is no per-frame
 * allocation. NO scorch marks are left on the ground any more.
 *
 * Life of a spark
 *  1. born  : very hot, brighter than 1.0 so the bloom pass makes it glow a little
 *  2. flying: cools along SPARK_RAMP (pale amber -> amber -> orange -> dark ember)
 *             and fades out. Most sparks die in the air.
 *  3. landed: the ones that reach the ground (some bounce once first) stay alive on it
 *             for a few milliseconds as a dim, cooling ember, then die.
 */

/** Palette taken from the desert theme (key light, horizon and ground colours). */
export const SPARK_RAMP: readonly { t: number; color: number }[] = [
  { t: 0.0, color: 0xfff1d6 }, // flash: hot pale amber-white
  { t: 0.15, color: 0xffd3a0 }, // key-light amber
  { t: 0.5, color: 0xe39a5a }, // horizon orange
  { t: 0.8, color: 0xb2561f }, // burnt orange
  { t: 1.0, color: 0x7a3a1c }, // dark ember (the scene's ground colour)
];

// ---- tuning knobs ----------------------------------------------------------
/** Brightness multiplier at birth (> bloom threshold so it glows). */
export const BIRTH_GLOW = 3.2;
/** How fast the birth flash settles (bigger = shorter flash). */
export const GLOW_DECAY = 14;
/** Fraction of the flight after which the spark starts to fade out. */
export const FADE_START = 0.55;
/** Time in the air before a spark dies (s). */
export const AIR_LIFE_MIN = 0.12;
export const AIR_LIFE_RANGE = 0.3;
/** Time a landed spark stays alive on the ground (s) - a few milliseconds. */
export const REST_MIN = 0.05;
export const REST_RANGE = 0.11;
/** Chance that a fast-falling spark bounces once instead of landing. */
export const BOUNCE_CHANCE = 0.3;
export const GRAVITY = 22;
export const POINT_SIZE = 0.09;

// ---- pure helpers (unit-tested) --------------------------------------------
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const RAMP = SPARK_RAMP.map((s) => ({ t: s.t, c: new THREE.Color(s.color) }));

/** Colour of a spark at heat `t` (0 = hottest, 1 = cold ember). Writes into `out`. */
export function rampColor(t: number, out: THREE.Color): THREE.Color {
  const x = clamp01(t);
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i].t) {
      const a = RAMP[i - 1], b = RAMP[i];
      return out.copy(a.c).lerp(b.c, (x - a.t) / (b.t - a.t));
    }
  }
  return out.copy(RAMP[RAMP.length - 1].c);
}

/** Brightness multiplier for a flying spark of age 0..1: birth flash, then fade-out. */
export function sparkBrightness(age: number): number {
  const a = clamp01(age);
  const glow = 1 + (BIRTH_GLOW - 1) * Math.exp(-a * GLOW_DECAY);
  const fade = clamp01((1 - a) / (1 - FADE_START));
  return glow * fade;
}

export class Sparks {
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;      // > 0 = alive (in the air OR resting on the ground)
  private maxLife: Float32Array;   // air life at emit
  private rest: Float32Array;      // > 0 = resting on the ground, seconds left
  private restMax: Float32Array;
  private landAge: Float32Array;   // age (0..1) at the moment it landed
  private gain: Float32Array;      // per-spark brightness variation
  private bounced: Uint8Array;
  private groundY: Float32Array;
  private cursor = 0;
  private tmp = new THREE.Color();

  constructor(scene: THREE.Scene, private max = 800) {
    this.pos = new Float32Array(max * 3).fill(-9999); // park unused particles offscreen
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.rest = new Float32Array(max);
    this.restMax = new Float32Array(max);
    this.landAge = new Float32Array(max);
    this.gain = new Float32Array(max);
    this.bounced = new Uint8Array(max);
    this.groundY = new Float32Array(max);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));

    const mat = new THREE.PointsMaterial({
      size: POINT_SIZE,
      sizeAttenuation: true,
      vertexColors: true, // colour (and brightness > 1 for the glow) comes per spark
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(this.geo, mat);
    points.frustumCulled = false;
    scene.add(points);
  }

  /** Spray `count` sparks from (x,y,z) roughly along `dir`, with random spread. */
  emit(x: number, y: number, z: number, dir: THREE.Vector3, count: number, speed: number, groundY: number = 0) {
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
      this.maxLife[i] = AIR_LIFE_MIN + Math.random() * AIR_LIFE_RANGE;
      this.life[i] = this.maxLife[i];
      this.rest[i] = 0;
      this.bounced[i] = 0;
      this.gain[i] = 0.75 + Math.random() * 0.25;
      this.groundY[i] = groundY;
      this.setColor(i, 0, BIRTH_GLOW);
    }
  }

  /** Advance all live sparks: gravity, drag, cooling colour, landing, death. */
  update(dt: number) {
    const drag = Math.exp(-18 * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;

      // --- resting on the ground: a short-lived dim ember ---
      if (this.rest[i] > 0) {
        this.rest[i] -= dt;
        if (this.rest[i] <= 0) {
          this.kill(i);
          continue;
        }
        const f = this.rest[i] / this.restMax[i]; // 1 -> 0
        this.vel[i3] *= drag;
        this.vel[i3 + 2] *= drag;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        const a = this.landAge[i];
        this.setColor(i, a + (1 - a) * (1 - f), (0.5 + 0.5 * (1 - a)) * f);
        continue;
      }

      // --- flying ---
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i); // died in the air, never reached the ground
        continue;
      }
      this.vel[i3 + 1] -= GRAVITY * dt;
      this.vel[i3] *= 0.96;
      this.vel[i3 + 2] *= 0.96;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const age = 1 - this.life[i] / this.maxLife[i];

      const gy = this.groundY[i];
      if (this.pos[i3 + 1] <= gy + 0.03 && this.vel[i3 + 1] < 0) {
        if (!this.bounced[i] && this.vel[i3 + 1] < -2 && Math.random() < BOUNCE_CHANCE) {
          this.bounced[i] = 1; // one small bounce
          this.vel[i3 + 1] *= -0.35;
          this.vel[i3] *= 0.6;
          this.vel[i3 + 2] *= 0.6;
          this.pos[i3 + 1] = gy + 0.04;
        } else {
          // reached the ground: stay alive there for a few milliseconds
          this.pos[i3 + 1] = gy + 0.02;
          this.vel[i3] *= 0.3;
          this.vel[i3 + 1] = 0;
          this.vel[i3 + 2] *= 0.3;
          this.landAge[i] = age;
          this.restMax[i] = this.rest[i] = REST_MIN + Math.random() * REST_RANGE;
        }
      }
      this.setColor(i, age, sparkBrightness(age));
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private setColor(i: number, heat: number, brightness: number) {
    rampColor(heat, this.tmp);
    const k = brightness * this.gain[i];
    const i3 = i * 3;
    this.col[i3] = this.tmp.r * k;
    this.col[i3 + 1] = this.tmp.g * k;
    this.col[i3 + 2] = this.tmp.b * k;
  }

  private kill(i: number) {
    this.life[i] = 0;
    this.rest[i] = 0;
    const i3 = i * 3;
    this.pos[i3 + 1] = -9999; // park offscreen
    this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0;
  }
}
