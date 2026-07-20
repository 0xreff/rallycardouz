import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../physics/Physics";
import { createRimMaterial } from "../engine/RimMaterial";
import { SkidMarks } from "../engine/SkidMarks";
import { Sparks } from "../engine/Sparks";
import { Smoke } from "../engine/Smoke";
import { Dust } from "../engine/Dust";
import { CarFX } from "./CarFX";
import { SURFACES, SurfaceMap, type SurfaceProps } from "./Surfaces";
import { nextImpact, creepTopEndCap, speedFraction as computeSpeedFraction } from "./handling";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CarSpec } from "./CarSpec";

/**
 * Arcade RC car built on Rapier's raycast vehicle controller.
 *
 * The class holds NO hardcoded tuning — every dimension, force, grip and
 * stability value comes from the CarSpec passed in. Different cars (taller,
 * faster, more/less stable, FWD/RWD/AWD) are just different specs.
 *
 * Grip is additionally scaled per-axle by the SURFACE under the wheels (see
 * Surfaces.ts): the same car bites on the tarmac road and runs wide, wheelspins
 * and trails dust on the dirt terrain.
 */

// Wheel index layout: 0 = front-left, 1 = front-right, 2 = back-left, 3 = back-right
const FRONT = [0, 1];

// Grounded stabilizer gains (shared by all cars — keeps them from flipping).
const UPRIGHT_STIFFNESS = 26; // how hard the car springs back to level
const UPRIGHT_DAMPING = 7;    // damps the tilt rate so it doesn't oscillate

// Friction-circle coupling: a tyre's grip is shared between turning and braking.
// This is how much of the lateral grip the brake "spends" — higher = braking
// mid-corner washes out the turn more (and trail-braking rotates the car).
const FRICTION_CIRCLE = 0.55;

// Cosmetic body lean (visual only — the physics body never tips).
const LEAN_RATE = 6;    // how fast the body roll eases toward its target
const MAX_LEAN = 0.32;  // hard cap on the visual roll (~18°)

// Cap on the yaw rate the low-speed lift-off turn assist may induce (rad/s) — it
// can sharpen a turn but can't spin the car past this. Kept modest so rotation
// reads as tyre-driven, not a teleported spin (avoids the "disconnected" feel).
const MAX_ASSIST_YAW = 1.4;

// Sideways slip speed (m/s) above which a tyre is "sliding" enough to lay a skid mark.
const SKID_SLIP_SPEED = 1.6;

// While flipped, holding throttle/brake rolls the car back onto its wheels at this
// rate (rad/s about its length).
const RIGHTING_RATE = 2.6;

// Shared read-only axis constants (used only as setFromAxisAngle arguments, never
// mutated) to avoid allocating them every frame.
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class Car {
  readonly body: RAPIER.RigidBody;
  readonly spec: CarSpec;
  private controller: RAPIER.DynamicRayCastVehicleController;
  private chassisMesh: THREE.Object3D;
  private wheelMeshes: THREE.Mesh[] = [];
  private steer = 0;
  private appliedEngine = 0; // smoothed engine force (ref EngineRate ramp)
  private brakePressure = 0; // smoothed 0..1 brake "pedal" (pressure build-up)
  private visualLean = 0;    // cosmetic body roll (radians), eased toward the slide
  private topEndCap = 0;     // current top-speed cap (creeps from topSpeed → vMax)
  private prevVel = new THREE.Vector3(); // last frame's velocity (for impact detection)
  private impact = 0;        // 0..1 collision / hard-landing shake level (decays), for the camera
  private wheelSkid = [false, false, false, false]; // per-wheel: laying a skid mark?
  private wheelSmoke = [0, 0, 0, 0];                 // per-wheel: tyre-smoke intensity (0..1)
  private wheelDust = [0, 0, 0, 0];                  // per-wheel: surface-dust intensity (0..1)
  private wheelSurface: SurfaceProps[] = [SURFACES.tarmac, SURFACES.tarmac, SURFACES.tarmac, SURFACES.tarmac];
  private surfaceRay: RAPIER.Ray | null = null;      // reused downward probe (lazy — needs runtime Rapier)
  private burningOut = false; // throttle + brake/handbrake held stationary → burnout
  private burnoutSpin = 0;    // accumulated visual wheelspin for the driven wheels
  private fx: CarFX;          // sparks / skid marks / smoke / dust emitter
  private rotScratch = new THREE.Quaternion(); // reused for forward/right vector reads
  private physics: Physics;
  private collider!: RAPIER.Collider; // the chassis collider (for spark contacts)
  private spawnPos: THREE.Vector3;
  private spawnRot: THREE.Quaternion;

  // ---- Pre-allocated scratch objects (eliminates ~25 per-frame allocations) ----
  private _velVec = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  // update() self-right scratch
  private _upVec = new THREE.Vector3();
  private _worldUp = new THREE.Vector3(0, 1, 0);
  private _crossVec = new THREE.Vector3();
  private _wVec = new THREE.Vector3();
  // stabilize() scratch
  private _stabNormal = new THREE.Vector3();
  private _stabUp = new THREE.Vector3();
  private _stabAxis = new THREE.Vector3();
  private _stabW = new THREE.Vector3();
  private _stabNVec = new THREE.Vector3();
  private _stabFwd = new THREE.Vector3();
  private _stabRight = new THREE.Vector3();
  private _stabCorrective = new THREE.Vector3();
  // syncMeshes() scratch
  private _chassisQuat = new THREE.Quaternion();
  private _leanRoll = new THREE.Quaternion();
  private _chassisMat = new THREE.Matrix4();
  private _oneVec = new THREE.Vector3(1, 1, 1);
  private _wheelWorld = new THREE.Vector3();
  private _fxCp = new THREE.Vector3();
  private _cnVec = new THREE.Vector3();
  private _wheelQ = new THREE.Quaternion();
  private _steerQ = new THREE.Quaternion();
  private _rollQ = new THREE.Quaternion();
  // speedFraction() scratch
  private _speedFwd = new THREE.Vector3();
  // recover() scratch
  private _recoverQ = new THREE.Quaternion();
  private _recoverEuler = new THREE.Euler();
  // Reusable POJO for Rapier setLinvel / setAngvel (avoids { x, y, z } literals per frame)
  private _rv3 = { x: 0, y: 0, z: 0 };
  // ---- Physics interpolation: previous state for smooth rendering ----
  private _prevPos = new THREE.Vector3();
  private _prevRot = new THREE.Quaternion();
  private _interpPos = new THREE.Vector3();

  constructor(
    physics: Physics,
    scene: THREE.Scene,
    spawn: THREE.Vector3,
    spec: CarSpec,
    skids: SkidMarks,
    sparks: Sparks,
    smoke: Smoke,
    dust: Dust,
    private surfaces?: SurfaceMap
  ) {
    const R = physics.rapier;
    this.spec = spec;
    this.fx = new CarFX(skids, sparks, smoke, dust, surfaces);
    this.physics = physics;
    this.topEndCap = spec.topSpeed; // starts at the limit, creeps up under sustained throttle
    this.spawnPos = spawn.clone();
    this.spawnRot = new THREE.Quaternion();

    // --- Chassis rigid body ---
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(spec.linearDamping)
      .setAngularDamping(spec.angularDamping)
      .setCanSleep(false);
    this.body = physics.world.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc.cuboid(spec.halfWidth, spec.halfHeight, spec.halfLength)
      .setMass(spec.mass)
      .setFriction(0.5)
      .setRestitution(0.1);
    this.collider = physics.world.createCollider(colliderDesc, this.body);

    // Centre of mass + inertia define how easily the car rolls in a turn.
    this.body.setAdditionalMassProperties(
      spec.mass,
      spec.comOffset,
      spec.inertia,
      { w: 1, x: 0, y: 0, z: 0 },
      true
    );

    // --- Vehicle controller ---
    this.controller = physics.world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;       // Y is up
    this.controller.setIndexForwardAxis = 2; // +Z is forward

    // Suspension hard-point near the chassis bottom so wheels hang below the
    // body (radius > halfHeight) instead of poking up through it.
    const connY = -spec.halfHeight + 0.04;
    const connZFront = spec.halfLength - (spec.wheelZInsetFront ?? spec.wheelZInset ?? 0.25);
    const connZRear = spec.halfLength - (spec.wheelZInsetRear ?? spec.wheelZInset ?? 0.25);
    const connX = spec.halfWidth + (spec.wheelXOffset ?? 0);
    
    const wheelPositions = [
      new R.Vector3(-connX, connY, connZFront),   // FL
      new R.Vector3(connX, connY, connZFront),    // FR
      new R.Vector3(-connX, connY, -connZRear),   // BL
      new R.Vector3(connX, connY, -connZRear),    // BR
    ];
    const down = new R.Vector3(0, -1, 0);
    const axle = new R.Vector3(-1, 0, 0);

    for (const pos of wheelPositions) {
      this.controller.addWheel(pos, down, axle, spec.suspensionRest, spec.wheelRadius);
    }
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelSuspensionStiffness(i, spec.suspensionStiffness);
      this.controller.setWheelMaxSuspensionTravel(i, spec.suspensionTravel);
      this.controller.setWheelSuspensionCompression(i, spec.suspensionCompression);
      this.controller.setWheelSuspensionRelaxation(i, spec.suspensionRelaxation);
      this.controller.setWheelFrictionSlip(i, spec.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(i, spec.sideFrictionStiffness);
    }

    // --- Visuals (original low-poly geometry, sized from the spec) ---
    this.chassisMesh = this.buildChassis(spec);
    scene.add(this.chassisMesh);

    const wheelGeo = new THREE.CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 18);
    wheelGeo.rotateZ(Math.PI / 2); // align cylinder axis to local X (the axle)
    const useDebug = spec.name === "Tank" || spec.name === "Toyota";
    const wheelMat = useDebug 
      ? new THREE.MeshBasicMaterial({ color: 0xff00aa, wireframe: true, transparent: true, opacity: 0.4 })
      : createRimMaterial({ color: 0x14151a, metalness: 0.1, roughness: 0.8, rimStrength: 0.18 });
      
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(wheelGeo, wheelMat);
      m.castShadow = !useDebug;
      scene.add(m);
      this.wheelMeshes.push(m);
    }
  }

  private buildChassis(spec: CarSpec): THREE.Object3D {
    if (spec.name === "Tank" || spec.name === "Toyota" || spec.name === "Ram") {
      const root = new THREE.Group();
      const loader = new GLTFLoader();
      
      let glbPath = '/assets/d01c4c8e1685f8a60e41844cdde58a22.glb';
      if (spec.name === "Toyota") glbPath = '/assets/toyota.glb';
      else if (spec.name === "Ram") glbPath = '/assets/ram.glb';

      loader.load(glbPath, (gltf) => {
        const model = gltf.scene;

        // Calculate current bounding box
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());

        // Target size based on spec length, assuming typical car proportions
        // (chassis + some bumper/tire overhang).
        // Increase this multiplier (e.g. to 3.0 or 3.5) if the 3D model's tires
        // are too close together compared to the pink physics tires.
        // Decrease it (e.g. to 2.5) if they are too far apart.
        let modelMultiplier = spec.visualScaleMultiplier ?? 3.0; 
        if (!spec.visualScaleMultiplier && spec.name === "Toyota") {
          modelMultiplier = 4.0; 
        }
        
        const targetLength = spec.halfLength * modelMultiplier; 
        
        // Scale proportionally based on length
        const scale = targetLength / size.z;
        
        model.scale.setScalar(scale);

        // Re-calculate box after scaling to center it properly
        box.setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        
        // Offset model so its center aligns with the root (0,0,0)
        model.position.sub(center);
        
        // Apply visual rotation if defined
        if (spec.visualRotationY) {
          model.rotation.y = spec.visualRotationY;
        }

        // Ground alignment: push the car down so the visual tires hit the physics floor
        const connY = -spec.halfHeight + 0.04;
        const physicsBottom = connY - spec.suspensionRest - spec.wheelRadius;
        const visualBottom = - (size.y * scale) / 2;
        model.position.y += (physicsBottom - visualBottom) + (spec.visualYOffset ?? 0);

        // Slide the model forward/backward if it doesn't align with the physics wheelbase
        model.position.z += (spec.visualZOffset ?? 0);

        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            
            // Convert GLB materials to our custom RimMaterial so they get the cool edge glow
            // and don't look like flat black plastic due to the lack of an environment map!
            if (mesh.material) {
              const oldMat = mesh.material as THREE.MeshStandardMaterial;
              if (oldMat.isMeshStandardMaterial) {
                const newMat = createRimMaterial({
                  color: oldMat.color,
                  metalness: 0.15, // Low metalness so textures/colors remain visible without an HDRI
                  roughness: 0.6,
                });
                newMat.map = oldMat.map;
                newMat.normalMap = oldMat.normalMap;
                newMat.roughnessMap = oldMat.roughnessMap;
                newMat.metalnessMap = oldMat.metalnessMap;
                mesh.material = newMat;
              }
            }
          }
        });
        root.add(model);
      }, undefined, (error) => {
        console.error(`Failed to load ${glbPath}:`, error);
        root.add(this.buildProceduralChassis(spec));
      });
      return root;
    }

    return this.buildProceduralChassis(spec);
  }

  private buildProceduralChassis(spec: CarSpec): THREE.Object3D {
    const bodyMat = createRimMaterial({ color: spec.color, metalness: 0.45, roughness: 0.4 });
    const root = new THREE.Mesh(
      new THREE.BoxGeometry(spec.halfWidth * 2, spec.halfHeight * 2, spec.halfLength * 2),
      bodyMat
    );
    root.castShadow = true;

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(spec.halfWidth * 1.4, spec.halfHeight * 1.3, spec.halfLength * 0.9),
      createRimMaterial({ color: 0x0e1430, metalness: 0.2, roughness: 0.25, rimStrength: 0.4 })
    );
    cabin.position.set(0, spec.halfHeight * 1.1, -0.05);
    cabin.castShadow = true;
    root.add(cabin);

    return root;
  }

  /**
   * Probe what surface each wheel is rolling on: a short downward ray from just
   * above the wheel's contact point, resolved against the Track's SurfaceMap.
   * Airborne wheels keep their last known surface (harmless — FX/grip only
   * apply in contact). Cheap: ≤ 4 short rays per substep.
   */
  private updateSurfaces() {
    if (!this.surfaces) return;
    const R = this.physics.rapier;
    if (!this.surfaceRay) this.surfaceRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    for (let i = 0; i < 4; i++) {
      if (!this.controller.wheelIsInContact(i)) continue;
      const cp = this.controller.wheelContactPoint(i);
      if (!cp) continue;
      this.surfaceRay.origin.x = cp.x;
      this.surfaceRay.origin.y = cp.y + 0.3;
      this.surfaceRay.origin.z = cp.z;
      const hit = this.physics.world.castRay(this.surfaceRay, 1.0, true, undefined, undefined, undefined, this.body);
      if (hit) this.wheelSurface[i] = this.surfaces.get(hit.collider.handle);
    }
  }

  update(controls: { throttle: number; brake: number; steer: number; handbrake: boolean }, dt: number) {
    const spec = this.spec;
    this.updateSurfaces();

    // Velocity decomposed into the car's own axes.
    const vel = this.body.linvel();
    const velVec = this._velVec.set(vel.x, vel.y, vel.z);
    const fwd = this.forwardVector(this._fwd);
    const right = this.rightVector(this._right);
    const speed = velVec.dot(fwd);             // forward speed (signed)
    const lateralSpeed = Math.abs(velVec.dot(right)); // sideways slip speed

    // Impact level (for the camera): how much velocity the car LOST in a single
    // frame (m/s) — the momentum a crash or hard landing took out of it. This scales
    // with how hard the hit actually was (a slow bump barely registers), rather than
    // how abruptly it happened, so the shake stays in sync with the collision. Normal
    // driving (engine, braking, gravity) changes velocity far less than the threshold.
    const dv = velVec.distanceTo(this.prevVel);
    this.impact = nextImpact(this.impact, dv, dt);
    this.prevVel.copy(velVec);

    // Collision sparks from the chassis (see CarFX) — at the real contact points,
    // scaled by grind speed and impact.
    this.fx.collisionSparks(this.physics.world, this.collider, this.body, velVec, this.impact);

    // Braking modes:
    //   S / ↓   → front brake (decelerates, then reverses once stopped)
    //   Space   → handbrake: stronger full brake + rear slide, to a held stop
    const handbraking = controls.handbrake;
    const frontBraking = !handbraking && controls.brake > 0 && speed > 0.4;

    // Burnout / brake-stand: throttle held together with brake or handbrake while
    // ~stationary → the brakes hold the car in place while the drive wheels spin and
    // smoke. The hold (below) keeps it stuck; the wheels spin visually (burnoutSpin).
    const burnout = controls.throttle > 0 && (controls.brake > 0 || handbraking) && Math.abs(speed) < 3;
    this.burningOut = burnout;
    if (burnout) this.burnoutSpin += controls.throttle * 45 * dt;

    // Lift-off oversteer: lifting off the throttle mid-corner shifts weight off
    // the rear, so the tail goes light and the car rotates further into the turn —
    // lift off to tighten your line. Strongest at speed, fades as you slow.
    const coasting = controls.throttle === 0 && !handbraking && controls.brake === 0;
    const speedFrac = THREE.MathUtils.clamp(Math.abs(speed) / spec.topSpeed, 0, 1);

    const steerTarget = -controls.steer * spec.maxSteer;
    this.steer += (steerTarget - this.steer) * Math.min(1, spec.steerRate * dt);
    for (const i of FRONT) this.controller.setWheelSteering(i, this.steer);

    // Lift-off oversteer (grip): releasing the throttle mid-corner loosens the
    // rear so the car rotates further into the turn — present across the range.
    const liftoff = coasting && controls.steer !== 0 && speed > 2 ? spec.liftoffOversteer : 0;

    // Lift-off turn assist (LOW speed): on that same release, gently angle the tail
    // to help point the nose — extra rotation into the turn for tight, controllable
    // low-speed handling, where grip alone is too weak to rotate the car. Strongest
    // just off idle, fades to nothing at top speed, and is capped so it can sharpen
    // a turn without spinning out.
    if (coasting && controls.steer !== 0 && speed > 0.3) {
      const av = this.body.angvel();
      let y = av.y + controls.steer * spec.liftoffYaw * (1 - speedFrac) * dt;
      y = THREE.MathUtils.clamp(y, -MAX_ASSIST_YAW, MAX_ASSIST_YAW);
      const rv = this._rv3; rv.x = av.x; rv.y = y; rv.z = av.z;
      this.body.setAngvel(rv, true);
    }

    // Cosmetic body roll: the chassis visibly leans with the slide so you can see
    // its weight shifting. Physics stays upright (no tipping) — this only drives
    // the mesh in syncMeshes. Amplified at low speed so slow slides still lean.
    const lateral = velVec.dot(right); // signed sideways speed (+ = sliding right)
    const lowSpeedAmp = THREE.MathUtils.lerp(spec.leanLowSpeedAmp, 1, speedFrac);
    const targetLean = THREE.MathUtils.clamp(lateral * spec.leanStrength * lowSpeedAmp, -MAX_LEAN, MAX_LEAN);
    this.visualLean += (targetLean - this.visualLean) * Math.min(1, LEAN_RATE * dt);

    // Self-right when flipped: if the car is on its side or roof (its up-vector
    // tipped past ~60°), holding forward or backward rolls it about its length back
    // onto its wheels — rock it upright with the throttle instead of waiting for F.
    {
      const rot = this.body.rotation();
      const upVec = this._upVec.set(0, 1, 0).applyQuaternion(this.rotScratch.set(rot.x, rot.y, rot.z, rot.w));
      const driving = controls.throttle > 0 || controls.brake > 0;
      if (upVec.y < 0.5 && driving) {
        let rollDir = Math.sign(this._crossVec.crossVectors(upVec, this._worldUp.set(0, 1, 0)).dot(fwd));
        if (Math.abs(rollDir) < 0.01) rollDir = 1;
        const av = this.body.angvel();
        const w = this._wVec.set(av.x, av.y, av.z);
        const curRoll = w.dot(fwd);
        w.addScaledVector(fwd, (rollDir * RIGHTING_RATE - curRoll) * Math.min(1, 6 * dt));
        const rv2 = this._rv3; rv2.x = w.x; rv2.y = w.y; rv2.z = w.z;
        this.body.setAngvel(rv2, true);
      }
    }

    // Top-end overspeed: topSpeed is just where the slow top-end BEGINS, not the
    // real cap. While the car is pinned near its current cap under throttle, that
    // cap creeps slowly upward toward vMax = topSpeed × (1 + overspeed). The full
    // engine force below always holds whatever the cap is (it easily beats drag —
    // that's why a top speed holds at all), so the car climbs past the limit and,
    // once it reaches +overspeed%, KEEPS it (no falling back). Creep rate is
    // per-car (power vs weight). The raised cap persists until the car respawns.
    const vMax = spec.topSpeed * (1 + spec.overspeed);
    this.topEndCap = creepTopEndCap(this.topEndCap, controls.throttle > 0, speed, spec.topSpeed, vMax, spec.overspeedAccel, dt);

    // Engine / reverse. Full power pulls the car up to the current top-speed cap
    // (which starts at topSpeed and creeps to vMax above) and holds it there.
    let engine = 0;
    if (controls.throttle > 0) {
      if (speed < this.topEndCap) {
        const steerAmount = Math.abs(controls.steer);
        const turnFactor = 1 - steerAmount * spec.turnSlowdown; // ease off in corners
        const straightness = 1 - steerAmount;
        const lowSpeed = 1 - Math.min(Math.max(speed, 0) / spec.launchSpeed, 1);
        const boost = 1 + spec.launchBoost * straightness * lowSpeed; // fading launch punch
        engine = spec.engineForce * controls.throttle * turnFactor * boost;
      }
    } else if (!handbraking && controls.brake > 0 && speed <= 0.4) {
      engine = -spec.reverseForce * controls.brake; // reverse once stopped
    }
    this.appliedEngine += (engine - this.appliedEngine) * Math.min(1, spec.engineRate * dt);

    // ===== Braking model: pedal pressure · weight transfer · friction circle ·
    //       lockup/skid. The car slows like a real one, not a scripted "go slow".

    // (1) Pedal pressure builds and releases smoothly instead of snapping on/off.
    const brakeInput = handbraking ? 1 : frontBraking ? controls.brake : 0;
    this.brakePressure += (brakeInput - this.brakePressure) * Math.min(1, spec.brakeRamp * dt);
    const pressure = this.brakePressure;

    // Foot brake is front-biased (like a real car); the handbrake locks the rear.
    const frontBrakeShare = handbraking ? 0 : spec.brakeBiasFront;
    const rearBrakeShare = handbraking ? 1 : 1 - spec.brakeBiasFront;

    // (2) Weight transfer: braking pitches load onto the nose (front gains, rear loses).
    //     Acceleration shifts load to the rear (rear gains, front loses).
    const transfer = spec.weightTransfer * pressure - spec.accelTransfer * controls.throttle;

    // (3) Lockup: past `lockupAt` pressure the tyres start to skid. `overbrake` is
    //     how far past (0..1); the rear locks more readily because it's now light.
    const overbrake = THREE.MathUtils.clamp((pressure - spec.lockupAt) / (1 - spec.lockupAt), 0, 1);
    const frontLock = Math.min(1, overbrake * frontBrakeShare * 2);
    const rearLock = handbraking ? 1 : Math.min(1, overbrake * rearBrakeShare * 2.4);

    // ----- Lateral grip = drift slip model, then the braking modifiers above -----
    // Per-axle static→kinetic ramp: the rear breaks loose first (rearGripBias < 1)
    // → progressive, catchable oversteer rather than a snap.
    const band = spec.slipThreshold;
    const frontSlideT = THREE.MathUtils.clamp((lateralSpeed - spec.slipThreshold) / band, 0, 1);
    const rearSlideT = THREE.MathUtils.clamp(
      (lateralSpeed - spec.slipThreshold * spec.rearGripBias) / band, 0, 1
    );
    let frontSide = spec.sideFrictionStiffness * THREE.MathUtils.lerp(1.0, spec.kineticGripRatio, frontSlideT);
    let backSide = spec.sideFrictionStiffness * THREE.MathUtils.lerp(1.0, spec.kineticGripRatio, rearSlideT);

    // weight transfer → front gains grip, rear loses it
    frontSide *= 1 + transfer;
    backSide *= 1 - transfer;
    // friction circle → grip spent braking is unavailable for cornering
    frontSide *= 1 - FRICTION_CIRCLE * pressure * frontBrakeShare;
    backSide *= 1 - FRICTION_CIRCLE * pressure * rearBrakeShare;
    // lockup → a skidding tyre loses lateral grip (front lock = understeer,
    // rear lock = the tail slides; the handbrake always locks the rear)
    frontSide *= THREE.MathUtils.lerp(1, spec.lockupGrip, frontLock);
    backSide *= THREE.MathUtils.lerp(1, spec.lockupGrip, rearLock);
    // lift-off oversteer → rear lets go a little, front bites a little more, so
    // releasing the throttle while turning rotates the car harder into the corner
    frontSide *= 1 + 0.3 * liftoff;
    backSide *= 1 - liftoff;
    // persistent tail-out slip → turning at speed bleeds a little rear grip.
    // Gated by throttle: the tail steps out when coasting, but throttle plants it
    // (up to ~70% suppression) so power-on cornering is stable, not loose.
    const cornerDemand = Math.abs(controls.steer) * speedFrac;
    const tailSlipFactor = spec.tailSlip * (1 - 0.7 * controls.throttle);
    backSide *= 1 - tailSlipFactor * cornerDemand;
    // surface grip → loose ground (dirt) cuts lateral grip per axle (tarmac = 1):
    // the car bites on the road, runs wide and drifts easily on the terrain.
    frontSide *= (this.wheelSurface[0].grip + this.wheelSurface[1].grip) * 0.5;
    backSide *= (this.wheelSurface[2].grip + this.wheelSurface[3].grip) * 0.5;
    frontSide = Math.max(0, frontSide);
    backSide = Math.max(0, backSide);

    // Flag which wheels are visibly skidding (→ skid marks): a wheel skids when the
    // car is sliding sideways, or its axle is locked (handbrake / hard braking).
    const slidingLat = lateralSpeed > SKID_SLIP_SPEED;
    for (let i = 0; i < 4; i++) {
      const lock = FRONT.includes(i) ? frontLock : rearLock;
      this.wheelSkid[i] = slidingLat || lock > 0.4;
    }

    // Tyre smoke per wheel: drive-wheel spin under hard acceleration (most at a
    // launch, fading with speed) and locked-wheel smoke under hard braking — the
    // stronger the accel/brake, the more it billows. On loose surfaces smoke is
    // suppressed and becomes DUST instead: rolling speed and slip kick up a trail.
    const launchSpin = controls.throttle * THREE.MathUtils.clamp(1 - Math.max(speed, 0) / spec.launchSpeed, 0, 1);
    const moving = THREE.MathUtils.clamp(Math.abs(speed) / 5, 0, 1); // need motion to smoke under braking
    for (let i = 0; i < 4; i++) {
      const front = FRONT.includes(i);
      const bias = front ? spec.driveBias.front : spec.driveBias.back;
      const driven = bias > 0.3;
      const lock = front ? frontLock : rearLock;
      this.wheelSmoke[i] = Math.max(launchSpin * (driven ? bias : 0), lock * moving);
      // Burnout: the spinning drive wheels pour smoke and scrub a patch in place.
      if (burnout && driven) {
        this.wheelSmoke[i] = Math.max(this.wheelSmoke[i], controls.throttle);
        this.wheelSkid[i] = true;
      }
      // Surface routing: dust = surface dustiness × (rolling speed + slip bonus).
      const surf = this.wheelSurface[i];
      const rolling = THREE.MathUtils.clamp(Math.abs(speed) / (spec.topSpeed * 0.5), 0, 1);
      const slipDust = this.wheelSkid[i] || this.wheelSmoke[i] > 0.25 ? 0.5 : 0;
      this.wheelDust[i] = surf.dust * Math.min(1, 0.85 * rolling + slipDust);
      this.wheelSmoke[i] *= 1 - 0.85 * surf.dust;
    }

    for (let i = 0; i < 4; i++) {
      const front = FRONT.includes(i);
      const bias = front ? spec.driveBias.front : spec.driveBias.back;
      // Loose surfaces transmit less drive (wheelspin on dirt) — per-wheel traction.
      this.controller.setWheelEngineForce(i, this.appliedEngine * bias * this.wheelSurface[i].traction);
      this.controller.setWheelSideFrictionStiffness(i, front ? frontSide : backSide);
      this.controller.setWheelBrake(i, 0); // longitudinal braking handled below
    }

    this.controller.updateVehicle(dt);

    // ----- Longitudinal brake (reliable, comes to a genuine held stop) -----
    // Brakes only bite with wheels on the ground (no braking in mid-air). For the
    // foot brake a locked axle brakes at only `lockupGrip` efficiency, so slamming
    // into lockup actually *lengthens* the stop — threshold braking is fastest,
    // exactly like a car without ABS. The handbrake stays a strong full stop while
    // the rear slides. Travel direction is preserved, so a sliding car keeps
    // sliding as it slows. Braking distances also stretch on loose surfaces.
    let grounded = 0;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) grounded++;

    const footEff = 1 - (frontBrakeShare * frontLock + rearBrakeShare * rearLock) * (1 - spec.lockupGrip);
    const surfTraction =
      (this.wheelSurface[0].traction + this.wheelSurface[1].traction +
        this.wheelSurface[2].traction + this.wheelSurface[3].traction) / 4;
    const decel =
      (grounded === 0 ? 0 : handbraking ? spec.handbrake * pressure : spec.maxBrake * pressure * footEff) *
      surfTraction;

    if (decel > 0) {
      const v = this.body.linvel();
      const sp = Math.hypot(v.x, v.z);
      if (sp > 1e-3) {
        const f = Math.max(0, sp - decel * dt) / sp;
        const rv = this._rv3; rv.x = v.x * f; rv.y = v.y; rv.z = v.z * f;
        this.body.setLinvel(rv, true);
      }
      // Very light yaw damp keeps a straight stop from wandering, but it's gentle
      // and backs right off once the rear is sliding so the tail can swing and
      // trail the motion under braking (weighty skid, not an on-rails stop).
      const av = this.body.angvel();
      const yk = Math.min(1, 1.3 * dt) * (1 - rearLock);
      const rv3 = this._rv3; rv3.x = av.x; rv3.y = av.y * (1 - yk); rv3.z = av.z;
      this.body.setAngvel(rv3, true);
    }

    // Burnout hold: with throttle AND brake/handbrake held, the brakes overpower the
    // drive — heavily damp the horizontal velocity so the car stays stuck in place
    // (it barely creeps) while the wheels spin and smoke. Release the brake to launch.
    if (burnout && grounded > 0) {
      const v = this.body.linvel();
      const rv4 = this._rv3; rv4.x = v.x * 0.5; rv4.y = v.y; rv4.z = v.z * 0.5;
      this.body.setLinvel(rv4, true);
    }

    // Stabilize: under braking the nose may dip, but only subtly — pitch stays
    // fairly firm so it never lurches — while roll is fully locked (can't tip).
    const pitchGain = THREE.MathUtils.lerp(1.0, 0.6, pressure);
    this.stabilize(dt, pitchGain);
  }

  /**
   * Grounded anti-roll / anti-pitch stabilizer. While wheels are touching the
   * surface, gently torque the car so its "up" axis aligns with the ground's
   * normal — this stops it tipping over in turns, lifting the nose under
   * acceleration, and rolling onto its side. Airborne (no wheels in contact)
   * it does nothing, so ramps and jumps still behave naturally. Targeting the
   * surface normal (not world up) means it sits correctly on slopes/ramps too.
   */
  private stabilize(dt: number, pitchGain: number) {
    const normal = this._stabNormal.set(0, 0, 0);
    let grounded = 0;
    for (let i = 0; i < 4; i++) {
      if (this.controller.wheelIsInContact(i)) {
        grounded++;
        const n = this.controller.wheelContactNormal(i);
        if (n) normal.add(this._stabNVec.set(n.x, n.y, n.z));
      }
    }
    if (grounded === 0 || normal.lengthSq() < 1e-6) return; // airborne → free
    normal.normalize();

    const r = this.body.rotation();
    const up = this._stabUp.set(0, 1, 0).applyQuaternion(this.rotScratch.set(r.x, r.y, r.z, r.w));

    // Axis/angle that rotates the car's up-vector onto the surface normal.
    const axis = this._stabAxis.crossVectors(up, normal);
    const sin = axis.length();
    if (sin < 1e-5) return;
    axis.divideScalar(sin);
    const angle = Math.atan2(sin, up.dot(normal)); // tilt magnitude (roll+pitch)

    // PD controller: spring toward level, damp the current tilt rate.
    const av = this.body.angvel();
    const w = this._stabW.set(av.x, av.y, av.z);
    const tiltRate = w.dot(axis);
    const accelMag = (UPRIGHT_STIFFNESS * angle - UPRIGHT_DAMPING * tiltRate) * (grounded / 4);
    // axis is now the corrective direction (multiplied in-place)
    axis.multiplyScalar(accelMag);

    // Split the correction into roll (about the car's forward axis) and pitch
    // (about its right axis). Roll stays full so it can't tip onto its side;
    // pitch is scaled by pitchGain so the nose may dip under braking.
    const fwd = this.forwardVector(this._stabFwd);
    const right = this.rightVector(this._stabRight);
    const rollComp = axis.dot(fwd);
    const pitchComp = axis.dot(right) * pitchGain;
    const corrective = this._stabCorrective;
    corrective.copy(fwd).multiplyScalar(rollComp).addScaledVector(right, pitchComp);

    w.addScaledVector(corrective, dt);
    const rv = this._rv3; rv.x = w.x; rv.y = w.y; rv.z = w.z;
    this.body.setAngvel(rv, true);
  }

  /**
   * Snapshot the current physics state so syncMeshes() can interpolate between
   * this (previous) state and the post-step (current) state. Call ONCE per
   * frame, BEFORE physics.step().
   */
  savePreviousState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this._prevPos.set(t.x, t.y, t.z);
    this._prevRot.set(r.x, r.y, r.z, r.w);
  }

  /**
   * Sync Three.js meshes to the physics state. When `alpha` (0..1) is given,
   * the visual position is interpolated between the previous and current
   * physics state — this eliminates the micro-stutter caused by the fixed
   * 60 Hz physics stepping against a variable-rate display.
   */
  syncMeshes(alpha = 1) {
    const t = this.body.translation();
    const r = this.body.rotation();

    // Interpolated position & rotation for smooth rendering.
    const curPos = this._interpPos.set(t.x, t.y, t.z);
    const curRot = this._chassisQuat.set(r.x, r.y, r.z, r.w);
    if (alpha < 1) {
      curPos.lerpVectors(this._prevPos, curPos, alpha);
      curRot.slerpQuaternions(this._prevRot, curRot, alpha);
    }

    this.chassisMesh.position.copy(curPos);
    // Add the cosmetic lean as an extra roll about the car's forward axis. The
    // wheels (below) use the un-leaned chassisQuat so they stay on the ground.
    const leanRoll = this._leanRoll.setFromAxisAngle(Z_AXIS, this.visualLean);
    this.chassisMesh.quaternion.copy(curRot).multiply(leanRoll);

    const chassisMat = this._chassisMat.compose(
      this.chassisMesh.position,
      curRot,
      this._oneVec.set(1, 1, 1)
    );

    // Flat heading, used to orient a burnout scrub patch when stationary.
    const fwdH = this.forwardVector(this._fwd);
    const heading = Math.atan2(fwdH.x, fwdH.z);
    const lv = this.body.linvel(); // for skid-mark orientation (constant this frame)

    for (let i = 0; i < 4; i++) {
      const steer = this.controller.wheelSteering(i) ?? 0;
      const driven = (FRONT.includes(i) ? this.spec.driveBias.front : this.spec.driveBias.back) > 0.3;
      // driven wheels carry an extra spin offset so they whirl during a burnout
      const roll = (this.controller.wheelRotation(i) ?? 0) + (driven ? this.burnoutSpin : 0);

      // Calculate wheel center purely from chassis matrix and suspension length
      // so it stays perfectly synced with the chassis without a 1-frame delay.
      const conn = this.controller.wheelChassisConnectionPointCs(i)!;
      const susp = this.controller.wheelSuspensionLength(i) ?? this.spec.suspensionRest;
      const world = this._wheelWorld.set(conn.x, conn.y - susp, conn.z).applyMatrix4(chassisMat);

      if (this.controller.wheelIsInContact(i)) {
        const cn = this.controller.wheelContactNormal(i)!;
        // Reconstruct the ground contact point from the synced wheel position
        const fxCp = this._fxCp.copy(world).addScaledVector(this._cnVec.set(cn.x, cn.y, cn.z), -this.spec.wheelRadius);
        // Skid mark + tyre smoke / surface dust at the ground contact (see CarFX).
        this.fx.wheelContact(fxCp, this.wheelSmoke[i], this.wheelSkid[i], this.burningOut, lv.x, lv.z, heading, this.spec.wheelWidth, this.wheelDust[i]);
      }

      const q = this._wheelQ.identity()
        .multiply(curRot)
        .multiply(this._steerQ.setFromAxisAngle(Y_AXIS, steer))
        .multiply(this._rollQ.setFromAxisAngle(X_AXIS, roll));

      this.wheelMeshes[i].position.copy(world);
      this.wheelMeshes[i].quaternion.copy(q);
    }
  }

  forwardVector(out?: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return (out ?? new THREE.Vector3()).set(0, 0, 1).applyQuaternion(this.rotScratch.set(r.x, r.y, r.z, r.w));
  }

  rightVector(out?: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return (out ?? new THREE.Vector3()).set(1, 0, 0).applyQuaternion(this.rotScratch.set(r.x, r.y, r.z, r.w));
  }

  position(out?: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return (out ?? new THREE.Vector3()).set(t.x, t.y, t.z);
  }

  velocity(out?: THREE.Vector3): THREE.Vector3 {
    const v = this.body.linvel();
    return (out ?? new THREE.Vector3()).set(v.x, v.y, v.z);
  }

  /** True when no wheel is touching the ground (jumping / flying off a ramp). */
  isAirborne(): boolean {
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) return false;
    return true;
  }

  /** Forward speed as a fraction (0..1) of this car's true top speed (incl. overspeed). */
  speedFraction(): number {
    const v = this.body.linvel();
    const f = this.forwardVector(this._speedFwd);
    const s = f.x * v.x + f.y * v.y + f.z * v.z;
    return computeSpeedFraction(s, this.spec.topSpeed, this.spec.overspeed);
  }

  /** 0..1 collision / hard-landing intensity for camera shake. */
  impactLevel(): number {
    return this.impact;
  }

  reset() {
    this.body.setTranslation(this.spawnPos, true);
    this.body.setRotation(this.spawnRot, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.appliedEngine = 0;
    this.brakePressure = 0;
    this.visualLean = 0;
    this.topEndCap = this.spec.topSpeed;
    this.prevVel.set(0, 0, 0);
    this.impact = 0;
    this.burningOut = false;
    this.burnoutSpin = 0;
  }

  /** Remove all meshes and physics objects for this car (used when swapping cars). */
  dispose(scene: THREE.Scene, physics: Physics) {
    const disposeObject = (m: THREE.Object3D) => {
      if (m instanceof THREE.Mesh) {
        m.geometry?.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else m.material.dispose();
        }
      }
    };
    
    // Recursively dispose all children of the chassis
    this.chassisMesh.traverse(disposeObject);
    scene.remove(this.chassisMesh);

    // Wheels share one geometry/material — disposing each handle is safe.
    this.wheelMeshes.forEach((m) => {
      scene.remove(m);
      disposeObject(m);
    });

    physics.world.removeVehicleController(this.controller);
    physics.world.removeRigidBody(this.body); // also removes attached colliders
  }

  /** True when the car has rolled past ~66° from upright. */
  isFlipped(): boolean {
    const r = this.body.rotation();
    const upY = this._upVec.set(0, 1, 0).applyQuaternion(this.rotScratch.set(r.x, r.y, r.z, r.w)).y;
    return upY < 0.4;
  }

  /**
   * Flip the car back onto its wheels in place, preserving its heading (yaw).
   * No-op while the car is already upright.
   */
  recover() {
    if (!this.isFlipped()) return;

    const fwd = this.forwardVector(this._fwd);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const upright = this._recoverQ.setFromEuler(this._recoverEuler.set(0, yaw, 0));

    const t = this.body.translation();
    this.body.setTranslation({ x: t.x, y: t.y + 0.6, z: t.z }, true);
    this.body.setRotation(upright, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.appliedEngine = 0;
    this.brakePressure = 0;
    this.visualLean = 0;
    this.topEndCap = this.spec.topSpeed;
    this.prevVel.set(0, 0, 0);
    this.impact = 0;
    this.burningOut = false;
    this.burnoutSpin = 0;
  }
}
