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

// Toyota pickup: shared by the Toyota and Toyota6 (same driving, different model).
// Rear-biased AWD rally truck: throttle swings the tail, handbrake flicks it round.
const TOYOTA: CarInput = {
  name: "Toyota",
  color: 0xdddddd,
  halfWidth: 0.93, halfHeight: 0.5, halfLength: 2.45, // ~1.86 x 1.0 x 4.9 m body
  wheelRadius: 0.4, wheelWidth: 0.28,
  mass: 1900,
  comOffset: { x: 0, y: -0.35, z: 0.1 },
  inertiaScale: { x: 1, y: 0.65, z: 1.5 },
  linearDamping: 0.1, angularDamping: 0.35,
  engineAccel: 17, reverseAccel: 7, maxBrake: 24, handbrake: 4.5,
  driveBias: { front: 0.35, back: 0.65 },
  topSpeed: 48, launchSpeed: 14, launchBoost: 0.8,
  overspeed: 0.25, overspeedAccel: 1.2,
  maxSteer: 0.68, steerRate: 16, turnSlowdown: 0.02, engineRate: 16,
  slipThreshold: 2.5, kineticGripRatio: 0.58,
  rearGripBias: 0.72, liftoffOversteer: 0.38, tailSlip: 0.20,
  powerOversteer: 0.6, handbrakeGrip: 0.15,
  leanStrength: 0.04, leanLowSpeedAmp: 1.8,
  brakeBiasFront: 0.65, weightTransfer: 0.25, accelTransfer: 0.15, brakeRamp: 20, lockupAt: 0.97, lockupGrip: 0.35,
  ...RALLY_SUSPENSION,
  suspensionStiffness: 38, suspensionCompression: 2.8, suspensionRelaxation: 4.3,
  frictionSlip: 3.9, sideFrictionStiffness: 1.45,
  visualScaleMultiplier: 2.0, // fallback only: bumper-to-bumper = collider length
  wheelZInsetFront: 0.95, wheelZInsetRear: 0.95, // ~3.0 m wheelbase
  wheelXOffset: -0.13,                           // ~1.6 m track
};

/**
 * The roster, tuned arcade-snappy: quick launch, quick turn-in, hard stops and
 * big, easy drifts (power / lift-off / handbrake oversteer), on heavy planted
 * suspension. Each car keeps its character: Bolt balanced, Hornet wild, Tank planted.
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
    inertiaScale: { x: 1, y: 0.7, z: 1.5 },
    linearDamping: 0.1, angularDamping: 0.35,
    engineAccel: 16, reverseAccel: 6.5, maxBrake: 22, handbrake: 4.5,
    driveBias: { front: 0.7, back: 0.9 },
    topSpeed: 46, launchSpeed: 9, launchBoost: 0.7,
    overspeed: 0.2, overspeedAccel: 0.8,
    maxSteer: 0.65, steerRate: 15, turnSlowdown: 0.03, engineRate: 15,
    slipThreshold: 2.6, kineticGripRatio: 0.58,
    rearGripBias: 0.70, liftoffOversteer: 0.35, tailSlip: 0.15,
    powerOversteer: 0.55, handbrakeGrip: 0.18,
    leanStrength: 0.045, leanLowSpeedAmp: 2.0,
    brakeBiasFront: 0.62, weightTransfer: 0.2, accelTransfer: 0.2, brakeRamp: 18, lockupAt: 0.96, lockupGrip: 0.2,
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
    inertiaScale: { x: 1, y: 0.6, z: 1.5 },
    linearDamping: 0.08, angularDamping: 0.3,
    engineAccel: 18, reverseAccel: 7, maxBrake: 22, handbrake: 4,
    driveBias: { front: 0.5, back: 1.0 },
    topSpeed: 52, launchSpeed: 10, launchBoost: 0.8,
    overspeed: 0.2, overspeedAccel: 1.0,
    maxSteer: 0.68, steerRate: 17, turnSlowdown: 0.02, engineRate: 16,
    slipThreshold: 2.0, kineticGripRatio: 0.52,
    rearGripBias: 0.58, liftoffOversteer: 0.45, tailSlip: 0.22,
    powerOversteer: 0.7, handbrakeGrip: 0.12,
    leanStrength: 0.05, leanLowSpeedAmp: 2.2,
    brakeBiasFront: 0.58, weightTransfer: 0.24, accelTransfer: 0.25, brakeRamp: 20, lockupAt: 0.95, lockupGrip: 0.28,
    ...RALLY_SUSPENSION,
    suspensionStiffness: 32,
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
    inertiaScale: { x: 1.2, y: 0.85, z: 1.6 },
    linearDamping: 0.12, angularDamping: 0.45,
    engineAccel: 12, reverseAccel: 5.5, maxBrake: 22, handbrake: 5,
    driveBias: { front: 1.0, back: 1.0 },
    topSpeed: 42, launchSpeed: 8, launchBoost: 0.55,
    overspeed: 0.2, overspeedAccel: 0.5,
    maxSteer: 0.60, steerRate: 12, turnSlowdown: 0.04, engineRate: 12,
    slipThreshold: 2.8, kineticGripRatio: 0.65,
    rearGripBias: 0.82, liftoffOversteer: 0.22, tailSlip: 0.10,
    powerOversteer: 0.38, handbrakeGrip: 0.22,
    leanStrength: 0.03, leanLowSpeedAmp: 1.6,
    brakeBiasFront: 0.66, weightTransfer: 0.16, accelTransfer: 0.15, brakeRamp: 14, lockupAt: 0.96, lockupGrip: 0.4,
    ...RALLY_SUSPENSION,
    suspensionStiffness: 45, suspensionCompression: 3.0, suspensionRelaxation: 4.7,
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
    engineAccel: 14, maxBrake: 52, handbrake: 5,
    topSpeed: 44,
    angularDamping: 0.38,
    turnSlowdown: 0.03,
    tailSlip: 0.10, weightTransfer: 0.15, powerOversteer: 0.5,
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
