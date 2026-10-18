/**
 * Per-car tuning. Every car in the roster is just a different CarSpec. No
 * physics constants are hardcoded in the Car class itself, so cars can vary in
 * size, height, speed, grip, drive layout, suspension and stability.
 *
 * REAL SCALE: metres, kilograms, seconds. Gravity is Physics.GRAVITY (9.81 x the
 * arcade weight factor); suspension stiffness below is tuned for that value.
 * The collider box (half extents) should match the visible body: use the
 * "[CarSpec ...] fitted model" console line (dev builds) to tune it.
 *
 * Author cars with makeCar(): it derives the drive force from a mass-independent
 * acceleration and the inertia from the box, so changing a car's mass or size
 * never silently changes how hard it pulls or how lazily it rotates.
 */
export interface CarSpec {
  name: string;
  color: number;
  powerSlideAngle?: number;
  // Geometry / silhouette (metres, half-extents of the collider box = the body).
  halfWidth: number;
  halfHeight: number;
  halfLength: number;
  wheelRadius: number;
  wheelWidth: number;

  // Mass & balance.
  mass: number;                                     // kg
  comOffset: { x: number; y: number; z: number }; // centre of mass; lower y = more anti-roll
  inertia: { x: number; y: number; z: number };    // kg·m² (x pitch, y yaw, z roll)
  linearDamping: number;
  angularDamping: number;                           // higher = calmer rotation, harder to flip

  // Drive & speed.
  engineForce: number;   // N per unit of drive bias (see driveForce)
  reverseForce: number;
  maxBrake: number;      // m/s² foot-brake deceleration
  handbrake: number;     // m/s² handbrake deceleration (low = long rally slides)
  driveBias: { front: number; back: number }; // 0..1 force multiplier per axle (FWD/RWD/AWD)
  topSpeed: number;      // m/s, the limit full power pulls you to in 6th (1st-5th stop at gearbox FIFTH_TOP)
  launchSpeed: number;   // m/s by which off-the-line boost fades
  launchBoost: number;   // extra fraction of engine force when launching straight
  overspeed: number;     // fraction above topSpeed the car slowly climbs to (the real max)
  overspeedAccel: number; // how fast the top-speed cap creeps up past the limit (m/s²)

  // Steering.
  maxSteer: number;      // radians at full lock (standstill / crawling)
  steerRate: number;     // how fast steering approaches the target (1/s, exponential)
  steerSlew: number;     // rad/s: wheel angle can never move faster than this (progressive turn-in)
  steerYawLow: number;   // rad/s yaw-rate authority at low speed: caps the front lock via the wheelbase
  steerYawHigh: number;  // rad/s yaw-rate authority at top speed (> steerYawLow = strong steering when fast)
  turnSlowdown: number;  // 0..1, how much throttle eases off at full lock
  engineRate: number;    // how fast engine/reverse force ramps in

  // Static→kinetic grip model.
  slipThreshold: number;    // m/s of lateral slip before the tyre breaks loose (high speed trigger)
  slipAngle: number;        // rad of body slip before the tyre breaks loose (low speed trigger: a little skid at any speed)
  kineticGripRatio: number; // 0..1 grip retained while sliding (lower = longer slides)
  rearGripBias: number;     // <1 → rear breaks loose earlier than the front
  liftoffOversteer: number; // 0..1 lift-off loosens the rear mid-corner
  tailSlip: number;         // 0..1 rear grip given up while cornering at speed
  powerOversteer: number;   // 0..1 throttle mid-corner loosens the driven rear (steer with the throttle)
  handbrakeGrip: number;    // 0..1 rear side grip left with the handbrake pulled (handbrake turns)
  hbRecoverTime: number;    // s for the rear to hook back up after the handbrake is released
  hbHookup: number;         // 0..1 rear grip it settles at while still sliding with NO throttle (throttle pushes it to 1)
  hbFrontGrip: number;      // 0..1 front side grip right after release while the rear is unhooked (balances the axles: slide, don't spin)
  counterSteer: number;     // 0..1+ assist gain: front wheels point toward the direction of travel in a slide
  counterSteerMax: number;  // rad: most the counter-steer assist may add to the front wheel angle

  // Corner feel (all optional, 0/unset = off).
  yawAssist?: number;       // 1/s: how hard the body is pulled toward the yaw rate the front wheels ask for (rotation help)
  yawAssistMax?: number;    // rad/s²: cap on that pull, so it can never snap the car round
  yawAssistLat?: number;    // m/s²: lateral acceleration the rotation help may ask for (caps the target yaw rate at speed)
  cornerCarry?: number;     // 0..~0.3: gives back forward speed in corners under throttle (cancels tyre scrub)
  tailKick?: number;        // 0..1: rear grip given up when the steering moves fast (flick: the tail swings round, then bites)

  // Cosmetic body lean (visual only).
  leanStrength: number;
  leanLowSpeedAmp: number;

  // Brake feel.
  brakeBiasFront: number;
  weightTransfer: number;
  accelTransfer: number;
  brakeRamp: number;
  lockupAt: number;
  lockupGrip: number;

  // Suspension & grip. Rapier's stiffness/damping are per unit of chassis mass, so
  // they don't need retuning when mass changes. Static sag = g / (4 · stiffness),
  // ride frequency = sqrt(4 · stiffness) / 2π, damping ratio ≈ damping / sqrt(stiffness).
  suspensionRest: number;
  suspensionStiffness: number;
  suspensionTravel: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  frictionSlip: number;
  sideFrictionStiffness: number;

  // --- Visual & wheel tuning ---
  modelFile?: string;             // .glb in public/assets/; loaded instead of the box car
  visualScaleMultiplier?: number; // fallback fit only (models without wheel nodes): model length = halfLength × this
  visualZOffset?: number;         // small manual nudge forward/back (m) after the auto-fit
  visualYOffset?: number;         // small manual nudge up/down (m) after the auto-fit
  visualRotationY?: number;       // Math.PI if the model faces backwards
  wheelZInset?: number;           // axle distance from the bumper (default 0.25)
  wheelZInsetFront?: number;
  wheelZInsetRear?: number;
  wheelXOffset?: number;          // + pushes wheels outward from halfWidth (negative = tucked under the body)
  engineSound?: string;           // sub-folder of public/assets/audio/engine/ with this car's own engine loops (unset = default sound)
  keepModelWheelSize?: boolean;   // true: keep the .glb's own tyre size instead of rescaling it to wheelRadius (then set wheelRadius to the radius logged in dev)
}

type Vec3 = { x: number; y: number; z: number };
type Bias = { front: number; back: number };

/** Input for makeCar: like CarSpec, but forces and inertia are derived. */
export type CarInput = Omit<CarSpec, "engineForce" | "reverseForce" | "inertia"> & {
  engineAccel: number;  // m/s² at full throttle (before launch boost), mass-independent
  reverseAccel: number; // m/s² in reverse
  inertiaScale?: Vec3;  // multipliers on solid-box inertia (>1 = lazier, <1 = snappier rotation)
};

/** Drive force giving `accel` m/s²: Car applies force × bias on each of the 4 wheels. */
export function driveForce(mass: number, accel: number, bias: Bias): number {
  return (mass * accel) / (2 * (bias.front + bias.back));
}

/** Solid-box inertia (kg·m²) from mass + half extents, with per-axis multipliers. */
export function boxInertia(mass: number, hw: number, hh: number, hl: number, k: Vec3 = { x: 1, y: 1, z: 1 }): Vec3 {
  const w = 2 * hw, h = 2 * hh, l = 2 * hl;
  return {
    x: (k.x * mass * (h * h + l * l)) / 12,
    y: (k.y * mass * (w * w + l * l)) / 12,
    z: (k.z * mass * (w * w + h * h)) / 12,
  };
}

export function makeCar(c: CarInput): CarSpec {
  const { engineAccel, reverseAccel, inertiaScale, ...rest } = c;
  return {
    ...rest,
    engineForce: driveForce(c.mass, engineAccel, c.driveBias),
    reverseForce: driveForce(c.mass, reverseAccel, c.driveBias),
    inertia: boxInertia(c.mass, c.halfWidth, c.halfHeight, c.halfLength, inertiaScale),
  };
}

// Firm, well-damped rally suspension for the heavier arcade gravity (~15.7 m/s²):
// ~1.9 Hz ride, ~11 cm static sag, ~0.45 bump / ~0.7 rebound damping. The body
// still pitches and rolls with weight, but lands planted instead of pogo-bouncing.
// Ride height matches Phase 1 (rest - sag ≈ 0.22 m), so fitted models sit as before.
const RALLY_SUSPENSION = {
  suspensionRest: 0.33,
  suspensionStiffness: 36,
  suspensionTravel: 0.28,
  suspensionCompression: 2.7,
  suspensionRelaxation: 4.2,
};

// Toyota pickup: shared by the Toyota, Toyota6 and Toyota24 (same driving, different model).
// Rear-wheel-drive Dakar-style rally truck: throttle swings the tail (power oversteer /
// throttle steer), the handbrake pivots it, and after a pivot the rear only hooks back
// up under power, so the driver has to push to drive out along the new heading.
const TOYOTA: CarInput = {
  name: "Toyota",
  color: 0xdddddd,
  halfWidth: 0.93, halfHeight: 0.5, halfLength: 2.45, // ~1.86 x 1.0 x 4.9 m body
  wheelRadius: 0.4, wheelWidth: 0.28,
  mass: 2000,
  comOffset: { x: 0, y: -0.35, z: 0.1 },
  inertiaScale: { x: 1, y: 0.65, z: 1.5 },
  linearDamping: 0.1, angularDamping: 0.35,
  engineAccel: 17, reverseAccel: 7, maxBrake: 24, handbrake: 4.5,
  driveBias: { front: 0, back: 1 }, // RWD: all drive through the rear axle
  topSpeed: 58, launchSpeed: 14, launchBoost: 0.8,
  overspeed: 0.27, overspeedAccel: 1.7, powerSlideAngle: 0.45,
  maxSteer: 0.68, steerRate: 8, turnSlowdown: 0.02, engineRate: 16,
  steerSlew: 4.0, steerYawLow: 1.30, steerYawHigh: 1.45,
  slipThreshold: 3.2, slipAngle: 0.200, kineticGripRatio: 0.80,
  rearGripBias: 1.00, liftoffOversteer: 0.38, tailSlip: 0.30,
  powerOversteer: 0.8, handbrakeGrip: 0.23,
  hbRecoverTime: 1.30, hbHookup: 0.56, hbFrontGrip: 0.30, counterSteer: 0.25, counterSteerMax: 0.10,
  yawAssist: 8, yawAssistMax: 12, yawAssistLat: 70, cornerCarry: 1.2, tailKick: 0.1,
  leanStrength: 0.04, leanLowSpeedAmp: 1.8,
  brakeBiasFront: 0.65, weightTransfer: 0.25, accelTransfer: 0.15, brakeRamp: 20, lockupAt: 0.97, lockupGrip: 0.35,
  ...RALLY_SUSPENSION,
  suspensionStiffness: 38, suspensionCompression: 2.8, suspensionRelaxation: 4.3,
  frictionSlip: 1.82, sideFrictionStiffness: 1.90,
  visualScaleMultiplier: 2.0, // fallback only: bumper-to-bumper = collider length
  wheelZInsetFront: 0.95, wheelZInsetRear: 0.95, // ~3.0 m wheelbase
  wheelXOffset: -0.13,
};

/**
 * The roster, tuned arcade-snappy: quick launch, quick turn-in, hard stops and
 * big, easy drifts (power / lift-off / handbrake oversteer), on heavy planted
 * suspension. Each car keeps its character: Bolt balanced, Hornet wild, Tank planted.
 */
export const CARS: Record<string, CarSpec> = {

  // Keeps the Blender tyre size (model tyres ~0.47 m radius at this fit); physics matches.
  toyota: makeCar({ ...TOYOTA, keepModelWheelSize: true, wheelRadius: 0.443, wheelXOffset: 0, engineSound: "toyota" }),
  // Same driving as the Toyota, different model. The model is auto-fitted to these
  // physics wheels, so only touch visualYOffset/visualZOffset for small nudges.
  toyota6: makeCar({
    ...TOYOTA,
    name: "Toyota6",
    mass: 2400,
    modelFile: "toyota6.glb",
    keepModelWheelSize: true, wheelRadius: 0.454, wheelXOffset: 0.037,
    engineSound: "toyota6",
  }),

  // Same driving as the Toyota, new model (toyota-24.glb: 4 wheel nodes, +Z forward, no rotation
  // needed). Auto-fitted to the physics wheels like Toyota6. wheelRadius / wheelXOffset are the
  // values measured from the model (wheelbase scaled to 3.0 m): re-check them against the
  // "[CarSpec Toyota24] fitted model ..." dev console line and nudge visualYOffset/visualZOffset
  // only if the tyres float or sink. Lights use the Toyota rig (rigOf matches "toyota").
  toyota24: makeCar({
    ...TOYOTA,
    name: "Toyota24",
    modelFile: "toyota-24.glb",
    keepModelWheelSize: true, wheelRadius: 0.461, wheelXOffset: -0.064,
    engineSound: "toyota6", // reuses the Toyota engine loops (no toyota-24 recording yet)
  }),
};

export const DEFAULT_CAR = "toyota";