/**
 * Per-car tuning. Every car in the roster is just a different CarSpec — no
 * physics constants are hardcoded in the Car class itself, so cars can vary in
 * size, height, speed, grip, drive layout, suspension and stability.
 *
 * Values are in a metric, gameplay scale. They are *informed* by the reference
 * build's car parameters (handling ratios, drive bias, spring feel) but are our
 * own numbers for our own original cars.
 */
export interface CarSpec {
  name: string;
  color: number;

  // Geometry / silhouette (metres, half-extents). Taller cars raise the CoM and
  // are easier to tip; lower & wider cars feel planted.
  halfWidth: number;
  halfHeight: number;
  halfLength: number;
  wheelRadius: number;
  wheelWidth: number;

  // Mass & balance.
  mass: number;
  comOffset: { x: number; y: number; z: number }; // centre of mass; lower y = more anti-roll
  inertia: { x: number; y: number; z: number };    // higher z resists rolling over in turns
  linearDamping: number;
  angularDamping: number;                           // higher = calmer rotation, harder to flip

  // Drive & speed.
  engineForce: number;   // per powered wheel
  reverseForce: number;
  maxBrake: number;
  handbrake: number;
  driveBias: { front: number; back: number }; // 0..1 force multiplier per axle (FWD/RWD/AWD)
  topSpeed: number;      // m/s — the limit full power pulls you to
  launchSpeed: number;   // m/s by which off-the-line boost fades
  launchBoost: number;   // extra fraction of engine force when launching straight
  overspeed: number;      // fraction above topSpeed the car slowly climbs to and
  //   tops out at — the REAL max (0.2 = max is +20% over
  //   the limit; topSpeed is just where the slow climb begins)
  overspeedAccel: number; // how fast the top-speed cap creeps up past the limit
  //   (m/s²) — per-car: more power / less weight → faster

  // Steering.
  maxSteer: number;      // radians at full lock
  steerRate: number;     // how fast steering approaches the target
  turnSlowdown: number;  // 0..1, how much throttle eases off at full lock
  engineRate: number;    // how fast engine/reverse force ramps in (ref EngineRate)

  // Static→kinetic grip model (emulates the reference's two friction tiers).
  // Above slipThreshold of sideways speed the tire "lets go" to kineticGripRatio
  // of its grip, then re-grips below it — this is the slip-then-bite cornering
  // and brake-slide feel.
  slipThreshold: number;   // m/s of lateral slip before the tire breaks loose
  kineticGripRatio: number; // 0..1 grip retained while sliding (ref ≈ 0.9)
  rearGripBias: number;     // <1 → rear axle breaks loose earlier than the front,
  //      giving progressive, catchable oversteer/drift
  liftoffOversteer: number; // 0..1 how much lifting off the throttle mid-corner
  //      loosens the rear to tighten the turn (the trick)
  liftoffYaw: number;       // low-speed turn assist (rad/s²): on throttle release
  //      the tail angles to help rotate the car when slow
  tailSlip: number;         // 0..1 how much the rear gives up grip while cornering
  //      at speed → a persistent, lively tail-out slip
  //      angle (the car's momentum resisting the turn)

  // Cosmetic body lean (visual only — the physics body stays upright, never tips).
  leanStrength: number;     // radians of visible body roll per m/s of lateral slide
  leanLowSpeedAmp: number;  // lean multiplier at a standstill, fading to 1 at top speed

  // Brake feel (weight transfer · friction circle · lockup). Braking acts through
  // the tyres, so it shares grip with cornering and can lock up and skid.
  brakeBiasFront: number;  // 0..1 front share of the foot brake (real cars ~0.6)
  weightTransfer: number;  // grip shifted front↔rear under braking (nose dives,
  //   rear goes light) — keep modest, ~0.15..0.25
  accelTransfer: number;   // grip shifted front↔rear under throttle (rear squats,
  //   front goes light) — plants the rear on throttle
  brakeRamp: number;       // pedal pressure build-up/release rate (1/s)
  lockupAt: number;        // brake pressure (0..1) at which tyres start to skid
  lockupGrip: number;      // 0..1 grip retained by a fully locked (skidding) tyre

  // Suspension & grip — the big levers for "stability in turns".
  suspensionRest: number;
  suspensionStiffness: number;
  suspensionTravel: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  frictionSlip: number;          // forward/overall grip
  sideFrictionStiffness: number; // lateral grip; higher grips harder (and can tip a tall car)

  // --- Visual & Wheel Tuning (for .glb models) ---
  modelFile?: string;             // .glb in public/assets/ (e.g. "toyota6.glb"); loaded instead of the box car
  visualScaleMultiplier?: number; // Shrink/grow the 3D model (e.g. 3.0, 4.0)
  visualZOffset?: number;         // Slide the 3D model forward/backward (+/- meters)
  visualYOffset?: number;         // Slide the 3D model up/down (+/- meters) to fix tire overlap
  visualRotationY?: number;       // Rotate the 3D model on the Y axis (in radians)
  wheelZInset?: number;           // How far wheels are inset from bumpers (default 0.25)
  wheelZInsetFront?: number;      // Front axle distance from front bumper (overrides wheelZInset)
  wheelZInsetRear?: number;       // Rear axle distance from rear bumper (overrides wheelZInset)
  wheelXOffset?: number;          // Pushes wheels outward (+ value) for a wider track
}

/**
 * The roster. Three deliberately different cars to prove the spec drives
 * everything — a balanced all-rounder, a fast but twitchy/tippy racer, and a
 * slow, low, ultra-stable bruiser. Add more by appending CarSpecs.
 */
export const CARS: Record<string, CarSpec> = {
  // Balanced all-rounder (the car we've been tuning).
  bolt: {
    name: "Bolt",
    color: 0x2f6bff,
    halfWidth: 0.55, halfHeight: 0.28, halfLength: 0.95,
    wheelRadius: 0.34, wheelWidth: 0.26,
    mass: 2.0,
    comOffset: { x: 0, y: -0.42, z: 0.05 },
    inertia: { x: 1.5, y: 1.65, z: 1.6 }, // higher y (yaw) → more rotational momentum: tail carries & trails
    linearDamping: 0.15, angularDamping: 0.9, // lower → the yaw swing persists (tail follows the motion)
    engineForce: 52, reverseForce: 28, maxBrake: 16, handbrake: 22,
    driveBias: { front: 0.7, back: 0.9 }, // rear-leaning AWD → rotates instead of FWD-plowing wide
    topSpeed: 26, launchSpeed: 9, launchBoost: 0.3,
    overspeed: 0.2, overspeedAccel: 0.8, // climbs to +20% over the limit, then tops out
    maxSteer: 0.55, steerRate: 6.0, turnSlowdown: 0.15, engineRate: 4.5,
    slipThreshold: 3.8, kineticGripRatio: 0.78, // front bites longer before letting go
    rearGripBias: 0.75, liftoffOversteer: 0.35, liftoffYaw: 3.0, tailSlip: 0.15,
    leanStrength: 0.05, leanLowSpeedAmp: 2.0,
    brakeBiasFront: 0.62, weightTransfer: 0.2, accelTransfer: 0.2, brakeRamp: 10, lockupAt: 0.85, lockupGrip: 0.2,
    suspensionRest: 0.3, suspensionStiffness: 45, suspensionTravel: 0.13,
    suspensionCompression: 2.2, suspensionRelaxation: 1.6,
    frictionSlip: 3.2, sideFrictionStiffness: 1.15, // more lateral bite → turns in, stops pushing wide
  },

  // Fast, light, taller — quick but easier to upset in hard corners.
  hornet: {
    name: "Hornet",
    color: 0xffcc33,
    halfWidth: 0.52, halfHeight: 0.3, halfLength: 0.9, // a touch wider/lower than before
    wheelRadius: 0.33, wheelWidth: 0.24,
    mass: 1.6,
    comOffset: { x: 0, y: -0.4, z: 0.0 }, // pulled low so it stops flipping
    inertia: { x: 1.4, y: 1.55, z: 1.5 }, // light & loose → tail swings out easily
    linearDamping: 0.12, angularDamping: 0.8,
    engineForce: 58, reverseForce: 32, maxBrake: 15, handbrake: 22,
    driveBias: { front: 0.5, back: 1.0 }, // rear-biased → looser tail
    topSpeed: 32, launchSpeed: 10, launchBoost: 0.4,
    overspeed: 0.2, overspeedAccel: 1.0, // light & powerful → climbs fastest
    maxSteer: 0.6, steerRate: 6.5, turnSlowdown: 0.15, engineRate: 5.5,
    slipThreshold: 2.6, kineticGripRatio: 0.7, // breaks loose earliest, slides most
    rearGripBias: 0.6, liftoffOversteer: 0.5, liftoffYaw: 2.6, tailSlip: 0.28, // rear-biased → loosest tail
    leanStrength: 0.06, leanLowSpeedAmp: 2.2, // light & expressive → leans the most
    // lighter & twitchier: more dive, locks sooner, slides more when locked
    brakeBiasFront: 0.58, weightTransfer: 0.24, accelTransfer: 0.25, brakeRamp: 12, lockupAt: 0.8, lockupGrip: 0.28,
    suspensionRest: 0.3, suspensionStiffness: 42, suspensionTravel: 0.13,
    suspensionCompression: 2.1, suspensionRelaxation: 1.5,
    frictionSlip: 2.8, sideFrictionStiffness: 1.0,
  },

  // Heavy, low, wide — slow to accelerate but very hard to flip.
  tank: {
    name: "Tank",
    color: 0x44dd88,
    halfWidth: 0.62, halfHeight: 0.24, halfLength: 1.0,
    wheelRadius: 0.36, wheelWidth: 0.32,
    mass: 3.0,
    comOffset: { x: 0, y: -0.46, z: 0.05 },
    inertia: { x: 1.9, y: 2.05, z: 2.2 }, // very heavy → slow, weighty rotation
    linearDamping: 0.18, angularDamping: 1.2,
    engineForce: 46, reverseForce: 24, maxBrake: 20, handbrake: 26,
    driveBias: { front: 1.0, back: 1.0 }, // AWD
    topSpeed: 22, launchSpeed: 8, launchBoost: 0.25,
    overspeed: 0.2, overspeedAccel: 0.5, // heavy → climbs slowest toward +20%
    maxSteer: 0.5, steerRate: 5.5, turnSlowdown: 0.2, engineRate: 4.0,
    slipThreshold: 4.0, kineticGripRatio: 0.85, // planted, but now slides under provocation
    rearGripBias: 0.9, liftoffOversteer: 0.2, liftoffYaw: 1.2, tailSlip: 0.12, // planted → least tail slip
    leanStrength: 0.035, leanLowSpeedAmp: 1.6, // heavy → leans least
    // heavy & planted: little dive, very hard to lock, keeps grip when it does
    brakeBiasFront: 0.66, weightTransfer: 0.16, accelTransfer: 0.15, brakeRamp: 8, lockupAt: 0.92, lockupGrip: 0.4,
    suspensionRest: 0.32, suspensionStiffness: 50, suspensionTravel: 0.12,
    suspensionCompression: 2.4, suspensionRelaxation: 1.7,
    frictionSlip: 3.6, sideFrictionStiffness: 0.85,
  },

  // A new reliable, well-rounded Toyota build
  toyota: {
    name: "Toyota",
    color: 0xdddddd,
    halfWidth: 0.60, halfHeight: 0.28, halfLength: 1.1,
    wheelRadius: 0.34, wheelWidth: 0.29,
    mass: 4.2,
    comOffset: { x: 0, y: -0.4, z: 0.05 },
    inertia: { x: 1.6, y: 1.7, z: 1.7 },
    linearDamping: 0.15, angularDamping: 0.9,
    engineForce: 105, reverseForce: 35, maxBrake: 25, handbrake: 50,
    driveBias: { front: 0.6, back: 0.4 }, // AWD for massive stability and launch
    topSpeed: 48, launchSpeed: 14, launchBoost: 0.45,
    overspeed: 0.25, overspeedAccel: 1.2,
    maxSteer: 0.58, steerRate: 8.5, turnSlowdown: 0.08, engineRate: 6.5,
    slipThreshold: 4.5, kineticGripRatio: 0.85,
    rearGripBias: 0.92, liftoffOversteer: 0.1, liftoffYaw: 3.5, tailSlip: 0.25,
    leanStrength: 0.045, leanLowSpeedAmp: 1.8,
    brakeBiasFront: 0.65, weightTransfer: 0.25, accelTransfer: 0.15, brakeRamp: 12, lockupAt: 0.9, lockupGrip: 0.35,
    suspensionRest: 0.35, suspensionStiffness: 85, suspensionTravel: 0.13,
    suspensionCompression: 3.5, suspensionRelaxation: 2.8,
    frictionSlip: 3.9, sideFrictionStiffness: 1.45,

    // --- Tuning for the 3D Model ---
    visualScaleMultiplier: 4.0,
    visualZOffset: 0.0,
    visualYOffset: 0.2,     // Raised higher to counteract suspension sag
    wheelZInsetFront: -0.3, // Tweaks front wheels forward/back independently
    wheelZInsetRear: -0.127,  // Tweaks rear wheels forward/back independently
    wheelXOffset: 0.16,     // Makes the left/right wheels wider apart without changing physics chassis
  },

  // The new Ram build (identical physics/size to Toyota, per request)
  ram: {
    name: "Ram",
    color: 0xdd4444, // Reddish color just to distinguish
    halfWidth: 0.60, halfHeight: 0.28, halfLength: 1.1,
    wheelRadius: 0.34, wheelWidth: 0.26,
    mass: 2.2,
    comOffset: { x: 0, y: -0.4, z: 0.05 },
    inertia: { x: 1.6, y: 1.7, z: 1.7 },
    linearDamping: 0.15, angularDamping: 0.9,
    engineForce: 75, reverseForce: 35, maxBrake: 25, handbrake: 30,
    driveBias: { front: 0.6, back: 0.4 },
    topSpeed: 38, launchSpeed: 14, launchBoost: 0.45,
    overspeed: 0.25, overspeedAccel: 1.2,
    maxSteer: 0.58, steerRate: 8.5, turnSlowdown: 0.08, engineRate: 6.5,
    slipThreshold: 4.5, kineticGripRatio: 0.85,
    rearGripBias: 0.92, liftoffOversteer: 0.1, liftoffYaw: 1.5, tailSlip: 0.05,
    leanStrength: 0.045, leanLowSpeedAmp: 1.8,
    brakeBiasFront: 0.65, weightTransfer: 0.15, accelTransfer: 0.15, brakeRamp: 12, lockupAt: 0.9, lockupGrip: 0.35,
    suspensionRest: 0.35, suspensionStiffness: 85, suspensionTravel: 0.13,
    suspensionCompression: 3.5, suspensionRelaxation: 2.8,
    frictionSlip: 3.9, sideFrictionStiffness: 1.45,

    // --- Tuning for the 3D Model ---
    visualScaleMultiplier: 4.0,
    visualZOffset: 0.0,
    visualYOffset: -0.2,     // Raises the chassis slightly so built-in tyres don't clip the ground
    visualRotationY: Math.PI,
    wheelZInsetFront: -0.12,
    wheelZInsetRear: -0.39,
    wheelXOffset: 0.16,
  },
};

// Toyota6: same driving as the Toyota, different 3D model (toyota6.glb in public/assets/).
// The visual values below are starting guesses — tune them by eye (see comments).
CARS.toyota6 = {
  ...CARS.toyota,
  name: "Toyota6",
  modelFile: "toyota6.glb",
  visualScaleMultiplier: 4.0, // bigger → model grows; match its length to the physics box
  visualZOffset: -0.5,         // slide the body forward (+) / backward (-)
  visualYOffset: 0.0,         // raise (+) / lower (-) the body
  visualRotationY: 0,         // Math.PI if the car drives backwards
  wheelZInsetFront: 0.25,     // front wheels: bigger → further from the front bumper
  wheelZInsetRear: -0.5,      // rear wheels: bigger → further from the rear bumper
  wheelXOffset: 0.25,          // + pushes all wheels outward (wider track)
};

export const DEFAULT_CAR = "toyota6";