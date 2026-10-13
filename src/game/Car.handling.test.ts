import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Physics } from "../physics/Physics";
import { Car } from "./Car";
import { CARS, type CarSpec } from "./CarSpec";
import { SurfaceMap } from "./Surfaces";

// CarLights builds canvas textures; headless physics doesn't need it.
vi.mock("./CarLights", () => ({ CarLights: class { setBrake() {} } }));

/**
 * Headless handling tests: a real Rapier world with a big flat sand (dirt) floor and
 * the real Car class, driven by scripted controls. They pin down the *feel* the
 * steering/skid rework is meant to give, as numbers:
 *   - one tap at speed is a gentle turn, not a snap;
 *   - full lock at speed keeps most of the speed and doesn't spin the car;
 *   - pushing the car on sand makes it skid (so tyre marks appear);
 *   - the handbrake slides the car without spinning it out or stopping it dead.
 */

const SIM_CAR: CarSpec = { ...CARS.toyota, name: "SimToyota" }; // box body (no .glb to load)
const dt = Physics.FIXED_DT;
let physics: Physics | undefined;

afterEach(() => {
  physics?.world.free();
  physics = undefined;
});

interface Ctl { throttle: number; brake: number; steer: number; handbrake: boolean }
interface Sample { speed: number; lat: number; slip: number; yaw: number; heading: number; steer: number; skid: boolean }

async function drive(startSpeed: number, script: (t: number) => Ctl, seconds: number, surface: "dirt" | "tarmac" = "dirt") {
  physics = await Physics.create();
  const R = physics.rapier;
  const surfaces = new SurfaceMap();
  const floor = physics.world.createCollider(R.ColliderDesc.cuboid(900, 0.5, 900).setTranslation(0, -0.5, 0));
  surfaces.register(floor.handle, surface);
  const fx = { addPoint: vi.fn(), stamp: vi.fn(), endTrail: vi.fn(), emit: vi.fn() };
  type Args = ConstructorParameters<typeof Car>;
  const car = new Car(
    physics, new THREE.Scene(), new THREE.Vector3(0, 1, 0), SIM_CAR,
    fx as unknown as Args[4], fx as unknown as Args[5], fx as unknown as Args[6], fx as unknown as Args[7],
    surfaces
  );
  const idle: Ctl = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < 180; i++) physics.step(dt, (s) => car.update(idle, s)); // settle on the suspension
  car.body.setLinvel({ x: 0, y: 0, z: startSpeed }, true);

  const log: Sample[] = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    physics.step(dt, (s) => car.update({ ...script(t), unlockSixth: true } as Ctl, s));
    const v = car.body.linvel(), r = car.body.rotation(), w = car.body.angvel();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const lat = v.x * right.x + v.z * right.z;
    const fwdSpeed = v.x * fwd.x + v.z * fwd.z;
    log.push({
      speed: Math.hypot(v.x, v.z),
      lat,
      slip: Math.atan2(lat, fwdSpeed), // angle between travel direction and where the car points
      yaw: w.y,
      heading: Math.atan2(fwd.x, fwd.z),
      steer: (car as unknown as { steer: number }).steer,
      skid: (car as unknown as { wheelSkid: boolean[] }).wheelSkid.some(Boolean),
    });
  }
  return log;
}

const at = (t: number) => Math.round(t / dt);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));

describe("steering at speed", () => {
  it("a 0.12 s tap at ~36 m/s is a gentle turn, not a snap", async () => {
    const log = await drive(40, (t) => ({ throttle: 1, brake: 0, steer: t > 1 && t < 1.12 ? 1 : 0, handbrake: false }), 3);
    const turned = Math.abs(wrap(log[log.length - 1].heading - log[at(1)].heading));
    expect(turned).toBeLessThan(10 * Math.PI / 180);
    expect(maxAbs(log.map((s) => s.steer))).toBeLessThan(0.2); // lock is limited at speed
    expect(log[log.length - 1].speed).toBeGreaterThan(log[at(1)].speed - 3); // and it doesn't scrub speed
  }, 30000);

  it("full lock at top speed keeps most of the speed and does not spin the car", async () => {
    const log = await drive(40, (t) => ({ throttle: 1, brake: 0, steer: t > 1 ? 1 : 0, handbrake: false }), 3.5);
    const before = log[at(1) - 1].speed;
    const lowest = Math.min(...log.slice(at(1)).map((s) => s.speed));
    expect(lowest).toBeGreaterThan(before * 0.75);
    expect(maxAbs(log.map((s) => s.lat))).toBeLessThan(3);
    expect(maxAbs(log.map((s) => s.yaw))).toBeLessThan(1.2);
  }, 30000);

  it("still turns sharply at low speed (full lock when crawling)", async () => {
    const log = await drive(6, (t) => ({ throttle: 0.4, brake: 0, steer: t > 0.3 ? 1 : 0, handbrake: false }), 2.5);
    expect(maxAbs(log.map((s) => s.yaw))).toBeGreaterThan(1.0);
  }, 30000);
});

describe("reversing", () => {
  it("steers normally when backing up (the slide assists don't hijack the wheels)", async () => {
    const log = await drive(-6, (t) => ({ throttle: 0, brake: 1, steer: t > 0.3 ? 1 : 0, handbrake: false }), 2, "tarmac");
    expect(maxAbs(log.map((s) => s.steer))).toBeGreaterThan(0.3); // driver's lock, not an assist fighting it
    expect(maxAbs(log.map((s) => s.yaw))).toBeGreaterThan(0.2);
  }, 30000);
});

describe("skidding on sand (rally feel)", () => {
  it("a flick at speed starts a slide and lays tyre marks", async () => {
    const log = await drive(30, (t) => ({
      throttle: t < 1.5 ? 1 : 0, brake: 0, steer: t < 1 ? 0 : t < 1.4 ? -1 : t < 2.6 ? 1 : 0, handbrake: false,
    }), 4);
    expect(log.some((s) => s.skid)).toBe(true);
    expect(maxAbs(log.map((s) => s.lat))).toBeGreaterThan(2); // the tail really steps out
  }, 30000);

  it("a hard turn at speed shows front-tyre skids even before the car moves sideways", async () => {
    const log = await drive(30, (t) => ({ throttle: 1, brake: 0, steer: t > 0.5 ? 1 : 0, handbrake: false }), 3);
    expect(log.some((s) => s.skid)).toBe(true);
  }, 30000);

  it("lifting off mid-corner lets the tail out progressively and the car stays in one piece", async () => {
    const log = await drive(25, (t) => ({ throttle: t < 2.5 ? 1 : 0, brake: 0, steer: t > 0.5 ? 0.6 : 0, handbrake: false }), 4.5);
    expect(maxAbs(log.slice(at(1.5), at(2.5)).map((s) => s.lat))).toBeLessThan(1); // grippy while on the power
    const slideAfter = log.slice(at(2.5), at(3.3)).map((s) => Math.abs(s.lat));
    expect(slideAfter[slideAfter.length - 1]).toBeLessThan(5); // builds over ~0.8 s, no instant snap
  }, 30000);

  it("stays gripped (no skid) in an ordinary gentle corner", async () => {
    const log = await drive(15, (t) => ({ throttle: 0.5, brake: 0, steer: t > 0.5 ? 0.3 : 0, handbrake: false }), 3, "tarmac");
    expect(log.some((s) => s.skid)).toBe(false);
  }, 30000);
});

describe("handbrake", () => {
  it("straight-line handbrake keeps the car pointing the same way and brakes it gradually", async () => {
    const log = await drive(30, (t) => ({ throttle: 0, brake: 0, steer: 0, handbrake: t > 0.5 }), 3);
    expect(Math.abs(wrap(log[log.length - 1].heading))).toBeLessThan(2 * Math.PI / 180);
    expect(log[at(2.5)].speed).toBeGreaterThan(12); // doesn't stop dead
  }, 30000);

  it("handbrake + steering slides the car without spinning it out or stopping it", async () => {
    const log = await drive(30, (t) => ({ throttle: 0, brake: 0, steer: t > 0.5 ? 0.6 : 0, handbrake: t > 0.5 && t < 1.5 }), 5);
    expect(log.some((s) => s.skid)).toBe(true);
    expect(maxAbs(log.map((s) => s.yaw))).toBeLessThan(5);
    expect(log[at(2.5)].speed).toBeGreaterThan(10); // carries its speed through the slide
    // the car never points away from where it is travelling (no spin-out): slide angle < 80°
    expect(maxAbs(log.map((s) => s.slip))).toBeLessThan(1.4);
  }, 30000);
});
