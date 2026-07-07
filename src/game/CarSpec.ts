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
  highSpeedSteer: number; // 0..1 fraction of full lock retained at top speed
                          //   (speed-sensitive steering; 1 = no reduction, lower =
                          //   calmer/less twitchy at speed)
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
    maxSteer: 0.55, steerRate: 4.5, highSpeedSteer: 0.5, turnSlowdown: 0.35, engineRate: 4.5,
    slipThreshold: 3.8, kineticGripRatio: 0.78, // front bites longer before letting go
    rearGripBias: 0.75, liftoffOversteer: 0.35, liftoffYaw: 3.0, tailSlip: 0.15,
    leanStrength: 0.05, leanLowSpeedAmp: 2.0,
    brakeBiasFront: 0.62, weightTransfer: 0.2, brakeRamp: 10, lockupAt: 0.85, lockupGrip: 0.2,
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
    maxSteer: 0.6, steerRate: 5.2, highSpeedSteer: 0.5, turnSlowdown: 0.3, engineRate: 5.5,
    slipThreshold: 2.6, kineticGripRatio: 0.7, // breaks loose earliest, slides most
    rearGripBias: 0.6, liftoffOversteer: 0.5, liftoffYaw: 2.6, tailSlip: 0.28, // rear-biased → loosest tail
    leanStrength: 0.06, leanLowSpeedAmp: 2.2, // light & expressive → leans the most
    // lighter & twitchier: more dive, locks sooner, slides more when locked
    brakeBiasFront: 0.58, weightTransfer: 0.24, brakeRamp: 12, lockupAt: 0.8, lockupGrip: 0.28,
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
    maxSteer: 0.5, steerRate: 4.0, highSpeedSteer: 0.6, turnSlowdown: 0.4, engineRate: 4.0,
    slipThreshold: 4.0, kineticGripRatio: 0.85, // planted, but now slides under provocation
    rearGripBias: 0.9, liftoffOversteer: 0.2, liftoffYaw: 1.2, tailSlip: 0.12, // planted → least tail slip
    leanStrength: 0.035, leanLowSpeedAmp: 1.6, // heavy → leans least
    // heavy & planted: little dive, very hard to lock, keeps grip when it does
    brakeBiasFront: 0.66, weightTransfer: 0.16, brakeRamp: 8, lockupAt: 0.92, lockupGrip: 0.4,
    suspensionRest: 0.32, suspensionStiffness: 50, suspensionTravel: 0.12,
    suspensionCompression: 2.4, suspensionRelaxation: 1.7,
    frictionSlip: 3.6, sideFrictionStiffness: 0.85,
  },
};

export const DEFAULT_CAR = "bolt";
