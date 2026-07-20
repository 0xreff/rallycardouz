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
import { Car } from "./Car";
import { CARS, DEFAULT_CAR } from "./CarSpec";
import { Track } from "./Track";
import { BotController } from "./BotController";

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
  private carKeys = Object.keys(CARS);
  private carIndex = this.carKeys.indexOf(DEFAULT_CAR);
  private clock = new THREE.Clock();
  private sun!: THREE.DirectionalLight;
  private speedEl: HTMLElement;
  private carNameEl: HTMLElement | null;
  private lastDisplayedSpeed = -1;

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
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
    this.bot = new Car(this.physics, this.scene, botSpawn, randomBot, this.skids, this.sparks, this.smoke, this.dust, this.track.surfaces);
    this.botAI = new BotController(this.physics, this.bot);

    // --- Post-processing ---
    // RenderPass → UnrealBloom (rim-glow) → OutputPass (tone map + sRGB) → SMAA.
    // SMAA runs last, on the final display-referred image, where edge detection
    // behaves best.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.55, // strength
      0.6,  // radius
      0.85  // threshold
    );
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    const pr = this.renderer.getPixelRatio();
    this.composer.addPass(new SMAAPass(window.innerWidth * pr, window.innerHeight * pr));

    this.speedEl = document.querySelector("#speed .val")!;

    window.addEventListener("resize", () => this.onResize());
  }

  private setupEnvironment() {
    this.scene.background = new THREE.Color(0x0a0e1a);
    this.scene.fog = new THREE.Fog(0x0a0e1a, 260, 1400);

    // Key light (sun) with shadows. The shadow frustum is kept tight and made to
    // follow the car each frame (see start()), so shadows stay crisp anywhere on
    // the big map without needing a huge, blurry shadow map.
    const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 120;
    const s = 80;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Cool ambient/hemisphere fill — gives the signature blue-tinted shadows.
    const hemi = new THREE.HemisphereLight(0x9bb8ff, 0x202840, 0.9);
    this.scene.add(hemi);
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
    this.car = new Car(this.physics, this.scene, this.track.spawn, spec, this.skids, this.sparks, this.smoke, this.dust, this.track.surfaces);
    if (this.carNameEl) this.carNameEl.textContent = spec.name;
    this.lastDisplayedSpeed = -1; // force HUD refresh for the new car

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

      // Physics advances in fixed 60 Hz substeps (framerate-independent
      // handling); car forces are applied immediately before each substep.
      // Save the pre-step state so syncMeshes can interpolate for smooth visuals.
      this.car.savePreviousState();
      this.bot.savePreviousState();
      this.physics.step(dt, (fixedDt) => {
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

      // Keep the shadow frustum centred on the car as it roams the large map.
      const cp = this.car.position(this._pos);
      this.sun.target.position.set(cp.x, cp.y, cp.z);
      this.sun.position.set(cp.x + 30, cp.y + 50, cp.z + 20);

      const ct = this._camTarget;
      this.car.position(ct.position);
      this.car.forwardVector(ct.forward);
      this.car.rightVector(ct.right);
      this.car.velocity(ct.velocity);
      ct.speedFrac = this.car.speedFraction();
      ct.steer = controls.steer;
      ct.airborne = this.car.isAirborne();
      ct.flipped = this.car.isFlipped();
      ct.impact = this.car.impactLevel();
      ct.lookLeft = controls.lookLeft;
      ct.lookRight = controls.lookRight;
      this.chase.update(ct, dt);

      // HUD speed (km/h) — only touch the DOM when the displayed value changes
      // to avoid piling up AXDirtyObject entries in the browser accessibility tree.
      const v = this.car.body.linvel();
      const kmh = Math.round(Math.hypot(v.x, v.y, v.z) * 3.6);
      if (kmh !== this.lastDisplayedSpeed) {
        this.speedEl.textContent = String(kmh);
        this.lastDisplayedSpeed = kmh;
      }

      this.composer.render();
    };
    loop();
  }
}
