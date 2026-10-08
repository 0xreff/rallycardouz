import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";

import { Physics } from "../physics/Physics";
import { Input } from "../engine/Input";
import { ChaseCamera } from "../engine/ChaseCamera";
import { SkidMarks } from "../engine/SkidMarks";
import { Sparks } from "../engine/Sparks";
import { Smoke } from "../engine/Smoke";
import { Dust } from "../engine/Dust";
import { NightAtmosphere, type Quality, type Theme } from "../engine/NightAtmosphere";
import { AtmospherePass } from "../engine/AtmospherePass";
import { Car } from "./Car";
import { CARS, DEFAULT_CAR } from "./CarSpec";
import { Track } from "./Track";
import { BotController } from "./BotController";
import { rpmFraction, isShifting, BOOST_TIME } from "./gearbox";
import { EngineAudio } from "../engine/EngineAudio";
import { EngineFx, type FxSink } from "../engine/EngineFx";

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private chase: ChaseCamera;
  private input = new Input();
  private car!: Car;
  private bot!: Car;
  private botAI!: BotController;
  private track!: Track;
  private skids!: SkidMarks;
  private sparks!: Sparks;
  private smoke!: Smoke;
  private dust!: Dust;
  private engineAudio = new EngineAudio(); // Engine Simulator samples (see tools/make_engine_loops.py)
  private engineFx: EngineFx | null = null; // overrun crackle / turbo spool (initialised after audio loads)
  private carKeys = Object.keys(CARS);
  private carIndex = this.carKeys.indexOf(DEFAULT_CAR);
  private clock = new THREE.Clock();
  private atmosphere!: NightAtmosphere;
  private atmospherePass!: AtmospherePass;
  // "low" on phones/tablets (no god rays, smaller shadow map, lower pixel ratio).
  // Override with ?quality=low or ?quality=high in the URL to test.
  private quality: Quality = detectQuality();
  // "desert-day" (hazy amber daytime) or "night" (the original violet moonlit look).
  // Override with ?theme=night or ?theme=day in the URL.
  private theme: Theme = detectTheme();
  private speedEl: HTMLElement;
  private carNameEl: HTMLElement | null;
  private lastDisplayedSpeed = -1;
  private gearEl: HTMLElement | null;
  private rpmEl: HTMLElement | null;
  private gearHintEl: HTMLElement | null;
  private lastGear = "";
  private lastRpmPct = -1;
  private lastHint = -1;

  // Pre-allocated scratch objects — eliminates per-frame Vector3 / object allocations.
  private _pos = new THREE.Vector3();
  private _camTarget: import("../engine/ChaseCamera").CameraTarget = {
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    speedFrac: 0, steer: 0, airborne: false, flipped: false, impact: 0,
    lookLeft: false, lookRight: false,
  };

  constructor(private physics: Physics, container: HTMLElement) {
    // --- Renderer ---
    // antialias:false — the EffectComposer renders through offscreen targets,
    // which bypass canvas MSAA anyway; SMAA at the end of the post chain does
    // the anti-aliasing instead, so the multisampled backbuffer is pure waste.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality === "low" ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.theme === "night" ? 1.05 : 1.0;
    container.appendChild(this.renderer.domElement);

    // --- Camera ---
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.chase = new ChaseCamera(this.camera);

    this.setupEnvironment();

    // --- World ---
    this.track = new Track(physics, this.scene);
    this.skids = new SkidMarks(this.scene); // persists across car swaps
    this.sparks = new Sparks(this.scene);   // collision sparks
    this.smoke = new Smoke(this.scene);     // tyre smoke
    this.dust = new Dust(this.scene);       // loose-surface dust trails
    this.carNameEl = document.querySelector("#carName");
    this.spawnCar(this.carIndex);

    // A wandering AI opponent that avoids crashing — spawned clear of the player.
    const botSpawn = this.track.spawn.clone().add(new THREE.Vector3(10, 0, 10));
    const botKeys = Object.keys(CARS);
    const randomBot = CARS[botKeys[Math.floor(Math.random() * botKeys.length)]];
    this.bot = new Car(this.physics, this.scene, botSpawn, randomBot, this.skids, this.sparks, this.smoke, this.dust, this.track.surfaces, { fxSlot: 1 });
    this.botAI = new BotController(this.physics, this.bot);

    // --- Post-processing ---
    // RenderPass → UnrealBloom → AtmospherePass (moon god rays + violet grade)
    // → OutputPass (tone map + sRGB) → SMAA.
    // SMAA runs last, on the final display-referred image, where edge detection
    // behaves best.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const day = this.theme === "desert-day";
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      day ? 0.38 : 0.55, // strength
      day ? 0.7 : 0.6,   // radius
      day ? 1.1 : 0.85   // threshold: by day only the sun and hot highlights bloom
    );
    this.composer.addPass(bloom);
    this.atmospherePass = new AtmospherePass(this.atmosphere.moonDir, this.quality, this.theme);
    this.composer.addPass(this.atmospherePass);
    this.composer.addPass(new OutputPass());
    const pr = this.renderer.getPixelRatio();
    this.composer.addPass(new SMAAPass(window.innerWidth * pr, window.innerHeight * pr));

    this.speedEl = document.querySelector("#speed .val")!;
    this.gearEl = document.querySelector("#gear");
    this.rpmEl = document.querySelector("#rpmBar");
    this.gearHintEl = document.querySelector("#gearHint");

    window.addEventListener("resize", () => this.onResize());

    // Start fetching/decoding the engine loops now; sound begins on the first key
    // press (browsers block audio until the player interacts with the page).
    // After loading, create the overrun crackle/pop layer.
    void this.engineAudio.load().then(() => {
      this.engineFx = this.createEngineFx();
    });
  }

  /**
   * Build the overrun crackle / turbo FX layer.  Uses the same AudioContext and
   * master bus as EngineAudio so pops go through the compressor and gain knob.
   * Loads real recordings from the manifest's oneShots ("pop_0", "pop_1", "bov").
   */
  private createEngineFx(): EngineFx | null {
    const ctx = this.engineAudio.getContext();
    const master = this.engineAudio.getMaster();
    if (!ctx || !master) return null;

    const POP_GAIN = 0.8;
    const BOV_GAIN = 0.8;
    const MAX_VOICES = 8;
    let activeVoices = 0;

    // --- Load recorded samples ---
    const popBuffers: AudioBuffer[] = [];
    for (let i = 0; i < 20; i++) {
      const buf = this.engineAudio.getOneShotBuffer(`pop_${i}`);
      if (buf) popBuffers.push(buf);
    }
    const bovBuffer = this.engineAudio.getOneShotBuffer("bov");

    if (popBuffers.length === 0 && !bovBuffer) {
      console.info("[EngineFx] No 'pop_X' or 'bov' oneShots found in manifest. Crackle FX disabled.");
      return null;
    }

    // --- FX gain bus (routed through the master/compressor) ---
    const fxBus = ctx.createGain();
    fxBus.gain.value = 1;
    fxBus.connect(master);

    const sink: FxSink = {
      pop(intensity, variant, pitch) {
        if (activeVoices >= MAX_VOICES || popBuffers.length === 0) return;
        const src = ctx.createBufferSource();
        src.buffer = popBuffers[variant % popBuffers.length];
        src.playbackRate.value = pitch;
        const g = ctx.createGain();
        g.gain.value = intensity * POP_GAIN;
        src.connect(g).connect(fxBus);
        activeVoices++;
        src.onended = () => { activeVoices--; };
        src.start();
      },
      bov(intensity) {
        if (activeVoices >= MAX_VOICES || !bovBuffer) return;
        const src = ctx.createBufferSource();
        src.buffer = bovBuffer;
        src.playbackRate.value = 0.9 + Math.random() * 0.2;
        const g = ctx.createGain();
        g.gain.value = intensity * BOV_GAIN;
        src.connect(g).connect(fxBus);
        activeVoices++;
        src.onended = () => { activeVoices--; };
        src.start();
      },
    };

    return new EngineFx(sink, Math.max(1, popBuffers.length));
  }

  private setupEnvironment() {
    // Desert atmosphere: sky dome (sun or moon + stars), fog, key light with shadows,
    // blowing sand. See engine/NightAtmosphere.ts (THEMES) to tune either look.
    this.atmosphere = new NightAtmosphere(this.scene, {
      quality: this.quality,
      pixelRatio: this.renderer.getPixelRatio(),
      theme: this.theme,
    });
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  private spawnCar(index: number) {
    if (this.car) this.car.dispose(this.scene, this.physics);
    const spec = CARS[this.carKeys[index]];
    this.car = new Car(this.physics, this.scene, this.track.spawn, spec, this.skids, this.sparks, this.smoke, this.dust, this.track.surfaces, { fxSlot: 0, headlightBeam: true });
    if (this.carNameEl) this.carNameEl.textContent = spec.name;
    this.lastDisplayedSpeed = -1; // force HUD refresh for the new car
    this.lastGear = "";
    this.lastRpmPct = -1;
    this.lastHint = -1;

    // Snap the camera behind the new car immediately so it doesn't sweep across the map.
    if (this.chase) {
      this.chase.snap({
        position: this.car.position(),
        forward: this.car.forwardVector(),
        right: this.car.rightVector(),
        velocity: this.car.velocity(),
        speedFrac: 0,
        steer: 0,
        airborne: false,
        flipped: false,
        impact: 0,
        lookLeft: false,
        lookRight: false,
      });
    }
  }

  /** Advance to the next car in the roster. */
  private cycleCar() {
    this.carIndex = (this.carIndex + 1) % this.carKeys.length;
    this.spawnCar(this.carIndex);
  }

  start() {
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 1 / 20);
      const controls = this.input.sample();

      if (controls.cycleCar) this.cycleCar();
      if (controls.changeView) this.chase.cycleMode();

      if (controls.reset) {
        this.car.reset();
        const ct = this._camTarget;
        this.car.position(ct.position);
        this.car.forwardVector(ct.forward);
        this.car.rightVector(ct.right);
        this.car.velocity(ct.velocity);
        ct.speedFrac = 0; ct.steer = 0; ct.airborne = false; ct.flipped = false;
        ct.impact = 0; ct.lookLeft = false; ct.lookRight = false;
        this.chase.snap(ct);
      }

      if (controls.recover) this.car.recover();
      // A teleport (reset / recover) must not be blended from the old spot.
      if (controls.reset || controls.recover) this.car.savePreviousState();

      // Physics advances in fixed 60 Hz substeps (framerate-independent
      // handling); car forces are applied immediately before each substep.
      // The pre-step state is snapshotted INSIDE each substep, so syncMeshes
      // always interpolates across exactly one fixed step (alpha 0..1). Doing it
      // once per frame froze the car on 0-substep frames and jumped it on
      // 2-substep frames — the acceleration stutter.
      this.physics.step(dt, (fixedDt) => {
        this.car.savePreviousState();
        this.bot.savePreviousState();
        this.car.update(controls, fixedDt);
        this.bot.update(this.botAI.sample(fixedDt), fixedDt); // AI opponent
      });
      const alpha = this.physics.alpha;
      this.car.syncMeshes(alpha);
      this.bot.syncMeshes(alpha);
      this.track.syncProps(); // pushable crates follow physics
      this.sparks.update(dt); // advance collision sparks
      this.smoke.update(dt);  // advance tyre smoke
      this.dust.update(dt);   // advance surface dust
      this.skids.update(dt);  // fade old tyre tracks

      const cp = this.car.renderPosition(this._pos); // interpolated car position

      // Feed the camera the INTERPOLATED state (same as the rendered mesh), not
      // the raw 60 Hz physics state, so camera and car move in lockstep and the
      // camera's accel-driven FOV / push-back doesn't flicker.
      const ct = this._camTarget;
      this.car.renderPosition(ct.position);
      this.car.renderForward(ct.forward);
      this.car.renderRight(ct.right);
      this.car.renderVelocity(ct.velocity);
      ct.speedFrac = this.car.speedFraction();
      ct.steer = controls.steer;
      ct.airborne = this.car.isAirborne();
      ct.flipped = this.car.isFlipped();
      ct.impact = this.car.impactLevel();
      ct.lookLeft = controls.lookLeft;
      ct.lookRight = controls.lookRight;
      ct.lookBack = controls.lookBack;
      this.chase.update(ct, dt);

      // Night atmosphere: sky follows the camera, moon shadows follow the car,
      // and the post pass tracks where the moon is on screen.
      this.atmosphere.update(dt, this.camera, cp);
      this.atmospherePass.updateCamera(this.camera);

      // HUD speed (km/h) — only touch the DOM when the displayed value changes
      // to avoid piling up AXDirtyObject entries in the browser accessibility tree.
      const v = this.car.body.linvel();
      const kmh = Math.round(Math.hypot(v.x, v.y, v.z) * 3.6);
      if (kmh !== this.lastDisplayedSpeed) {
        this.speedEl.textContent = String(kmh);
        this.lastDisplayedSpeed = kmh;
      }

      // HUD gearbox: gear (R when reversing), RPM bar and the 6th-gear prompt.
      // Same rule as the speed: only touch the DOM when a value changes.
      const gb = this.car.gearState();
      const gearTxt = ct.velocity.dot(ct.forward) < -0.5 ? "R" : String(gb.gear);
      if (gearTxt !== this.lastGear && this.gearEl) {
        this.gearEl.textContent = gearTxt;
        this.lastGear = gearTxt;
      }
      const rpmPct = Math.round(rpmFraction(gb.rpm) * 100);
      if (rpmPct !== this.lastRpmPct && this.rpmEl) {
        this.rpmEl.style.width = `${rpmPct}%`;
        this.lastRpmPct = rpmPct;
      }
      const hint = gb.boostTimer > 0 ? 2 : this.car.canUnlockSixth() ? 1 : 0;
      if (hint !== this.lastHint && this.gearHintEl) {
        this.gearHintEl.textContent = hint === 2 ? "6TH UNLOCKED!" : hint === 1 ? "HOLD T → 6TH" : "";
        this.gearHintEl.className = hint === 2 ? "boom" : hint === 1 ? "ready" : "";
        this.lastHint = hint;
      }

      // Engine sound. RPM / shift state come from the gearbox, so the audio follows
      // exactly what the HUD shows. "limiter" = pinned on the redline under throttle.
      const rpmFrac = rpmFraction(gb.rpm);
      this.engineAudio.update(
        {
          rpmFrac,
          rpm: gb.rpm,
          throttle: controls.throttle,
          shifting: isShifting(gb),
          limiter: controls.throttle > 0 && rpmFrac >= 0.97,
        },
        dt
      );

      // Overrun crackle / turbo spool FX layer.
      if (this.engineFx) {
        this.engineFx.update(
          dt,
          controls.throttle,
          rpmFrac,
          gb.shiftSeq,
          gb.shiftDir,
          gb.boostTimer > 0 ? gb.boostTimer / BOOST_TIME : 0
        );
      }

      this.composer.render();
    };
    loop();
  }
}

function detectTheme(): Theme {
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "night") return "night";
  if (forced === "day" || forced === "desert-day") return "desert-day";
  return "desert-day";
}

function detectQuality(): Quality {
  const forced = new URLSearchParams(window.location.search).get("quality");
  if (forced === "low" || forced === "high") return forced;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse ? "low" : "high";
}
