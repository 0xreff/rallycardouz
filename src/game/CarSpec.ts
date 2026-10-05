/**
 * Per-car tuning. Every car in the roster is just a different CarSpec. No
 * physics constants are hardcoded in the Car class itself, so cars can vary in
 * size, height, speed, grip, drive layout, suspension and stability.
 *
 * REAL SCALE: metres, kilograms, seconds, gravity 9.81 (Physics.GRAVITY).
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
  topSpeed: number;      // m/s, the limit full power pulls you to
  launchSpeed: number;   // m/s by which off-the-line boost fades
  launchBoost: number;   // extra fraction of engine force when launching straight
  overspeed: number;     // fraction above topSpeed the car slowly climbs to (the real max)
  overspeedAccel: number; // how fast the top-speed cap creeps up past the limit (m/s²)

  // Steering.
  maxSteer: number;      // radians at full lock
  steerRate: number;     // how fast steering approaches the target
  turnSlowdown: number;  // 0..1, how much throttle eases off at full lock
  engineRate: number;    // how fast engine/reverse force ramps in

  // Static→kinetic grip model.
  slipThreshold: number;    // m/s of lateral slip before the tyre breaks loose
  kineticGripRatio: number; // 0..1 grip retained while sliding (lower = longer slides)
  rearGripBias: number;     // <1 → rear breaks loose earlier than the front
  liftoffOversteer: number; // 0..1 lift-off loosens the rear mid-corner
  tailSlip: number;         // 0..1 rear grip given up while cornering at speed
  powerOversteer: number;   // 0..1 throttle mid-corner loosens the driven rear (steer with the throttle)
  handbrakeGrip: number;    // 0..1 rear side grip left with the handbrake pulled (handbrake turns)

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
}

type Vec3 = { x: number; y: number; z: number };
type Bias = { front: number; back: number };

/** Input for makeCar: like CarSpec, but forces and inertia are derived. */
export type CarInput = Omit<CarSpec, "engineForce" | "reverseForce" | "inertia"> & {
  engineAccel: number;  // m/s² at full throttle (before launch boost), mass-independent
  reverseAccel: number; // m/s² in reverse
  inertiaScale?: Vec3;  // multipliers on solid-box inertia (>1 = lazier, weightier rotation)
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

// Lively long-travel rally suspension: ~1.5 Hz ride, ~11 cm static sag, light
// damping (~0.32 bump / ~0.45 rebound) so the body visibly pitches, rolls and
// bounces over bumps and soaks up landings. Ride height matches Phase 1
// (rest - sag ≈ 0.22 m), so the fitted models sit exactly as before.
const RALLY_SUSPENSION = {
  suspensionRest: 0.33,
  suspensionStiffness: 22,
  suspensionTravel: 0.32,
  suspensionCompression: 1.5,
  suspensionRelaxation: 2.1,
};

// Toyota pickup: shared by the Toyota and Toyota6 (same driving, different model).
// Rear-biased AWD rally truck: throttle swings the tail, handbrake flicks it round.
const TOYOTA: CarInput = {
  name: "Toyota",
  color: 0xdddddd,
  halfWidth: 0.93, halfHeight: 0.5, halfLength: 2.45, // ~1.86 x 1.0 x 4.9 m body
  wheelRadius: 0.4, wheelWidth: 0.28,
  mass: 1900,
  comOffset: { x: 0, y: -0.35, z: 0.1 },
  inertiaScale: { x: 1, y: 1, z: 1.5 },
  linearDamping: 0.1, angularDamping: 0.55,
  engineAccel: 13, reverseAccel: 6, maxBrake: 14, handbrake: 6,
  driveBias: { front: 0.35, back: 0.65 },
  topSpeed: 48, launchSpeed: 14, launchBoost: 0.6,
  overspeed: 0.25, overspeedAccel: 1.2,
  maxSteer: 0.6, steerRate: 10, turnSlowdown: 0.04, engineRate: 9,
  slipThreshold: 3.2, kineticGripRatio: 0.72,
  rearGripBias: 0.8, liftoffOversteer: 0.35, tailSlip: 0.25,
  powerOversteer: 0.6, handbrakeGrip: 0.2,
  leanStrength: 0.04, leanLowSpeedAmp: 1.8,
  brakeBiasFront: 0.65, weightTransfer: 0.25, accelTransfer: 0.15, brakeRamp: 12, lockupAt: 0.9, lockupGrip: 0.35,
  ...RALLY_SUSPENSION,
  suspensionStiffness: 24, suspensionCompression: 1.6, suspensionRelaxation: 2.3,
  frictionSlip: 3.9, sideFrictionStiffness: 1.45,
  visualScaleMultiplier: 2.0, // fallback only: bumper-to-bumper = collider length
  wheelZInsetFront: 0.95, wheelZInsetRear: 0.95, // ~3.0 m wheelbase
  wheelXOffset: -0.13,                           // ~1.6 m track
};

/**
 * The roster, retuned for energetic rally fun: punchier engines, quicker response,
 * looser tails (power / lift-off / handbrake oversteer), bouncy suspension.
 * Each car keeps its character: Bolt balanced, Hornet wild, Tank planted.
 */
export const CARS: Record<string, CarSpec> = {
  // Balanced all-rounder (box car).
  bolt: makeCar({
    name: "Bolt",
    color: 0x2f6bff,
    halfWidth: 0.88, halfHeight: 0.38, halfLength: 2.0,
    wheelRadius: 0.33, wheelWidth: 0.22,
    mass: 1250,
    comOffset: { x: 0, y: -0.3, z: 0.05 },
    inertiaScale: { x: 1, y: 1, z: 1.5 },
    linearDamping: 0.1, angularDamping: 0.55,
    engineAccel: 12, reverseAccel: 5.5, maxBrake: 13, handbrake: 6,
    driveBias: { front: 0.7, back: 0.9 },
    topSpeed: 26, launchSpeed: 9, launchBoost: 0.5,
    overspeed: 0.2, overspeedAccel: 0.8,
    maxSteer: 0.57, steerRate: 8.5, turnSlowdown: 0.1, engineRate: 8,
    slipThreshold: 3.4, kineticGripRatio: 0.72,
    rearGripBias: 0.75, liftoffOversteer: 0.35, tailSlip: 0.15,
    powerOversteer: 0.45, handbrakeGrip: 0.25,
    leanStrength: 0.045, leanLowSpeedAmp: 2.0,
    brakeBiasFront: 0.62, weightTransfer: 0.2, accelTransfer: 0.2, brakeRamp: 10, lockupAt: 0.85, lockupGrip: 0.2,
    ...RALLY_SUSPENSION,
    frictionSlip: 3.2, sideFrictionStiffness: 1.15,
    wheelZInset: 0.725, wheelXOffset: -0.1, // ~2.55 m wheelbase, ~1.56 m track
  }),

  // Fast, light, wild tail (box car).
  hornet: makeCar({
    name: "Hornet",
    color: 0xffcc33,
    halfWidth: 0.85, halfHeight: 0.4, halfLength: 1.95,
    wheelRadius: 0.32, wheelWidth: 0.22,
    mass: 1100,
    comOffset: { x: 0, y: -0.3, z: 0.0 },
    inertiaScale: { x: 1, y: 0.9, z: 1.5 },
    linearDamping: 0.08, angularDamping: 0.5,
    engineAccel: 14, reverseAccel: 6, maxBrake: 12, handbrake: 5.5,
    driveBias: { front: 0.5, back: 1.0 },
    topSpeed: 32, launchSpeed: 10, launchBoost: 0.6,
    overspeed: 0.2, overspeedAccel: 1.0,
    maxSteer: 0.62, steerRate: 9, turnSlowdown: 0.1, engineRate: 9.5,
    slipThreshold: 2.4, kineticGripRatio: 0.66,
    rearGripBias: 0.6, liftoffOversteer: 0.5, tailSlip: 0.28,
    powerOversteer: 0.7, handbrakeGrip: 0.18,
    leanStrength: 0.05, leanLowSpeedAmp: 2.2,
    brakeBiasFront: 0.58, weightTransfer: 0.24, accelTransfer: 0.25, brakeRamp: 12, lockupAt: 0.8, lockupGrip: 0.28,
    ...RALLY_SUSPENSION,
    suspensionStiffness: 20,
    frictionSlip: 2.8, sideFrictionStiffness: 1.0,
    wheelZInset: 0.7, wheelXOffset: -0.1,
  }),

  // Heavy, low, wide, very hard to flip.
  tank: makeCar({
    name: "Tank",
    color: 0x44dd88,
    halfWidth: 1.0, halfHeight: 0.42, halfLength: 2.2,
    wheelRadius: 0.38, wheelWidth: 0.3,
    mass: 2200,
    comOffset: { x: 0, y: -0.32, z: 0.05 },
    inertiaScale: { x: 1.2, y: 1.2, z: 1.6 },
    linearDamping: 0.14, angularDamping: 0.8,
    engineAccel: 9, reverseAccel: 4.5, maxBrake: 14, handbrake: 7,
    driveBias: { front: 1.0, back: 1.0 },
    topSpeed: 22, launchSpeed: 8, launchBoost: 0.4,
    overspeed: 0.2, overspeedAccel: 0.5,
    maxSteer: 0.52, steerRate: 7, turnSlowdown: 0.15, engineRate: 6.5,
    slipThreshold: 3.6, kineticGripRatio: 0.8,
    rearGripBias: 0.88, liftoffOversteer: 0.2, tailSlip: 0.12,
    powerOversteer: 0.3, handbrakeGrip: 0.3,
    leanStrength: 0.03, leanLowSpeedAmp: 1.6,
    brakeBiasFront: 0.66, weightTransfer: 0.16, accelTransfer: 0.15, brakeRamp: 8, lockupAt: 0.92, lockupGrip: 0.4,
    ...RALLY_SUSPENSION,
    suspensionStiffness: 28, suspensionCompression: 1.9, suspensionRelaxation: 2.6,
    frictionSlip: 3.6, sideFrictionStiffness: 0.85,
    visualScaleMultiplier: 2.0,
    wheelZInset: 0.8, wheelXOffset: -0.12,
  }),

  toyota: makeCar(TOYOTA),

  // Big pickup (Ram model).
  ram: makeCar({
    ...TOYOTA,
    name: "Ram",
    color: 0xdd4444,
    halfWidth: 1.0, halfHeight: 0.55, halfLength: 2.9, // ~5.8 m truck
    wheelRadius: 0.42, wheelWidth: 0.3,
    mass: 2400,
    comOffset: { x: 0, y: -0.38, z: 0.05 },
    engineAccel: 11, maxBrake: 13, handbrake: 6.5,
    topSpeed: 38,
    tailSlip: 0.05, weightTransfer: 0.15, powerOversteer: 0.45,
    visualRotationY: Math.PI,
    wheelZInsetFront: 1.125, wheelZInsetRear: 1.125, // ~3.55 m wheelbase
    wheelXOffset: -0.12,
  }),

  // Same driving as the Toyota, different model. The model is auto-fitted to these
  // physics wheels, so only touch visualYOffset/visualZOffset for small nudges.
  toyota6: makeCar({
    ...TOYOTA,
    name: "Toyota6",
    modelFile: "toyota6.glb",
  }),
};

export const DEFAULT_CAR = "toyota6";
