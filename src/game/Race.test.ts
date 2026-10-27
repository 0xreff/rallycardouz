import { describe, it, vi, expect } from "vitest";
import * as THREE from "three";
import { Physics } from "../physics/Physics";
import { Car } from "./Car";
import { CARS, type CarSpec } from "./CarSpec";
import { Track } from "./Track";
import { Race } from "./Race";
vi.mock("./CarLights", () => ({ CarLights: class { setBrake() {} } }));
const SIM_CAR: CarSpec = { ...CARS.toyota, name: "SimToyota" };
const dt = Physics.FIXED_DT;
describe("race lap counting", () => {
  it("counts a lap when the car is teleported through all gates in order", async () => {
    const physics = await Physics.create();
    const scene = new THREE.Scene();
    const track = new Track(physics, scene);
    const fx = { addPoint: vi.fn(), stamp: vi.fn(), endTrail: vi.fn(), emit: vi.fn() };
    const car = new Car(physics, scene, new THREE.Vector3(0, 2, 0), SIM_CAR,
      fx as any, fx as any, fx as any, fx as any, track.surfaces);
    const race = new Race(track, scene);
    expect(race.start(car)).toBe(true);
    // Skip countdown
    for (let i = 0; i < 200; i++) race.update(dt);
    expect(race.hud().phase).toBe("live");
    // Teleport the car forward through each gate in order, moving forward.
    const course = track.coursePoints()!;
    const N = course.n;
    const gates = [0, 0.13, 0.26, 0.38, 0.5, 0.63, 0.76, 0.88].map(f => Math.floor(f * N) % N);
    for (let g = 1; g <= gates.length; g++) {
      const k = gates[g % gates.length]; // next gate index (wraps to 0 for the lap)
      const x = course.pts[2 * k], z = course.pts[2 * k + 1];
      // Approach from behind the gate moving forward through it.
      const kn = (k + 3) % N, kp = (k - 3 + N) % N;
      const tx = course.pts[2 * kn] - course.pts[2 * kp], tz = course.pts[2 * kn + 1] - course.pts[2 * kp + 1];
      const tl = Math.hypot(tx, tz) || 1;
      // put the car just before the gate moving toward it, then step update twice
      car.body.setTranslation({ x: x - tx / tl * 3, y: track.heightAt(x, z) + 0.8, z: z - tz / tl * 3 }, true);
      car.body.setLinvel({ x: tx / tl * 10, y: 0, z: tz / tl * 10 }, true);
      race.update(dt);
      car.body.setTranslation({ x: x + tx / tl * 3, y: track.heightAt(x, z) + 0.8, z: z + tz / tl * 3 }, true);
      race.update(dt);
    }
    const h = race.hud();
    console.log(`lap=${h.lap} gate=${h.gateIndex} lastLap=${h.lastLap.toFixed(2)} delta=${h.delta.toFixed(2)}`);
    expect(h.lap).toBe(2); // one lap done, on lap 2
    expect(h.lastLap).toBeGreaterThan(0);
    physics.world.free();
  });
});
