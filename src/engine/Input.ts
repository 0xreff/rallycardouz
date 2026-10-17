/**
 * Keyboard input. Maps physical keys to an abstract control state the car reads.
 * Gamepad support is added in a later phase.
 */
export interface ControlState {
  throttle: number; // 0..1 forward
  brake: number;    // 0..1 reverse/brake
  steer: number;    // -1 (left) .. 1 (right)
  handbrake: boolean;
  unlockSixth: boolean; // held T: engages 6th gear while on the 5th-gear limiter
  reset: boolean;
  recover: boolean;   // flip the car back onto its wheels in place
  cycleCar: boolean;  // switch to the next car in the roster
  changeView: boolean; // cycle camera views
  lookLeft: boolean;  // swing camera 70deg left  (Q toggle)
  lookRight: boolean; // swing camera 70deg right (E toggle)
  lookBack: boolean;  // swing camera 180deg back
}

export class Input {
  private keys = new Set<string>();
  private resetEdge = false;
  private recoverEdge = false;
  private cycleEdge = false;
  private viewEdge = false;
  private lookBackToggle = false;
  private lookBackEdge = false;
  private lookLeftToggle = false;
  private lookLeftEdge = false;
  private lookRightToggle = false;
  private lookRightEdge = false;

  constructor() {
    window.addEventListener("keydown", (e) => {
      // Prevent page scroll on arrows/space while driving.
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
        e.preventDefault();
      }
      this.keys.add(e.key.toLowerCase());
      if (e.code) this.keys.add(e.code.toLowerCase());
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
      if (e.code) this.keys.delete(e.code.toLowerCase());
    });
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

    const viewDown = this.has("v");
    const changeView = viewDown && !this.viewEdge;
    this.viewEdge = viewDown;

    // Q toggles look-left, E toggles look-right (one click on, another off)
    const lookLeftDown = this.has("q");
    if (lookLeftDown && !this.lookLeftEdge) {
      this.lookLeftToggle = !this.lookLeftToggle;
      if (this.lookLeftToggle) this.lookRightToggle = false; // mutual-exclusive
    }
    this.lookLeftEdge = lookLeftDown;
    const lookLeft = this.lookLeftToggle;

    const lookRightDown = this.has("e");
    if (lookRightDown && !this.lookRightEdge) {
      this.lookRightToggle = !this.lookRightToggle;
      if (this.lookRightToggle) this.lookLeftToggle = false; // mutual-exclusive
    }
    this.lookRightEdge = lookRightDown;
    const lookRight = this.lookRightToggle;

    // 0 numpad / 0 tap-to-toggle: 1 tap/release switches to rear view, another tap/release switches back
    const lookBackDown = this.has("0", "numpad0", "digit0");
    if (lookBackDown && !this.lookBackEdge) {
      this.lookBackToggle = !this.lookBackToggle;
    }
    this.lookBackEdge = lookBackDown;
    const lookBack = this.lookBackToggle;

    // T is a held key (not edge-triggered) so a quick tap can't fall between two
    // physics substeps and get lost.
    const unlockSixth = this.has("t");

    return { throttle, brake, steer, handbrake: this.has(" "), unlockSixth, reset, recover, cycleCar, changeView, lookLeft, lookRight, lookBack };
  }
}
