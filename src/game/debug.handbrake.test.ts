import { describe, it, vi } from "vitest";
import * as THREE from "three";
import { Physics } from "../physics/Physics";
import { Car } from "./Car";
import { CARS } from "./CarSpec";

// Temporary diagnostics: never fails, only prints the state the hold sees.
const stopped = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const dt = Physics.FIXED_DT;
const f = (n: number) => n.toFixed(5);

describe("DEBUG handbrake hold", () => {
  it("logs state", async () => {
    const physics = await Physics.create();
    const R = physics.rapier;
    physics.world.createCollider(R.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0));
    const fx = { add: vi.fn(), emit: vi.fn() };
    type Args = ConstructorParameters<typeof Car>;
    const car = new Car(
      physics, new THREE.Scene(), new THREE.Vector3(0, 1, 0), CARS.bolt,
      fx as unknown as Args[4], fx as unknown as Args[5], fx as unknown as Args[6], fx as unknown as Args[7]
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctl = (car as any).controller;
    const dump = (tag: string) => {
      const t = car.body.translation(), r = car.body.rotation(), v = car.body.linvel(), w = car.body.angvel();
      const c = [0, 1, 2, 3].map((i) => (ctl.wheelIsInContact(i) ? 1 : 0)).join("");
      const s = [0, 1, 2, 3].map((i) => f(ctl.wheelSuspensionLength(i) ?? -1)).join(",");
      console.log(
        `[DBG ${tag}] pos ${f(t.x)},${f(t.y)},${f(t.z)} rot ${f(r.x)},${f(r.y)},${f(r.z)},${f(r.w)} ` +
        `lin ${f(v.x)},${f(v.y)},${f(v.z)} ang ${f(w.x)},${f(w.y)},${f(w.z)} contact ${c} susp ${s}`
      );
    };
    for (let i = 0; i < 240; i++) {
      physics.step(dt, (step) => car.update(stopped, step));
      if (i % 40 === 0 || i > 235) dump(`settle ${i}`);
    }
    car.body.setLinvel({ x: 0.0005, y: 0, z: 0.0005 }, true);
    car.body.setAngvel({ x: 0, y: 0.01, z: 0 }, true);
    dump("before");
    car.update({ ...stopped, handbrake: true }, dt);
    dump("after");
    console.log(`[DBG] linvel.x is -0: ${Object.is(car.body.linvel().x, -0)}`);
    physics.world.free();
  });
});
