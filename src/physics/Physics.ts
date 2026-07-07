import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Thin wrapper around a Rapier physics world. Rapier is compiled to WebAssembly,
 * so it must be initialized asynchronously before any world is created.
 *
 * The simulation advances at a FIXED 60 Hz timestep through an accumulator:
 * however fast or slow the display renders, every physics step integrates the
 * same 1/60 s, so handling is deterministic and framerate-independent. Vehicle
 * forces must be applied per-substep (see `step`'s callback), not per-frame.
 */
export class Physics {
  /** Fixed integration step (s). All force application should use this dt. */
  static readonly FIXED_DT = 1 / 60;
  /** Cap on substeps per frame so a long frame (tab switch, GC pause) can't
   *  trigger a spiral of death — time beyond the cap is dropped. */
  private static readonly MAX_SUBSTEPS = 4;

  readonly world: RAPIER.World;
  readonly rapier = RAPIER;
  private accumulator = 0;

  private constructor(world: RAPIER.World) {
    this.world = world;
    this.world.timestep = Physics.FIXED_DT;
  }

  static async create(gravity = { x: 0, y: -9.81 * 2.2, z: 0 }): Promise<Physics> {
    // Gravity is scaled up (2.2x) to give the lightweight RC cars that snappy,
    // toy-like fall that defines the reference game's feel.
    await RAPIER.init();
    const world = new RAPIER.World(gravity);
    return new Physics(world);
  }

  /**
   * Advance the simulation by `dt` of real time in fixed 60 Hz substeps.
   * `beforeSubstep` runs immediately before each world step — apply vehicle
   * controls/forces there so they integrate with the fixed dt.
   */
  step(dt: number, beforeSubstep?: (fixedDt: number) => void) {
    this.accumulator = Math.min(this.accumulator + dt, Physics.FIXED_DT * Physics.MAX_SUBSTEPS);
    while (this.accumulator >= Physics.FIXED_DT) {
      beforeSubstep?.(Physics.FIXED_DT);
      this.world.step();
      this.accumulator -= Physics.FIXED_DT;
    }
  }
}
