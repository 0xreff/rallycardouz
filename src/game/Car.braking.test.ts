import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Physics } from "../physics/Physics";
import { Car } from "./Car";
import { CARS } from "./CarSpec";

const stopped = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const dt = Physics.FIXED_DT;
let physics: Physics | undefined;

afterEach(() => {
  physics?.world.free();
  physics = undefined;
});

async function groundedCar() {
  physics = await Physics.create();
  const R = physics.rapier;
  physics.world.createCollider(R.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0));
  // Ribbon skid-mark API (see engine/SkidMarks.ts). `addPoint(..., strength 0)` only
  // closes a trail, so it doesn't count as laying a mark.
  const skids = { addPoint: vi.fn(), stamp: vi.fn(), endTrail: vi.fn() };
  const sparks = { emit: vi.fn() };
  const smoke = { emit: vi.fn() };
  const dust = { emit: vi.fn() };
  type Args = ConstructorParameters<typeof Car>;
  const car = new Car(
    physics, new THREE.Scene(), new THREE.Vector3(0, 1, 0), CARS.bolt,
    skids as unknown as Args[4], sparks as unknown as Args[5],
    smoke as unknown as Args[6], dust as unknown as Args[7]
  );
  for (let i = 0; i < 240; i++) physics.step(dt, (step) => car.update(stopped, step));
  expect(car.isAirborne()).toBe(false);
  return { car, skids, smoke, dust };
}

/** Number of calls that actually lay a mark on the ground. */
function marksLaid(skids: { addPoint: ReturnType<typeof vi.fn>; stamp: ReturnType<typeof vi.fn> }) {
  const strength = (c: unknown[]) => c[4] as number;
  return skids.addPoint.mock.calls.filter((c) => strength(c) > 0).length + skids.stamp.mock.calls.length;
}

describe("stationary handbrake", () => {
  it("clears tiny horizontal creep and yaw without stationary wheel effects", async () => {
    const { car, skids, smoke, dust } = await groundedCar();
    car.body.setLinvel({ x: 0.0005, y: 0, z: 0.0005 }, true);
    car.body.setAngvel({ x: 0, y: 0.01, z: 0 }, true);
    car.update({ ...stopped, handbrake: true }, dt);
    // Exact zero, sign-agnostic: Rapier may return -0, which toBe (Object.is) rejects.
    expect(Math.abs(car.body.linvel().x)).toBe(0);
    expect(Math.abs(car.body.linvel().z)).toBe(0);
    expect(Math.abs(car.body.angvel().y)).toBe(0);
    car.syncMeshes();
    expect(marksLaid(skids)).toBe(0);
    expect(smoke.emit).not.toHaveBeenCalled();
    expect(dust.emit).not.toHaveBeenCalled();
  });

  it("does not cancel horizontal or vertical velocity while airborne", async () => {
    const { car } = await groundedCar();
    car.body.setTranslation({ x: 0, y: 20, z: 0 }, true);
    car.body.setLinvel({ x: 0.01, y: -3, z: 0.02 }, true);
    car.body.setAngvel({ x: 0.1, y: 0.01, z: 0.2 }, true);
    car.update({ ...stopped, handbrake: true }, dt);
    expect(car.isAirborne()).toBe(true);
    expect(car.body.linvel().x).toBeCloseTo(0.01);
    expect(car.body.linvel().y).toBeCloseTo(-3);
    expect(car.body.linvel().z).toBeCloseTo(0.02);
    expect(car.body.angvel().y).toBeCloseTo(0.01);
  });

  it("preserves throttle-plus-handbrake burnouts", async () => {
    const { car, smoke, skids } = await groundedCar();
    car.update({ ...stopped, throttle: 1, handbrake: true }, dt);
    car.syncMeshes();
    expect(smoke.emit).toHaveBeenCalled();
    expect(skids.stamp).toHaveBeenCalled(); // scrub patch under the spinning wheels
  });

  it("can accelerate again after releasing the handbrake", async () => {
    const { car } = await groundedCar();
    car.update({ ...stopped, handbrake: true }, dt);
    for (let i = 0; i < 60; i++) {
      physics!.step(dt, (step) => car.update({ ...stopped, throttle: 1 }, step));
    }
    expect(car.velocity().dot(car.forwardVector())).toBeGreaterThan(0.5);
  });
});
