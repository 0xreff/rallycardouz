import * as THREE from "three";

/**
 * Desert atmosphere with two themes ("night" and "desert-day"): sky (gradient, stars/moon
 * or hazy sun), matching fog, key light with shadows, blowing sand and sand ripples on
 * the ground.
 *
 * Everything that moves is animated on the GPU from a single `time` uniform, so
 * the per-frame CPU cost is a handful of uniform writes.
 *
 * The same lights, fog and sky light the MAP and the CAR together — nothing here
 * needs to be applied per object, except `applyGroundWind()` (map only).
 */

export type Quality = "high" | "low";
/** "night" = the original violet moonlit desert. "desert-day" = hazy amber daytime desert. */
export type Theme = "night" | "desert-day";

// --- Tuning -----------------------------------------------------------------
// The key light is the MOON at night and the SUN by day (the property is still called
// `moonDir` / `moonLight` so the rest of the game does not need to change).
// Every effect (sky, fog, god rays, blowing sand, ground ripples, glints) reads its look
// from the theme below, so both themes share one code path.

interface ThemeDef {
  keyDir: THREE.Vector3;       // direction towards the moon / sun
  horizon: THREE.Color;        // sky at the horizon AND the fog colour (seamless)
  zenith: THREE.Color;
  keyTint: THREE.Color;        // colour of the moon / sun disc and its glow
  keyLight: THREE.Color;
  keyIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogNear: number;
  fogFar: number;
  stars: number;               // 0..1 star brightness (night only)
  glow: number;                // size/strength of the haze glow around the key light
  discSize: number;            // angular radius of the sun / moon disc (rad)
  discGain: number;            // HDR brightness of the disc (bloom + god rays pick it up)
  haze: number;                // 0..1 dusty horizon band + high dust streaks (day)
  sandColor: THREE.Color;
  sandAlpha: number;
  sandAdditive: boolean;       // night grains glow (additive); day dust is a tan veil (normal)
  sandSize: number;
  sandMaxPx: number;
  sandCount: number;
  glintColor: THREE.Color;
  glintGain: number;
  rippleGain: number;
  shadowNormalBias: number;
}

const THEMES: Record<Theme, ThemeDef> = {
  night: {
    keyDir: new THREE.Vector3(0.3, 0.36, 0.88).normalize(),
    horizon: new THREE.Color(0x251a4a),
    zenith: new THREE.Color(0x05050f),
    keyTint: new THREE.Color(0.85, 0.82, 1.0),
    keyLight: new THREE.Color(0xb4a8ff),
    keyIntensity: 0.6,
    hemiSky: new THREE.Color(0x6a5cc8),
    hemiGround: new THREE.Color(0x1b1535),
    hemiIntensity: 0.85,
    fogNear: 220,
    fogFar: 1300,
    stars: 1,
    glow: 1,
    discSize: 0.032,
    discGain: 2.0,
    haze: 0,
    sandColor: new THREE.Color(0.7, 0.62, 1.0),
    sandAlpha: 0.2,
    sandAdditive: true,
    sandSize: 28,
    sandMaxPx: 6,
    sandCount: 1,
    glintColor: new THREE.Color(0.5, 0.45, 0.9),
    glintGain: 0.25,
    rippleGain: 1,
    shadowNormalBias: 0,
  },
  // Low amber sun, orange dust-choked haze, long warm shadows (Arrakis-style).
  // Sun is ~20 deg above the horizon, up and to the RIGHT of the spawn heading (+Z, where
  // screen-right is world -X). Raise keyDir.y for a higher, whiter noon sun.
  "desert-day": {
    keyDir: new THREE.Vector3(-0.45, 0.34, 0.83).normalize(),
    horizon: new THREE.Color(0xe39a5a),
    zenith: new THREE.Color(0x7d7f88),
    keyTint: new THREE.Color(1.0, 0.9, 0.7),
    keyLight: new THREE.Color(0xffd3a0),
    keyIntensity: 5.4,
    hemiSky: new THREE.Color(0xd9a47a),
    hemiGround: new THREE.Color(0x7a3a1c),
    hemiIntensity: 1.5,
    fogNear: 70,
    fogFar: 820,
    stars: 0,
    glow: 1,
    discSize: 0.05,
    discGain: 6.0,
    haze: 1,
    sandColor: new THREE.Color(0.93, 0.66, 0.4),
    sandAlpha: 0.32,
    sandAdditive: false,
    sandSize: 70,
    sandMaxPx: 22,
    sandCount: 1.7,
    glintColor: new THREE.Color(1.0, 0.8, 0.5),
    glintGain: 0.55,
    rippleGain: 1.8,
    shadowNormalBias: 0.55,
  },
};

const WIND_DIR = new THREE.Vector2(1, 0.35).normalize();
const WIND_SPEED = 7; // m/s, blowing sand

export interface NightOptions {
  quality?: Quality;
  pixelRatio?: number;
  theme?: Theme;
}

export class NightAtmosphere {
  /** Direction towards the key light (moon at night, sun by day). */
  readonly moonDir: THREE.Vector3;
  readonly moonLight: THREE.DirectionalLight;
  readonly quality: Quality;
  readonly theme: Theme;

  private readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly sand: THREE.Points;
  private readonly sandMat: THREE.ShaderMaterial;
  private readonly timeU = { value: 0 };
  private readonly windDirU = { value: WIND_DIR.clone() };
  private readonly def: ThemeDef;

  constructor(private readonly scene: THREE.Scene, opts: NightOptions = {}) {
    this.quality = opts.quality ?? "high";
    this.theme = opts.theme ?? "night";
    const T = THEMES[this.theme];
    this.def = T;
    this.moonDir = T.keyDir.clone();
    const high = this.quality === "high";

    scene.background = T.horizon.clone();
    scene.fog = new THREE.Fog(T.horizon.getHex(), T.fogNear, T.fogFar);

    // --- Key light (moon / sun, with shadows following the car) ---
    const key = new THREE.DirectionalLight(T.keyLight, T.keyIntensity);
    key.castShadow = true;
    const shadowSize = high ? 2048 : 1024;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    key.shadow.camera.near = 10;
    key.shadow.camera.far = this.theme === "night" ? 140 : 240; // a low sun throws long shadows
    const s = 80;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = this.theme === "night" ? -0.0004 : -0.0007;
    key.shadow.normalBias = T.shadowNormalBias; // stops acne on gentle dune slopes under a low sun
    key.position.copy(this.moonDir).multiplyScalar(this.shadowDist());
    scene.add(key);
    scene.add(key.target);
    this.moonLight = key;

    // Sky fill from above, warm bounce from the ground.
    scene.add(new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemiIntensity));

    // --- Sky dome (follows the camera, drawn first, ignores depth/fog) ---
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uHorizon: { value: T.horizon.clone() },
        uZenith: { value: T.zenith.clone() },
        uMoonDir: { value: this.moonDir.clone() },
        uMoonTint: { value: T.keyTint.clone() },
        uStars: { value: T.stars },
        uGlow: { value: T.glow },
        uDiscSize: { value: T.discSize },
        uDiscGain: { value: T.discGain },
        uHaze: { value: T.haze },
        uDay: { value: this.theme === "night" ? 0 : 1 },
        uTime: this.timeU,
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    // --- Blowing sand / dust: GPU-wrapped point cloud around the car ---
    const count = Math.round((high ? 1100 : 500) * T.sandCount);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(seeds.slice(), 3)); // placeholder for count
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
    this.sandMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: T.sandAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
      uniforms: {
        uTime: this.timeU,
        uFocus: { value: new THREE.Vector3() },
        uWind: { value: WIND_DIR.clone().multiplyScalar(WIND_SPEED) },
        uBox: { value: 110 },
        uSize: { value: T.sandSize * (opts.pixelRatio ?? 1) },
        uMaxPx: { value: T.sandMaxPx * (opts.pixelRatio ?? 1) },
        uAlpha: { value: T.sandAlpha },
        uColor: { value: T.sandColor.clone() },
      },
      vertexShader: SAND_VERT,
      fragmentShader: SAND_FRAG,
    });
    this.sand = new THREE.Points(geo, this.sandMat);
    this.sand.frustumCulled = false;
    this.sand.renderOrder = 3;
    scene.add(this.sand);
  }

  /** Distance of the shadow light from the car along the key direction. */
  private shadowDist() {
    return this.theme === "night" ? 70 : 110;
  }

  /**
   * Add moving sand ripples, gust waves and glints (moonlit or sun-glittered) to the
   * terrain material. Map only — call once, before the first render.
   */
  applyGroundWind(material: THREE.MeshStandardMaterial) {
    const timeU = this.timeU;
    const windDirU = this.windDirU;
    const glintColorU = { value: this.def.glintColor.clone() };
    const glintGainU = { value: this.def.glintGain };
    const rippleGainU = { value: this.def.rippleGain };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.uniforms.uWindDir = windDirU;
      shader.uniforms.uGlintColor = glintColorU;
      shader.uniforms.uGlintGain = glintGainU;
      shader.uniforms.uRippleGain = rippleGainU;
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
    material.customProgramCacheKey = () => `ground-wind-v2-${this.theme}`;
    material.needsUpdate = true;
  }

  /** Call once per frame. `focus` = the car's (interpolated) position. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3) {
    this.timeU.value += dt;

    // The sky dome rides with the camera so it is always "infinitely far".
    this.sky.position.copy(camera.position);

    // Keep the key light's shadow frustum centred on the car on the big map.
    this.moonLight.target.position.copy(focus);
    this.moonLight.position.copy(focus).addScaledVector(this.moonDir, this.shadowDist());

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
  uniform float uStars;
  uniform float uGlow;
  uniform float uDiscSize;
  uniform float uDiscGain;
  uniform float uHaze;
  uniform float uDay;
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

    // Gradient: horizon colour (= fog) up to the zenith colour.
    // By day the horizon stays warm much higher up (a thick band of suspended dust).
    float t = pow(clamp(h, 0.0, 1.0), mix(0.5, 0.72, uDay));
    vec3 col = mix(uHorizon, uZenith, t);

    // Stars (hash grid on the sphere), twinkling, only well above the horizon.
    if (uStars > 0.001) {
      vec3 sp = d * 160.0;
      vec3 id = floor(sp);
      vec3 fr = fract(sp) - 0.5;
      float rnd = hash13(id);
      float isStar = step(0.991, rnd);
      vec3 jitter = (vec3(hash13(id + 1.3), hash13(id + 2.7), hash13(id + 4.1)) - 0.5) * 0.6;
      float sd = length(fr - jitter);
      float star = isStar * smoothstep(0.2, 0.0, sd);
      float twinkle = 0.7 + 0.3 * sin(uTime * (1.5 + rnd * 6.0) + rnd * 60.0);
      col += vec3(0.8, 0.85, 1.0) * star * twinkle * 1.5 * uStars * smoothstep(0.03, 0.4, h);
    }

    // Daytime dust: a brighter horizon band and slow high streaks of suspended sand.
    if (uHaze > 0.001) {
      float band = 1.0 - smoothstep(0.0, 0.22, h);
      col += uHorizon * band * 0.35 * uHaze;
      float streak = vnoise(vec3(d.x * 2.2 + uTime * 0.004, h * 16.0, d.z * 2.2));
      streak = smoothstep(0.45, 0.9, streak) * smoothstep(0.02, 0.2, h) * (1.0 - smoothstep(0.45, 0.8, h));
      col = mix(col, uHorizon * 1.15, streak * 0.28 * uHaze);
    }

    // Key light (moon / sun). HDR values on purpose — the bloom and god-ray passes pick
    // them up. By day this is a big hazy sun: wide amber glow + hot white-yellow disc.
    float c = clamp(dot(d, uMoonDir), -1.0, 1.0);
    float ang = acos(c);
    float cp = max(c, 0.0);
    vec3 glowCol = uMoonTint * uGlow;
    col += glowCol * (pow(cp, 180.0) * 0.2 + pow(cp, 30.0) * 0.1);
    col += uDay * uMoonTint * (pow(cp, 6.0) * 0.28 + pow(cp, 60.0) * 0.5 + pow(cp, 600.0) * 1.2);
    float disc = smoothstep(uDiscSize * 1.06, uDiscSize * 0.94, ang);
    float maria = mix(0.78 + 0.22 * vnoise(d * 70.0), 1.0, uDay);
    col = mix(col, uMoonTint * uDiscGain * maria, disc);

    // Hide the key light below the horizon: fade to the fog colour.
    col = mix(uHorizon, col, smoothstep(-0.02, 0.01, h));

    // Tiny noise against banding in the gradient.
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
  uniform float uMaxPx;
  uniform float uAlpha;
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
    vAlpha = uAlpha * (0.2 + 0.8 * gust) * edge;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    gl_PointSize = clamp(uSize / max(-mv.z, 0.1), 1.0, uMaxPx);
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
  uniform vec3 uGlintColor;
  uniform float uGlintGain;
  uniform float uRippleGain;
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
    float k = (0.045 * gust + 0.05 * ripple * (0.6 + 0.4 * gust)) * near * uRippleGain;
    diffuseColor.rgb *= 1.0 + k;

    // Rare soft glints (moonlit at night, sun-glittering grains by day).
    float h = windHash(floor(wp * 1.8));
    float glint = step(0.9965, h) * (0.5 + 0.5 * sin(uTime * 2.0 + h * 60.0));
    diffuseColor.rgb += uGlintColor * glint * uGlintGain * near;
  }
`;
