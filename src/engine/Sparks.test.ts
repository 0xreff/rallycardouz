import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Sparks, SPARK_RAMP, BIRTH_GLOW, sparkBrightness, rampColor } from "./Sparks";

describe("spark colour and brightness", () => {
  it("is born brighter than 1 (so it blooms) and ends dark", () => {
    expect(sparkBrightness(0)).toBeCloseTo(BIRTH_GLOW);
    expect(sparkBrightness(1)).toBe(0);
  });
  it("settles after the flash and never brightens again", () => {
    let prev = Infinity;
    for (let a = 0; a <= 1.0001; a += 0.02) {
      const b = sparkBrightness(a);
      expect(b).toBeLessThanOrEqual(prev + 1e-9);
      prev = b;
    }
  });
  it("the ramp starts on the first palette stop and ends on the last", () => {
    const first = new THREE.Color(SPARK_RAMP[0].color);
    const last = new THREE.Color(SPARK_RAMP[SPARK_RAMP.length - 1].color);
    const c = new THREE.Color();
    expect(rampColor(0, c).equals(first)).toBe(true);
    expect(rampColor(1, c).equals(last)).toBe(true);
    expect(rampColor(5, c).equals(last)).toBe(true); // clamped
  });
});

describe("Sparks lifecycle", () => {
  function run() {
    const scene = new THREE.Scene();
    const sparks = new Sparks(scene, 400);
    const points = scene.children[0] as THREE.Points;
    const pos = points.geometry.attributes.position.array as Float32Array;
    sparks.emit(0, 0.3, 0, new THREE.Vector3(0, 0, 1), 200, 3, 0);
    let groundFrames = 0, t = 0;
    const alive = () => { for (let i = 1; i < pos.length; i += 3) if (pos[i] > -9000) return true; return false; };
    while (alive() && t < 2) {
      sparks.update(1 / 120);
      t += 1 / 120;
      for (let i = 1; i < pos.length; i += 3) if (Math.abs(pos[i] - 0.02) < 1e-4) { groundFrames++; break; }
    }
    return { scene, groundFrames, t, alive: alive() };
  }

  it("adds only the glowing points to the scene - no scorch marks on the ground", () => {
    const { scene } = run();
    expect(scene.children.length).toBe(1);
    expect(scene.children[0]).toBeInstanceOf(THREE.Points);
  });
  it("every spark dies within about a second", () => {
    const r = run();
    expect(r.alive).toBe(false);
    expect(r.t).toBeLessThan(1);
  });
  it("some sparks reach the ground and stay there for a few frames before dying", () => {
    expect(run().groundFrames).toBeGreaterThan(2);
  });
});
