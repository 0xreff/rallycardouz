import * as THREE from 'three';

// Uniforms shared by EVERY shader in the scene (sky, sand, rocks, dust, haze).
// They are the same {value} objects everywhere, so one update propagates.
export const atmosphereUniforms = {
  uSunDir: { value: new THREE.Vector3(0, 0.25, -1).normalize() },
  uSunColor: { value: new THREE.Color() },
  uFogColor: { value: new THREE.Color() },
  uSunScatterColor: { value: new THREE.Color() },
  uFogDensity: { value: 0.001 },
  uFogHeightFalloff: { value: 0.02 },
  uFogBaseHeight: { value: 0 },
  uSunScatterPower: { value: 6 },
  uSunScatterStrength: { value: 0.8 },
  uSunGlow: { value: 0.35 },
  uMieG: { value: 0.78 },
  // Not declared in ATMOSPHERE_GLSL; shaders that need them declare them.
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(1, 0) },
  uWindSpeed: { value: 3 },
};

// Fog + in-scattering. The sky uses atmoHaze/atmoGlow at the horizon, and the
// fog fades geometry toward exactly the same colour, so there is no seam.
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform vec3 uSunScatterColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogBaseHeight;
uniform float uSunScatterPower;
uniform float uSunScatterStrength;
uniform float uSunGlow;
uniform float uMieG;

float atmoHG(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
vec3 atmoHaze(vec3 viewDir) {
  float s = pow(max(dot(viewDir, uSunDir), 0.0), uSunScatterPower) * uSunScatterStrength;
  return mix(uFogColor, uSunScatterColor, clamp(s, 0.0, 1.0));
}
vec3 atmoGlow(float mu) {
  return uSunScatterColor * atmoHG(mu, uMieG) * uSunGlow;
}
float atmoFogAmount(vec3 worldPos) {
  vec3 ray = worldPos - cameraPosition;
  float dist = length(ray);
  float k = max(uFogHeightFalloff, 1e-5);
  float h0 = cameraPosition.y - uFogBaseHeight;
  float dy = ray.y;
  // average of exp(-k*h) along the ray (analytic): denser near the ground
  float hf = exp(-k * h0);
  if (abs(dy) > 0.01) hf = (exp(-k * h0) - exp(-k * (h0 + dy))) / (k * dy);
  hf = clamp(hf, 0.0, 8.0);
  float d = uFogDensity * dist;
  return 1.0 - exp(-d * d * hf);
}
vec3 applyAtmosphere(vec3 col, vec3 worldPos) {
  vec3 viewDir = normalize(worldPos - cameraPosition);
  vec3 inscatter = atmoHaze(viewDir) + atmoGlow(dot(viewDir, uSunDir));
  return mix(col, inscatter, atmoFogAmount(worldPos));
}
`;

export function sunDirectionFromAngles(elevationDeg, azimuthDeg, out) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return out.setFromSphericalCoords(1, phi, theta);
}

export function syncAtmosphere(config) {
  const u = atmosphereUniforms;
  sunDirectionFromAngles(config.sun.elevation, config.sun.azimuth, u.uSunDir.value);
  u.uSunColor.value.set(config.sun.color);
  u.uFogColor.value.set(config.fog.color);
  u.uSunScatterColor.value.set(config.fog.sunColor);
  u.uFogDensity.value = config.fog.density;
  u.uFogHeightFalloff.value = config.fog.heightFalloff;
  u.uFogBaseHeight.value = config.fog.baseHeight;
  u.uSunScatterPower.value = config.fog.sunPower;
  u.uSunScatterStrength.value = config.fog.sunStrength;
  u.uSunGlow.value = config.sky.glow;
  u.uMieG.value = config.sky.mieG;
  const a = THREE.MathUtils.degToRad(config.wind.direction);
  u.uWindDir.value.set(Math.cos(a), Math.sin(a));
  u.uWindSpeed.value = config.wind.speed;
}

/** Replace three's built-in fog chunks with our atmosphere (works with instancing). */
export function patchAtmosphere(shader) {
  for (const key in atmosphereUniforms) shader.uniforms[key] = atmosphereUniforms[key];
  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>', 'varying vec3 vAtmoWorldPos;')
    .replace('#include <fog_vertex>', `
      vec4 atmoWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        atmoWorld = instanceMatrix * atmoWorld;
      #endif
      atmoWorld = modelMatrix * atmoWorld;
      vAtmoWorldPos = atmoWorld.xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', 'varying vec3 vAtmoWorldPos;\n' + ATMOSPHERE_GLSL)
    .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vAtmoWorldPos);');
}

/** Patch a built-in material: optional extra patch first, then the atmosphere. */
export function withAtmosphere(material, cacheKey, extraPatch) {
  material.onBeforeCompile = (shader) => {
    if (extraPatch) extraPatch(shader);
    patchAtmosphere(shader);
  };
  // Distinct key per patch type, otherwise three may reuse the wrong program.
  material.customProgramCacheKey = () => `atmo-${cacheKey}`;
  return material;
}
