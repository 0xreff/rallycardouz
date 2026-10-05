import * as THREE from 'three';
import { atmosphereUniforms, ATMOSPHERE_GLSL } from './atmosphere.js';

// Custom gradient sky: warm haze at the horizon (identical to the fog colour),
// muted zenith, broad Henyey-Greenstein glow, tight core halo and an HDR sun
// disc that the bloom picks up. Drawn first, behind everything.
export class Sky {
  constructor(scene) {
    this.uniforms = {
      ...atmosphereUniforms,
      uZenith: { value: new THREE.Color() },
      uHorizonBlend: { value: 0.32 },
      uSkyCurve: { value: 0.7 },
      uSunCosOuter: { value: 0.9999 },
      uSunCosInner: { value: 0.99995 },
      uDiscIntensity: { value: 40 },
      uCoreGlow: { value: 2.5 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform float uHorizonBlend;
        uniform float uSkyCurve;
        uniform float uSunCosOuter;
        uniform float uSunCosInner;
        uniform float uDiscIntensity;
        uniform float uCoreGlow;
        varying vec3 vDir;
        ${ATMOSPHERE_GLSL}
        void main() {
          vec3 dir = normalize(vDir);
          float h = max(dir.y, 0.0);
          float mu = dot(dir, uSunDir);
          float t = pow(smoothstep(0.0, uHorizonBlend, h), uSkyCurve);
          vec3 col = mix(atmoHaze(dir), uZenith, t) + atmoGlow(mu);
          col += uSunScatterColor * pow(max(mu, 0.0), 900.0) * uCoreGlow;
          float disc = smoothstep(uSunCosOuter, uSunCosInner, mu);
          col = mix(col, uSunColor * uDiscIntensity + vec3(uDiscIntensity * 0.25), disc);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
    this.mesh.scale.setScalar(5000);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(camera) {
    this.mesh.position.copy(camera.position);
  }

  sync(config) {
    const u = this.uniforms;
    u.uZenith.value.set(config.sky.zenith);
    u.uHorizonBlend.value = config.sky.horizonBlend;
    u.uSkyCurve.value = config.sky.curve;
    u.uCoreGlow.value = config.sky.coreGlow;
    u.uDiscIntensity.value = config.sun.discIntensity;
    const r = THREE.MathUtils.degToRad(config.sun.discSize * 0.5);
    u.uSunCosOuter.value = Math.cos(r);
    u.uSunCosInner.value = Math.cos(r * 0.7);
  }
}
