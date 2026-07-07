/**
 * Keyboard input. Maps physical keys to an abstract control state the car reads.
 * Gamepad support is added in a later phase.
 */
export interface ControlState {
  throttle: number; // 0..1 forward
  brake: number;    // 0..1 reverse/brake
  steer: number;    // -1 (left) .. 1 (right)
  handbrake: boolean;
  reset: boolean;
  recover: boolean;   // flip the car back onto its wheels in place
  cycleCar: boolean;  // switch to the next car in the roster
}

export class Input {
  private keys = new Set<string>();
  private resetEdge = false;
  private recoverEdge = false;
  private cycleEdge = false;

  constructor() {
    window.addEventListener("keydown", (e) => {
      // Prevent page scroll on arrows/space while driving.
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
        e.preventDefault();
      }
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    // Drop all keys if the window loses focus (avoids "stuck throttle").
    window.addEventListener("blur", () => this.keys.clear());
  }

  private has(...k: string[]): boolean {
    return k.some((key) => this.keys.has(key));
  }

  sample(): ControlState {
    const throttle = this.has("w", "arrowup") ? 1 : 0;
    const brake = this.has("s", "arrowdown") ? 1 : 0;
    let steer = 0;
    if (this.has("a", "arrowleft")) steer -= 1;
    if (this.has("d", "arrowright")) steer += 1;

    const resetDown = this.has("r");
    const reset = resetDown && !this.resetEdge;
    this.resetEdge = resetDown;

    const recoverDown = this.has("f");
    const recover = recoverDown && !this.recoverEdge;
    this.recoverEdge = recoverDown;

    const cycleDown = this.has("c");
    const cycleCar = cycleDown && !this.cycleEdge;
    this.cycleEdge = cycleDown;

    return { throttle, brake, steer, handbrake: this.has(" "), reset, recover, cycleCar };
  }
}
