/**
 * Surface types and their handling/FX properties. The Track registers every
 * static collider it creates against one of these; the Car probes the surface
 * under each wheel and scales its tyre grip, traction and particle FX to match —
 * tarmac bites, dirt runs wide, wheelspins and kicks up dust. This is the
 * rally-game core: the SAME car handles differently per surface.
 */
export type SurfaceType = "tarmac" | "dirt" | "wall";

export interface SurfaceProps {
  /** Lateral grip multiplier applied to the tyre side-friction (tarmac = 1). */
  grip: number;
  /** Traction multiplier for engine/brake force through the tyres (tarmac = 1). */
  traction: number;
  /** 0..1 how much dust rolling on this surface kicks up at speed. */
  dust: number;
}

export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  tarmac: { grip: 1.0, traction: 1.0, dust: 0.0 },
  dirt: { grip: 0.72, traction: 0.82, dust: 1.0 },
  wall: { grip: 0.9, traction: 0.9, dust: 0.0 },
};

/** Collider-handle → surface-type registry (owned by the Track). */
export class SurfaceMap {
  private map = new Map<number, SurfaceType>();

  register(handle: number, type: SurfaceType) {
    this.map.set(handle, type);
  }

  /** Surface for a collider handle; unregistered colliders count as dirt (open terrain). */
  get(handle: number): SurfaceProps {
    return SURFACES[this.map.get(handle) ?? "dirt"];
  }
}
