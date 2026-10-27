import * as THREE from "three";
import type { Car } from "./Car";
import type { Track } from "./Track";

/**
 * A single-lap race on the west sand-road loop.
 *
 * Checkpoint gates are laid along the road's centreline polyline (Track.coursePoints):
 * start/finish at the spawn, then gates every ~12% of the loop. A car must cross the
 * gates in order — crossing gate k when it's not next doesn't count, so cutting the
 * course won't cheat a lap. The gate is a signed-distance strip across the road:
 * a car "crosses" when it passes within the half-width of the gate.
 *
 * The race runs: countdown (3-2-1-GO, controls locked) → live → finished after
 * `totalLaps`. Position is measured by progress along the course (lap fraction +
 * completed laps), so the player-vs-bot gap is real, not a wall-clock race.
 */
export type RacePhase = "countdown" | "live" | "finished";

export interface RaceHud {
  phase: RacePhase;
  countdown: number;       // 3,2,1 then 0 during live
  lap: number;             // current lap (1-based), totalLaps+ when finished
  totalLaps: number;
  lapTime: number;         // s, current lap's running time
  lastLap: number;         // s, last completed lap time (0 = none yet)
  bestLap: number;         // s, best lap this race (0 = none yet)
  raceTime: number;        // s since the green light
  delta: number;           // s ahead(-)/behind(+) of the best lap at this gate, 0 = no reference yet
  progress: number;        // 0..1 through the whole race (laps)
  nextGate: THREE.Vector3; // world position of the next checkpoint
  gateIndex: number;       // which gate is next (for a "WRONG WAY" hint etc.)
  gateDist: number;        // m to the next gate (straight line)
  gateBearing: number;     // rad: direction to the next gate in the car's frame (+ = right)
  finished: boolean;
}

// How far around the loop the gates sit (fractions of the polyline, ~8 gates).
const GATE_FRAC = [0, 0.13, 0.26, 0.38, 0.5, 0.63, 0.76, 0.88];
const GATE_HALF_W = 14; // m each side of the centreline the gate spans
const GATE_HALF_L = 6;  // m along the road the gate strip extends

export class Race {
  readonly totalLaps = 3;

  private pts!: Float32Array;
  private n = 0;
  // Gate positions and tangents (direction of travel through the gate).
  private gates: { x: number; z: number; tx: number; tz: number }[] = [];
  private gateMeshes: THREE.Group[] = [];

  private phase: RacePhase = "countdown";
  private countdown = 3;
  private countdownT = 0;
  private raceT = 0;      // s since green
  private goT = -1;       // <0 = not started; ≥0 = "GO!" has been shown this long
  private lapStartT = 0;  // raceT at the current lap's green
  private lastLap = 0;
  private bestLap = 0;
  private lap = 1;
  // Split times: raceT at each gate crossing for the current lap and the best lap.
  private splits: number[] = [];
  private bestSplits: number[] = [];

  // Per-entrant progress: how many gates each has passed + how far toward the next.
  private progress: Map<Car, { gate: number; lap: number; frac: number; lastD: number }> = new Map();
  private player!: Car;

  private _nextGate = new THREE.Vector3();

  constructor(
    private track: Track,
    private scene: THREE.Scene,
  ) {}

  /** Build the gates on the course and park the player at the start. Call once. */
  start(player: Car): boolean {
    const course = this.track.coursePoints();
    if (!course) return false;
    this.player = player;
    this.pts = course.pts;
    this.n = course.n;
    this.buildGates();
    this.reset();
    return true;
  }

  /** Drop the player on the start line facing the course; leave the bot free-roaming. */
  reset() {
    const g0 = this.gates[0];
    const g1 = this.gates[1];
    const dirX = g1.x - g0.x, dirZ = g1.z - g0.z;
    const yaw = Math.atan2(dirX, dirZ); // facing the first gate
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));

    // Player dead-centre on the line, facing the course direction. The bot is NOT
    // reset — it roams free as ambient traffic while you race the clock.
    {
      const bx = g0.x, bz = g0.z;
      const y = this.track.heightAt(bx, bz) + 0.9;
      this.player.reset();
      this.player.body.setTranslation({ x: bx, y, z: bz }, true);
      this.player.body.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }, true);
      this.player.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.player.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    this.phase = "countdown";
    this.countdownT = 0;
    this.countdown = 3;
    this.raceT = 0;
    this.lap = 1;
    this.lastLap = 0;
    this.bestLap = 0;
    this.lapStartT = 0;
    this.goT = -1;

    // The player starts at gate 0 having "just crossed" it (gate index = 1 next).
    this.progress.set(this.player, { gate: 1, lap: 0, frac: 0, lastD: 0 });
    this.refreshGateVisuals();
  }

  /** Total race progress for a car (0..totalLaps): laps done + fraction to next gate. */
  private progressOf(car: Car): number {
    const p = this.progress.get(car);
    if (!p) return 0;
    return p.lap + p.frac;
  }

  private buildGates() {
    const N = this.n, P = this.pts;
    this.gates = [];
    for (const g of this.gateMeshes) this.scene.remove(g);
    this.gateMeshes = [];

    // Each gate: a point on the centreline + the road's direction there.
    for (let gi = 0; gi < GATE_FRAC.length; gi++) {
      const k = Math.floor(GATE_FRAC[gi] * N) % N;
      const kn = (k + 3) % N, kp = (k - 3 + N) % N;
      const tx = P[2 * kn] - P[2 * kp], tz = P[2 * kn + 1] - P[2 * kp + 1];
      const tl = Math.hypot(tx, tz) || 1;
      this.gates.push({ x: P[2 * k], z: P[2 * k + 1], tx: tx / tl, tz: tz / tl });
    }

    // Each gate: a glowing beacon pillar (a thin additive cylinder reaching the
    // sky — visible over any dune from kilometres away) + two ground poles + a
    // floating marker diamond. The next gate's pillar is green, the rest amber.
    const poleMat = new THREE.MeshBasicMaterial({ color: 0xffa028 });
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, 3.4, 8);
    const beamGeo = new THREE.CylinderGeometry(1.1, 1.6, 160, 10, 1, true);
    for (let gi = 0; gi < this.gates.length; gi++) {
      const g = this.gates[gi];
      const group = new THREE.Group();
      const side = { x: g.tz, z: -g.tx }; // road's right
      for (const s of [-1, 1]) {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        const px = g.x + side.x * s * GATE_HALF_W * 0.8;
        const pz = g.z + side.z * s * GATE_HALF_W * 0.8;
        pole.position.set(px, this.track.heightAt(px, pz) + 1.7, pz);
        group.add(pole);
      }
      // The beacon: additive blending, no depth write, double-sided — a soft
      // column of light you can see through a dune, not blocked by terrain.
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffb340,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(g.x, this.track.heightAt(g.x, g.z) + 80, g.z);
      group.add(beam);
      // A floating marker diamond over the gate so it's visible over crests.
      const diamond = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.9),
        new THREE.MeshBasicMaterial({ color: 0xffd34d, wireframe: true })
      );
      diamond.position.set(g.x, this.track.heightAt(g.x, g.z) + 4.2, g.z);
      diamond.userData.spin = true;
      group.add(diamond);
      this.scene.add(group);
      this.gateMeshes.push(group);
    }
  }

  /** Re-tint the next gate (beam + diamond green, bigger) so the player knows where to go. */
  private refreshGateVisuals() {
    const next = this.progress.get(this.player)?.gate ?? 1;
    for (let gi = 0; gi < this.gateMeshes.length; gi++) {
      const group = this.gateMeshes[gi];
      const beam = group.children[2] as THREE.Mesh;
      const diamond = group.children[3] as THREE.Mesh;
      const beamMat = beam.material as THREE.MeshBasicMaterial;
      const mat = diamond.material as THREE.MeshBasicMaterial;
      const isNext = gi === next % this.gates.length;
      beamMat.color.set(isNext ? 0x33ff99 : 0xffb340);
      beamMat.opacity = isNext ? 0.30 : 0.10;
      mat.color.set(isNext ? 0x00ff88 : 0xffd34d);
      diamond.scale.setScalar(isNext ? 1.6 : 0.9);
      beam.visible = true;
    }
  }

  /**
   * Advance the race clock and gate detection by the real frame dt. The physics
   * positions are read per-frame (no substep needed — a car can't skip a gate in
   * 1/60 s when the gate strip is 12 m long and the car tops out ~70 m/s).
   */
  update(dt: number) {
    if (this.phase === "countdown") {
      this.countdownT += dt;
      this.countdown = Math.max(0, 3 - Math.floor(this.countdownT));
      if (this.countdownT >= 3.2) {
        this.phase = "live";
        this.raceT = 0;
        this.lapStartT = 0;
        this.goT = 0; // let "GO!" linger a beat on screen
      }
      return;
    }
    if (this.phase !== "live") return;
    if (this.goT >= 0) this.goT += dt;

    this.raceT += dt;

    // Gate detection: the car must cross the gates in order. A gate is crossed
    // when it passes within its strip while moving forward through it.
    for (const car of [this.player]) {
      const p = this.progress.get(car)!;
      const g = this.gates[p.gate % this.gates.length];
      const pos = car.position();
      const dx = pos.x - g.x, dz = pos.z - g.z;
      // Decompose into gate space: along = forward distance, across = lateral offset.
      const along = dx * g.tx + dz * g.tz;
      const across = dx * g.tz - dz * g.tx;
      const inStrip = Math.abs(across) < GATE_HALF_W && Math.abs(along) < GATE_HALF_L;
      // Moving forward through the gate (velocity toward the far side)?
      const vel = car.velocity();
      const through = vel.x * g.tx + vel.z * g.tz > 0.5;
      const was = p.lastD; // along-track offset last frame
      p.lastD = along;
      if (inStrip && through && was <= 0 && along > -GATE_HALF_L) {
        // Crossed the gate line going forward — record the split, advance to the next.
        const crossed = p.gate; // index of the gate just crossed (1-based)
        p.gate++;
        if (car === this.player) {
          this.splits[crossed % this.gates.length] = this.raceT;
          this.refreshGateVisuals();
        }
        // Wrapped past the last gate = a lap done.
        if (p.gate > this.gates.length) {
          p.gate = 1;
          p.lap++;
          if (car === this.player) {
            const lapTime = this.raceT - this.lapStartT;
            this.lastLap = lapTime;
            if (this.bestLap === 0 || lapTime < this.bestLap) {
              this.bestLap = lapTime;
              this.bestSplits = this.splits.slice();
            }
            this.splits = [];
            this.lap++;
            this.lapStartT = this.raceT;
            if (this.lap > this.totalLaps) this.phase = "finished";
          }
        }
      }
      // Progress fraction: how far between the previous gate and the next.
      const gi = (p.gate - 1 + this.gates.length) % this.gates.length;
      const prev = this.gates[gi], next = this.gates[p.gate % this.gates.length];
      const segLen = Math.hypot(next.x - prev.x, next.z - prev.z) || 1;
      const px = pos.x - prev.x, pz = pos.z - prev.z;
      const segT = (next.x - prev.x) / segLen, segZ = (next.z - prev.z) / segLen;
      p.frac = THREE.MathUtils.clamp((px * segT + pz * segZ) / segLen, 0, 1);
    }
  }

  /** True while the countdown is running and the cars shouldn't move. */
  locked(): boolean {
    return this.phase === "countdown";
  }

  /** HUD snapshot for this frame. Cheap: reads precomputed state. */
  hud(): RaceHud {
    const me = this.progress.get(this.player);
    const gateIdx = me ? me.gate % this.gates.length : 0;
    const g = this.gates[gateIdx];
    this._nextGate.set(g.x, this.track.heightAt(g.x, g.z) + 4.2, g.z);
    const playerProg = this.progressOf(this.player);
    // Delta vs best lap: compare this lap's split at the last crossed gate with
    // the best lap's split at the same gate. Negative = ahead of your best.
    let delta = 0;
    const lastGate = me ? (me.gate - 1 + this.gates.length) % this.gates.length : 0;
    if (this.bestSplits[lastGate] !== undefined && this.splits[lastGate] !== undefined && this.lap > 1) {
      delta = this.splits[lastGate] - this.bestSplits[lastGate];
    }
    // Bearing to the next gate in the car's own frame: 0 = dead ahead, + = to the
    // RIGHT, − = to the left. The HUD rotates a compass arrow by this angle.
    const pPos = this.player.position();
    const pFwd = this.player.forwardVector();
    const gdx = g.x - pPos.x, gdz = g.z - pPos.z;
    const gateDist = Math.hypot(gdx, gdz);
    // left-cross (fwd×dir on the XZ plane) is + for a left target; negate → + = right
    const bearing = -Math.atan2(pFwd.x * gdz - pFwd.z * gdx, pFwd.x * gdx + pFwd.z * gdz);
    return {
      phase: this.phase,
      countdown: this.countdown,
      lap: Math.min(this.lap, this.totalLaps),
      totalLaps: this.totalLaps,
      lapTime: this.phase === "live" ? this.raceT - this.lapStartT : 0,
      lastLap: this.lastLap,
      bestLap: this.bestLap,
      raceTime: this.raceT,
      delta,
      progress: playerProg / this.totalLaps,
      nextGate: this._nextGate,
      gateIndex: gateIdx,
      gateDist,
      gateBearing: bearing,
      finished: this.phase === "finished",
    };
  }
}
