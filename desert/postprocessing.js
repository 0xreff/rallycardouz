import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Runs AFTER OutputPass (tone mapping + sRGB), i.e. in display space, which is
// where lift/gamma/gain grading behaves intuitively.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.45 },
    uVignetteTint: { value: new THREE.Color(0.23, 0.08, 0.03) },
    uGrain: { value: 0.045 },
    uChromatic: { value: 0.0025 },
    uSaturation: { value: 0.92 },
    uContrast: { value: 1.05 },
    uWarmth: { value: 0.35 },
    uLift: { value: new THREE.Vector3() },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uShimmer: { value: 0.0018 },
    uShimmerY: { value: 0.5 },
    uShimmerWidth: { value: 0.05 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime; uniform vec2 uResolution;
    uniform float uVignette; uniform vec3 uVignetteTint;
    uniform float uGrain; uniform float uChromatic;
    uniform float uSaturation; uniform float uContrast; uniform float uWarmth;
    uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
    uniform float uShimmer; uniform float uShimmerY; uniform float uShimmerWidth;
    varying vec2 vUv;
    float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // heat shimmer, masked to a band around the projected horizon
      float band = exp(-pow((uv.y - uShimmerY) / max(uShimmerWidth, 1e-4), 2.0));
      vec2 sh = vec2(sin(uv.y * 220.0 + uTime * 3.1) + sin(uv.y * 97.0 - uTime * 2.3 + uv.x * 30.0),
                     cos(uv.x * 140.0 + uTime * 2.7)) * 0.5;
      uv += sh * uShimmer * band;
      // radial chromatic aberration
      vec2 dir = uv - 0.5;
      vec2 off = dir * uChromatic * length(dir) * 2.0;
      vec3 col = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
      // lift / gamma / gain
      col = clamp(col, 0.0, 1.0);
      col = uGain * (col + uLift * (1.0 - col));
      col = pow(max(col, 0.0), 1.0 / max(uGamma, vec3(0.01)));
      // white-balance tilt toward warm
      col *= vec3(1.0 + uWarmth * 0.1, 1.0, 1.0 - uWarmth * 0.12);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      // warm-tinted vignette
      vec2 vv = vUv - 0.5;
      vv.x *= uResolution.x / uResolution.y;
      float vig = 1.0 - uVignette * smoothstep(0.3, 0.95, length(vv));
      col *= mix(uVignetteTint, vec3(1.0), vig);
      // film grain, strongest in the midtones
      float n = gHash(vUv * uResolution + fract(uTime) * vec2(113.1, 71.7)) - 0.5;
      col += n * uGrain * (0.4 + 2.4 * l * (1.0 - l));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

/** RenderPass -> UnrealBloom (HDR, high threshold) -> OutputPass (ACES + sRGB) -> Grade. */
export class PostFX {
  constructor(renderer, scene, camera, config, preset) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.config = config;
    this.msaa = -1;
    this._dir = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this.setQuality(preset);
  }

  _build(msaa) {
    const time = this.grade ? this.grade.uniforms.uTime.value : 0;
    if (this.composer) {
      this.composer.dispose();
      this.bloom.dispose();
    }
    this.msaa = msaa;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const p = this.config.post;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), p.bloomStrength, p.bloomRadius, p.bloomThreshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uTime.value = time;
    this.composer.addPass(this.grade);
    this.setSize();
    this.sync(this.config);
  }

  setQuality(preset) {
    if (preset.msaa !== this.msaa) this._build(preset.msaa);
    this.bloom.enabled = preset.bloom;
    this.grade.enabled = preset.post; // when off, OutputPass renders to screen
  }

  setSize() {
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.grade.uniforms.uResolution.value.set(window.innerWidth * pr, window.innerHeight * pr);
  }

  sync(config) {
    const p = config.post, u = this.grade.uniforms;
    this.bloom.strength = p.bloomStrength;
    this.bloom.radius = p.bloomRadius;
    this.bloom.threshold = p.bloomThreshold;
    u.uVignette.value = p.vignette;
    u.uVignetteTint.value.set(p.vignetteTint).convertLinearToSRGB(); // display-space value
    u.uGrain.value = p.grain;
    u.uChromatic.value = p.chromatic;
    u.uSaturation.value = p.saturation;
    u.uContrast.value = p.contrast;
    u.uWarmth.value = p.warmth;
    u.uLift.value.set(p.lift.r, p.lift.g, p.lift.b);
    u.uGamma.value.set(p.gamma.r, p.gamma.g, p.gamma.b);
    u.uGain.value.set(p.gain.r, p.gain.g, p.gain.b);
    u.uShimmer.value = p.shimmer;
    u.uShimmerWidth.value = p.shimmerWidth;
  }

  update(dt, camera) {
    const u = this.grade.uniforms;
    u.uTime.value += dt;
    // Project a far point at eye height to find the horizon line on screen.
    camera.updateMatrixWorld();
    const d = camera.getWorldDirection(this._dir);
    d.y = 0;
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
    d.normalize();
    this._p.copy(camera.position).addScaledVector(d, 3000).project(camera);
    u.uShimmerY.value = this._p.y * 0.5 + 0.5;
  }

  render() {
    this.composer.render();
  }
}
