import * as THREE from "three";

/**
 * Night desert atmosphere: a violet moonlit sky (gradient, stars, moon), matching
 * fog, moonlight with shadows, blowing sand and sand ripples on the ground.
 *
 * Everything that moves is animated on the GPU from a single `time` uniform, so
 * the per-frame CPU cost is a handful of uniform writes.
 *
 * The same lights, fog and sky light the MAP and the CAR together — nothing here
 * needs to be applied per object, except `applyGroundWind()` (map only).
 */

export type Quality = "high" | "low";

// --- Tuning -----------------------------------------------------------------
// Moon direction (towards the moon). ~21° above the horizon, ahead of the spawn
// heading (+Z) so it is visible from the start. Raise the Y value for a higher moon.
const MOON_DIR = new THREE.Vector3(0.3, 0.36, 0.88).normalize();

const HORIZON = new THREE.Color(0x251a4a); // sky at the horizon AND the fog colour (seamless)
const ZENITH = new THREE.Color(0x05050f);
const MOON_TINT = new THREE.Color(0.85, 0.82, 1.0);
const MOON_LIGHT = new THREE.Color(0xb4a8ff);
const HEMI_SKY = new THREE.Color(0x6a5cc8);
const HEMI_GROUND = new THREE.Color(0x1b1535);

const WIND_DIR = new THREE.Vector2(1, 0.35).normalize();
const WIND_SPEED = 7; // m/s, blowing sand

export interface NightOptions {
  quality?: Quality;
  pixelRatio?: number;
}

export class NightAtmosphere {
  readonly moonDir = MOON_DIR.clone();
  readonly moonLight: THREE.DirectionalLight;
  readonly quality: Quality;

  private readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly sand: THREE.Points;
  private readonly sandMat: THREE.ShaderMaterial;
  private readonly timeU = { value: 0 };
  private readonly windDirU = { value: WIND_DIR.clone() };

  constructor(private readonly scene: THREE.Scene, opts: NightOptions = {}) {
    this.quality = opts.quality ?? "high";
    const high = this.quality === "high";

    scene.background = HORIZON.clone();
    scene.fog = new THREE.Fog(HORIZON.getHex(), 220, 1300);

    // --- Moonlight (key light, with shadows following the car) ---
    const moon = new THREE.DirectionalLight(MOON_LIGHT, 0.6);
    moon.castShadow = true;
    const shadowSize = high ? 2048 : 1024;
    moon.shadow.mapSize.set(shadowSize, shadowSize);
    moon.shadow.camera.near = 10;
    moon.shadow.camera.far = 140;
    const s = 80;
    moon.shadow.camera.left = -s;
    moon.shadow.camera.right = s;
    moon.shadow.camera.top = s;
    moon.shadow.camera.bottom = -s;
    moon.shadow.bias = -0.0004;
    moon.position.copy(this.moonDir).multiplyScalar(70);
    scene.add(moon);
    scene.add(moon.target);
    this.moonLight = moon;

    // Violet fill from the sky, darker violet bounce from the ground.
    scene.add(new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, 0.85));

    // --- Sky dome (follows the camera, drawn first, ignores depth/fog) ---
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uHorizon: { value: HORIZON.clone() },
        uZenith: { value: ZENITH.clone() },
        uMoonDir: { value: this.moonDir.clone() },
        uMoonTint: { value: MOON_TINT.clone() },
        uTime: this.timeU,
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    // --- Blowing sand: GPU-wrapped point cloud around the car ---
    const count = high ? 1100 : 500;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(seeds.slice(), 3)); // placeholder for count
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
    this.sandMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: this.timeU,
        uFocus: { value: new THREE.Vector3() },
        uWind: { value: WIND_DIR.clone().multiplyScalar(WIND_SPEED) },
        uBox: { value: 110 },
        uSize: { value: 28 * (opts.pixelRatio ?? 1) },
        uColor: { value: new THREE.Color(0.7, 0.62, 1.0) },
      },
      vertexShader: SAND_VERT,
      fragmentShader: SAND_FRAG,
    });
    this.sand = new THREE.Points(geo, this.sandMat);
    this.sand.frustumCulled = false;
    this.sand.renderOrder = 3;
    scene.add(this.sand);
  }

  /**
   * Add moving sand ripples, gust waves and moonlit glints to the terrain
   * material. Map only — call once, before the first render.
   */
  applyGroundWind(material: THREE.MeshStandardMaterial) {
    const timeU = this.timeU;
    const windDirU = this.windDirU;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.uniforms.uWindDir = windDirU;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWindWorld;")
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\nvWindWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${GROUND_WIND_HEAD}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${GROUND_WIND_BODY}`);
    };
    material.customProgramCacheKey = () => "ground-wind-v1";
    material.needsUpdate = true;
  }

  /** Call once per frame. `focus` = the car's (interpolated) position. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3) {
    this.timeU.value += dt;

    // The sky dome rides with the camera so it is always "infinitely far".
    this.sky.position.copy(camera.position);

    // Keep the moon's shadow frustum centred on the car on the big map.
    this.moonLight.target.position.copy(focus);
    this.moonLight.position.copy(focus).addScaledVector(this.moonDir, 70);

    this.sandMat.uniforms.uFocus.value.copy(focus);
  }

  dispose() {
    this.scene.remove(this.sky, this.sand, this.moonLight, this.moonLight.target);
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.sand.geometry.dispose();
    this.sandMat.dispose();
  }
}

// ----------------------------------------------------------------- shaders

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uMoonDir;
  uniform vec3 uMoonTint;
  uniform float uTime;
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // Gradient: horizon colour (= fog) up to a deep violet-black zenith.
    float t = pow(clamp(h, 0.0, 1.0), 0.5);
    vec3 col = mix(uHorizon, uZenith, t);

    // Stars (hash grid on the sphere), twinkling, only well above the horizon.
    vec3 sp = d * 160.0;
    vec3 id = floor(sp);
    vec3 fr = fract(sp) - 0.5;
    float rnd = hash13(id);
    float isStar = step(0.991, rnd);
    vec3 jitter = (vec3(hash13(id + 1.3), hash13(id + 2.7), hash13(id + 4.1)) - 0.5) * 0.6;
    float sd = length(fr - jitter);
    float star = isStar * smoothstep(0.2, 0.0, sd);
    float twinkle = 0.7 + 0.3 * sin(uTime * (1.5 + rnd * 6.0) + rnd * 60.0);
    col += vec3(0.8, 0.85, 1.0) * star * twinkle * 1.5 * smoothstep(0.03, 0.4, h);

    // Moon: soft violet glow + bright disc with faint maria. HDR values on
    // purpose — the bloom and god-ray passes pick them up.
    float c = clamp(dot(d, uMoonDir), -1.0, 1.0);
    float ang = acos(c);
    float cp = max(c, 0.0);
    col += uMoonTint * (pow(cp, 180.0) * 0.2 + pow(cp, 30.0) * 0.1);
    float disc = smoothstep(0.034, 0.030, ang);
    float maria = 0.78 + 0.22 * vnoise(d * 70.0);
    col = mix(col, uMoonTint * 2.0 * maria, disc);

    // Hide stars/moon below the horizon: fade to the fog colour.
    col = mix(uHorizon, col, smoothstep(-0.02, 0.01, h));

    // Tiny noise against banding in the dark gradient.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime) * 43758.5453);
    col += (n - 0.5) * 0.004;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const SAND_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFocus;
  uniform vec2 uWind;
  uniform float uBox;
  uniform float uSize;
  attribute vec3 aSeed;
  varying float vAlpha;

  void main() {
    // Each grain lives in a box around the car and wraps around it forever.
    vec2 local = aSeed.xz * uBox;
    float speed = 0.6 + aSeed.y * 0.8;
    local += uWind * uTime * speed;
    vec2 rel = mod(local - uFocus.xz + 0.5 * uBox, uBox) - 0.5 * uBox;
    vec3 world = vec3(uFocus.x + rel.x, 0.0, uFocus.z + rel.y);

    // Skim just above the car's altitude with a lazy wobble.
    world.y = uFocus.y - 1.0 + aSeed.y * 6.0 + sin(uTime * 0.7 + aSeed.x * 30.0) * 0.5;

    // Gusts travel along the wind as slow waves; grains fade near the box edge.
    vec2 wd = normalize(uWind);
    float gust = 0.5 + 0.5 * sin(dot(world.xz, wd) * 0.045 - uTime * 0.9);
    float edge = 1.0 - smoothstep(0.32 * uBox, 0.5 * uBox, length(rel));
    vAlpha = 0.2 * (0.2 + 0.8 * gust) * edge;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    gl_PointSize = clamp(uSize / max(-mv.z, 0.1), 1.0, 6.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SAND_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const GROUND_WIND_HEAD = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWindDir;
  varying vec3 vWindWorld;
  float windHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

const GROUND_WIND_BODY = /* glsl */ `
  {
    vec2 wp = vWindWorld.xz;
    vec2 wd = normalize(uWindDir);
    float along = dot(wp, wd);
    float across = dot(wp, vec2(-wd.y, wd.x));

    // Slow gust waves rolling along the wind + fine ripples across it,
    // warped so they never look like a perfect grid. Faded with distance to
    // avoid shimmer on the horizon.
    float near = 1.0 - smoothstep(60.0, 240.0, length(vViewPosition));
    float gust = sin(along * 0.035 - uTime * 0.9 + sin(across * 0.02) * 2.0);
    float warp = sin(across * 0.11 + along * 0.02) * 1.6 + sin(across * 0.37) * 0.4;
    float ripple = sin(along * 1.2 + warp - uTime * 0.35);
    float k = (0.045 * gust + 0.05 * ripple * (0.6 + 0.4 * gust)) * near;
    diffuseColor.rgb *= 1.0 + k;

    // Rare soft glints of moonlight on the sand.
    float h = windHash(floor(wp * 1.8));
    float glint = step(0.9965, h) * (0.5 + 0.5 * sin(uTime * 2.0 + h * 60.0));
    diffuseColor.rgb += vec3(0.5, 0.45, 0.9) * glint * 0.25 * near;
  }
`;
