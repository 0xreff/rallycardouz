import * as THREE from 'three';
import { config, QUALITY_PRESETS } from './config.js';
import { atmosphereUniforms, syncAtmosphere } from './atmosphere.js';
import { Sky } from './sky.js';
import { Terrain } from './terrain.js';
import { Rocks } from './rocks.js';
import { DustSystem, HazeSheets } from './dust.js';
import { Vehicle, KeyboardInput } from './vehicle.js';
import { CameraRig } from './cameraRig.js';
import { PostFX } from './postprocessing.js';
import { createDebugGui } from './debugGui.js';

let preset = QUALITY_PRESETS[config.quality];

// --- Renderer: ACES + sRGB are applied by the OutputPass in the post chain ---
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(config.camera.fov, window.innerWidth / window.innerHeight, 0.5, 9000);

// --- World ---
syncAtmosphere(config);
const sky = new Sky(scene);
const terrain = new Terrain(scene, config);
terrain.build(preset.terrainSegments);
const rocks = new Rocks(scene, terrain, config);

// --- Lights: one low sun with a tight, texel-snapped shadow box that follows the car ---
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.06; // grazing sun on sand = acne without this
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 900;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
scene.add(hemi);

// Spawn heading 25 deg left of the sun so it sits upper-right of frame.
const startHeading = THREE.MathUtils.degToRad(config.sun.azimuth + 25);
const vehicle = new Vehicle(scene, terrain, config, startHeading);
const input = new KeyboardInput();
const rig = new CameraRig(camera, vehicle, terrain, config);
const dust = new DustSystem(scene, terrain, config, QUALITY_PRESETS.HIGH.maxParticles);
const haze = new HazeSheets(scene, terrain, config, QUALITY_PRESETS.HIGH.hazeSheets);
const post = new PostFX(renderer, scene, camera, config, preset);

// To use a real car instead of the placeholder:
// vehicle.loadModel('../public/assets/toyota.glb', { length: 4.2, yaw: 0 });

function applyConfig() {
  syncAtmosphere(config);
  sky.sync(config);
  terrain.sync(config);
  rocks.sync(config);
  dust.sync(config);
  haze.sync(config);
  vehicle.sync(config);
  post.sync(config);
  sun.color.set(config.sun.color);
  sun.intensity = config.sun.intensity;
  hemi.color.set(config.hemi.sky);
  hemi.groundColor.set(config.hemi.ground);
  hemi.intensity = config.hemi.intensity;
  renderer.toneMappingExposure = config.exposure;
}

function applyQuality() {
  const prev = preset;
  preset = QUALITY_PRESETS[config.quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));
  sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
  if (sun.shadow.map) {
    sun.shadow.map.dispose();
    sun.shadow.map = null; // re-created at the new size on next render
  }
  const e = preset.shadowExtent, sc = sun.shadow.camera;
  sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e;
  sc.updateProjectionMatrix();
  dust.setLimit(preset.maxParticles);
  haze.setCount(preset.hazeSheets);
  terrain.uniforms.uRippleDetail.value = preset.rippleDetail;
  if (prev.terrainSegments !== preset.terrainSegments) terrain.build(preset.terrainSegments);
  post.setQuality(preset);
  onResize();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize();
}
window.addEventListener('resize', onResize);

// Shadow follow with texel snapping (no shimmering shadow edges while driving).
const _center = new THREE.Vector3();
const _lightMat = new THREE.Matrix4();
const _lightInv = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _yUp = new THREE.Vector3(0, 1, 0);
function updateSun() {
  const dir = atmosphereUniforms.uSunDir.value;
  const e = preset.shadowExtent;
  _center.copy(vehicle.position).addScaledVector(vehicle.forwardFlat, e * 0.35);
  _lightMat.lookAt(dir, _origin, _yUp);
  _lightInv.copy(_lightMat).invert();
  _center.applyMatrix4(_lightInv);
  const texel = (2 * e) / preset.shadowMapSize;
  _center.x = Math.round(_center.x / texel) * texel;
  _center.y = Math.round(_center.y / texel) * texel;
  _center.applyMatrix4(_lightMat);
  sun.target.position.copy(_center);
  sun.position.copy(_center).addScaledVector(dir, 400);
  sun.target.updateMatrixWorld();
}

const gui = createDebugGui(config, QUALITY_PRESETS, { onChange: applyConfig, onQuality: applyQuality });
applyConfig();
applyQuality();

// --- Loop ---
const fpsEl = document.getElementById('fps');
const clock = new THREE.Clock();
let fpsFrames = 0, fpsTime = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  atmosphereUniforms.uTime.value += dt;

  if (input.consumeTouched() && config.vehicle.autoDrive) {
    config.vehicle.autoDrive = false;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
  if (input.consumePress('KeyP')) {
    config.vehicle.autoDrive = !config.vehicle.autoDrive;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
  if (input.consumePress('KeyH')) gui.domElement.style.display = gui.domElement.style.display === 'none' ? '' : 'none';

  vehicle.update(input.sample(), dt);
  rig.update(dt);
  sky.update(camera);
  updateSun();
  dust.update(dt, vehicle);
  haze.update(camera);
  post.update(dt, camera);
  post.render();

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fpsEl.textContent = `${Math.round(fpsFrames / fpsTime)} fps - ${config.quality}`;
    fpsFrames = 0;
    fpsTime = 0;
  }
});
