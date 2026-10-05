import * as THREE from 'three';
import { createNoise2D, fbm2D, GLSL_NOISE } from './noise.js';
import { atmosphereUniforms, withAtmosphere } from './atmosphere.js';

// Sand: ripples are computed per pixel (no geometry), in world space, aligned
// to the wind, faded out with distance (they alias and add nothing far away).
const SAND_PARS = /* glsl */ `
varying vec3 vSandWorldPos;
varying vec3 vSandWorldNormal;
uniform vec3 uSandColor;
uniform vec3 uSandShadow;
uniform vec3 uSandCrest;
uniform vec2 uWindDir;
uniform float uRippleScale;
uniform float uRippleStrength;
uniform float uRippleStretch;
uniform float uRippleFade;
uniform float uRippleDetail;
uniform float uSparkle;
uniform float uSandRim;
uniform float uSandVariation;
${GLSL_NOISE}
float rippleLayer(vec2 p, vec2 w, float freq, float stretch, float seed) {
  vec2 perp = vec2(-w.y, w.x);
  float along = dot(p, w) * freq;
  float across = dot(p, perp) * freq / stretch;
  float warp = vnoise(vec2(along, across) * 0.12 + seed) * 2.2
             + vnoise(vec2(along, across) * 0.45 + seed * 1.7) * 0.6;
  float ph = along * 6.2831853 + warp * 3.14159;
  // asymmetric profile: gentle windward slope, steeper lee
  return sin(ph + 0.6 * sin(ph)) * 0.5 + 0.5;
}
float sandRipples(vec2 p, float detail) {
  float patchy = smoothstep(0.2, 0.8, vnoise(p * 0.03 + 3.7));
  float h = rippleLayer(p, uWindDir, uRippleScale, uRippleStretch, 0.0) * mix(0.3, 1.0, patchy);
  if (detail > 0.01) {
    vec2 w2 = normalize(uWindDir + vec2(-uWindDir.y, uWindDir.x) * 0.22);
    h += rippleLayer(p, w2, uRippleScale * 2.6, uRippleStretch * 0.6, 11.3) * 0.32 * detail;
  }
  return h;
}
`;

const SAND_MAIN = /* glsl */ `
{
  vec3 sWp = vSandWorldPos;
  vec3 sN = normalize(vSandWorldNormal);
  vec3 sToCam = cameraPosition - sWp;
  float sDist = length(sToCam);
  vec3 sV = sToCam / max(sDist, 1e-4);
  vec3 sL = normalize(uSunDir);
  float sAmt = (1.0 - smoothstep(uRippleFade * 0.15, uRippleFade, sDist)) * smoothstep(0.6, 0.92, sN.y);
  float sRh = 0.5;
  vec3 sNr = sN;
  if (sAmt > 0.001) {
    float sDetail = uRippleDetail * (1.0 - smoothstep(15.0, 70.0, sDist));
    float e = 0.05 / uRippleScale;
    float h0 = sandRipples(sWp.xz, sDetail);
    float hx = sandRipples(sWp.xz + vec2(e, 0.0), sDetail);
    float hz = sandRipples(sWp.xz + vec2(0.0, e), sDetail);
    vec2 g = vec2(hx - h0, hz - h0) / e;
    sNr = normalize(sN - vec3(g.x, 0.0, g.y) * (uRippleStrength * 0.06 * sAmt));
    sRh = mix(0.5, h0 / (1.0 + 0.32 * uRippleDetail), sAmt);
  }
  // albedo: large-scale variation, darker/redder lee faces, pale crests, dark troughs
  float sLee = smoothstep(0.0, 0.3, dot(sN.xz, uWindDir)) * smoothstep(0.03, 0.22, 1.0 - sN.y);
  float sVar = vnoise(sWp.xz * 0.011) * 0.65 + vnoise(sWp.xz * 0.047 + 9.1) * 0.35;
  vec3 sCol = uSandColor * (1.0 + (sVar - 0.5) * 2.0 * uSandVariation);
  sCol = mix(sCol, uSandShadow, sLee * 0.6);
  sCol = mix(sCol * vec3(0.84, 0.76, 0.72), mix(sCol, uSandCrest, 0.3), smoothstep(0.15, 0.95, sRh));
  diffuseColor.rgb = sCol;
  normal = normalize((viewMatrix * vec4(sNr, 0.0)).xyz);
  // sparkle: sparse grains with random facets catching the sun
  vec3 sRnd = nHash32(floor(sWp.xz * 26.0));
  float sGlint = step(0.93, sRnd.x) * (1.0 - smoothstep(6.0, 40.0, sDist));
  if (sGlint > 0.0) {
    vec3 sGn = normalize(sNr + (sRnd - 0.5) * 0.8);
    float spec = pow(max(dot(sGn, normalize(sL + sV)), 0.0), 500.0);
    totalEmissiveRadiance += uSunColor * spec * uSparkle * 12.0;
  }
  // grazing backlit sheen on sun-facing crests
  float sFres = pow(1.0 - clamp(dot(sNr, sV), 0.0, 1.0), 4.0);
  float sBack = pow(max(dot(-sV, sL), 0.0), 3.0);
  float sFacing = smoothstep(-0.05, 0.3, dot(sNr, sL));
  totalEmissiveRadiance += uSunColor * sCol * sFres * sBack * sFacing * uSandRim * 1.5;
}
`;

export class Terrain {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.noise = createNoise2D(config.terrain.seed);
    this.heightSource = null; // optional (x, z) => y, see setHeightSource()
    const w = THREE.MathUtils.degToRad(config.wind.direction);
    this._wc = Math.cos(w);
    this._ws = Math.sin(w);

    this.uniforms = {
      uSandColor: { value: new THREE.Color() },
      uSandShadow: { value: new THREE.Color() },
      uSandCrest: { value: new THREE.Color() },
      uWindDir: atmosphereUniforms.uWindDir,
      uRippleScale: { value: 1 },
      uRippleStrength: { value: 0.6 },
      uRippleStretch: { value: 3.5 },
      uRippleFade: { value: 260 },
      uRippleDetail: { value: 1 },
      uSparkle: { value: 0.6 },
      uSandRim: { value: 0.55 },
      uSandVariation: { value: 0.12 },
    };
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0 });
    withAtmosphere(this.material, 'sand', (shader) => this._patch(shader));
    this.mesh = null;
    this.sync(config);
  }

  _patch(shader) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSandWorldPos;\nvarying vec3 vSandWorldNormal;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vSandWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSandWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SAND_PARS)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SAND_MAIN);
  }

  /** Large dunes: domain-warped fbm, elongated across the wind, plus ridged crests. */
  heightAt(x, z) {
    if (this.heightSource) return this.heightSource(x, z);
    const t = this.config.terrain, n = this.noise, s = t.duneScale;
    const wx = fbm2D(n, x * s * 0.5 + 31.7, z * s * 0.5 - 12.9, 3);
    const wz = fbm2D(n, x * s * 0.5 - 8.3, z * s * 0.5 + 44.1, 3);
    const px = x * s + wx * t.warp, pz = z * s + wz * t.warp;
    const along = px * this._wc + pz * this._ws;
    const across = -px * this._ws + pz * this._wc;
    const big = fbm2D(n, along, across * 0.45, 4);
    const ridge = 1 - Math.abs(n(along * 1.7 + 5.1, across * 0.6 - 2.3));
    let h = (big * 0.75 + (ridge * ridge - 0.5) * 0.6) * t.duneHeight;
    h += fbm2D(n, x * 0.013 + 3.3, z * 0.013 - 7.7, 2) * t.rollHeight;
    const r = Math.hypot(x, z);
    const calm = 0.2 + 0.8 * THREE.MathUtils.smoothstep(r, t.flattenRadius * 0.3, t.flattenRadius * 2.5);
    return h * calm;
  }

  /** Swap in any height function, e.g. heightSamplerFromImage(...), then rebuild. */
  setHeightSource(fn, segments) {
    this.heightSource = fn;
    this.build(segments ?? this.segments);
  }

  /** Non-uniform grid: ~2 m cells near the play area, coarse at the hazy edges. */
  build(segments) {
    this.segments = segments;
    const size = this.config.terrain.size, half = size / 2, a = 0.1;
    const warpAxis = (u) => Math.sign(u) * (a * Math.abs(u) + (1 - a) * Math.abs(u) ** 3);
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = warpAxis(pos.getX(i) / half) * half;
      const z = warpAxis(pos.getZ(i) / half) * half;
      pos.setXYZ(i, x, this.heightAt(x, z), z);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
    } else {
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.receiveShadow = true;
      this.mesh.castShadow = true; // dunes self-shadow: long low-sun shadows
      this.scene.add(this.mesh);
    }
  }

  sync(config) {
    const u = this.uniforms, s = config.sand;
    u.uSandColor.value.set(config.palette.sand);
    u.uSandShadow.value.set(config.palette.sandShadow);
    u.uSandCrest.value.set(config.palette.sandCrest);
    u.uRippleScale.value = s.rippleScale;
    u.uRippleStrength.value = s.rippleStrength;
    u.uRippleStretch.value = s.rippleStretch;
    u.uRippleFade.value = s.rippleFadeDistance;
    u.uSparkle.value = s.sparkle;
    u.uSandRim.value = s.rim;
    u.uSandVariation.value = s.variation;
  }
}

/** Height sampler from a greyscale image (red channel), centred on the origin. */
export function heightSamplerFromImage(image, worldSize, minHeight, maxHeight) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data, width: w, height: h } = ctx.getImageData(0, 0, c.width, c.height);
  const at = (ix, iy) => data[(iy * w + ix) * 4] / 255;
  return (x, z) => {
    const u = THREE.MathUtils.clamp(x / worldSize + 0.5, 0, 1) * (w - 1);
    const v = THREE.MathUtils.clamp(z / worldSize + 0.5, 0, 1) * (h - 1);
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = u - x0, fy = v - y0;
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bot = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    return minHeight + (top * (1 - fy) + bot * fy) * (maxHeight - minHeight);
  };
}
