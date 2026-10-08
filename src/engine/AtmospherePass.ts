import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import type { Quality, Theme } from "./NightAtmosphere";

/**
 * One full-screen pass that does two things, in linear HDR before tone mapping:
 *
 *  1. GOD RAYS (high quality only): a radial blur of the bright parts of the frame
 *     towards the moon's / sun's screen position. Hills, the car and anything dark in front
 *     of the moon naturally block the rays, so no depth/occlusion pass is needed.
 *     Placed after bloom, so it samples the moon's bloom halo (a large, easy target).
 *  2. COLOUR GRADE: split-toning (night: violet shadows / cool highlights; desert-day:
 *     warm rust shadows / golden highlights plus a lifted, dusty black point),
 *     a touch more saturation, and a soft vignette.
 *
 * Place it after UnrealBloomPass and before OutputPass.
 */

const RAY_SAMPLES = 20;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const frag = (rays: boolean) => /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uMoonUV;
  uniform float uMoonVis;
  uniform float uRayStrength;
  uniform float uRayThreshold;
  uniform vec3 uRayColor;
  uniform vec3 uShadowTint;
  uniform vec3 uHighTint;
  uniform float uSaturation;
  uniform float uVignette;
  uniform vec3 uLift;
  uniform float uRayWidth;
  varying vec2 vUv;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  ${rays ? /* glsl */ `
  float ign(vec2 p) { // interleaved gradient noise (cheap, no banding)
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
  vec3 godRays(vec2 uv) {
    vec2 delta = (uMoonUV - uv) * (0.92 / float(${RAY_SAMPLES}));
    vec2 p = uv + delta * ign(gl_FragCoord.xy); // jittered start
    vec3 acc = vec3(0.0);
    float decay = 1.0;
    for (int i = 0; i < ${RAY_SAMPLES}; i++) {
      p += delta;
      vec3 s = texture2D(tDiffuse, p).rgb;
      float l = dot(s, LUMA);
      acc += s * (smoothstep(uRayThreshold, uRayThreshold + uRayWidth, l) / max(l, 1e-4)) * l * decay;
      decay *= 0.94;
    }
    return acc / float(${RAY_SAMPLES});
  }` : ""}

  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;

    ${rays ? /* glsl */ `
    if (uMoonVis > 0.001) {
      float toMoon = length(uMoonUV - vUv);
      float falloff = 1.0 - smoothstep(0.2, 1.4, toMoon);   // strongest near the moon
      c += godRays(vUv) * uRayColor * uRayStrength * uMoonVis * falloff;
    }` : ""}

    // Violet split-toning: tint the darks, cool the lights.
    float l = dot(c, LUMA);
    float shadow = 1.0 - smoothstep(0.0, 0.6, l);
    float high = smoothstep(0.3, 1.5, l);
    c = mix(c, c * uShadowTint, shadow);
    c = mix(c, c * uHighTint, high);
    c = mix(vec3(dot(c, LUMA)), c, uSaturation);

    // Dusty air: lift the black point towards the haze colour (zero at night).
    c += uLift * (1.0 - clamp(dot(c, LUMA), 0.0, 1.0));

    // Soft vignette.
    vec2 q = vUv - 0.5;
    c *= 1.0 - uVignette * smoothstep(0.28, 0.9, length(q) * 1.25);

    gl_FragColor = vec4(c, 1.0);
  }
`;

export class AtmospherePass extends ShaderPass {
    private readonly _v = new THREE.Vector3();
    private readonly _q = new THREE.Quaternion();

    constructor(private readonly moonDir: THREE.Vector3, quality: Quality, theme: Theme = "night") {
        const rays = quality === "high";
        const day = theme === "desert-day";
        super({
            uniforms: {
                tDiffuse: { value: null },
                uMoonUV: { value: new THREE.Vector2(0.5, 0.5) },
                uMoonVis: { value: 0 },
                // Day: the sun is far brighter than the hazy sky, so the threshold sits higher
                // (otherwise the whole bright horizon would throw rays) and the rays are warm.
                uRayStrength: { value: day ? 0.75 : 0.55 },
                uRayThreshold: { value: day ? 1.7 : 0.8 },
                uRayWidth: { value: day ? 1.6 : 0.8 },
                uRayColor: { value: day ? new THREE.Color(1.0, 0.7, 0.38) : new THREE.Color(0.62, 0.55, 1.0) },
                uShadowTint: { value: day ? new THREE.Color(1.06, 0.88, 0.8) : new THREE.Color(1.1, 0.9, 1.3) },
                uHighTint: { value: day ? new THREE.Color(1.07, 1.0, 0.88) : new THREE.Color(1.0, 1.0, 1.06) },
                uSaturation: { value: day ? 1.14 : 1.08 },
                uVignette: { value: day ? 0.3 : 0.35 },
                uLift: { value: day ? new THREE.Color(0.045, 0.024, 0.012) : new THREE.Color(0, 0, 0) },
            },
            vertexShader: VERT,
            fragmentShader: frag(rays),
        });
    }

    /** Call every frame (after the camera has moved) to track the moon on screen. */
    updateCamera(camera: THREE.PerspectiveCamera) {
        // Moon direction in view space (the camera looks down its -Z axis).
        this._q.copy(camera.quaternion).invert();
        const v = this._v.copy(this.moonDir).applyQuaternion(this._q);
        const w = -v.z;
        const u = this.uniforms;
        if (w <= 0.02) {
            u.uMoonVis.value = 0; // moon is behind the camera
            return;
        }
        const e = camera.projectionMatrix.elements;
        const ndcX = (v.x * e[0]) / w;
        const ndcY = (v.y * e[5]) / w;
        u.uMoonUV.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
        // fade out as the moon leaves the screen, and as it swings behind the view
        const offscreen = Math.max(Math.abs(ndcX), Math.abs(ndcY));
        u.uMoonVis.value = (1 - THREE.MathUtils.smoothstep(offscreen, 1.0, 1.7)) * THREE.MathUtils.smoothstep(w, 0.02, 0.3);
    }
}
