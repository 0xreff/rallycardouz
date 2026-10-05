import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D, mulberry32, GLSL_NOISE } from './noise.js';
import { withAtmosphere } from './atmosphere.js';

// Sandstone: strata bands by WORLD height (layers line up across formations),
// vertical varnish streaks, sand at the base and on flat tops, backlit rim.
const ROCK_VERT_PARS = 'varying vec3 vRockWorld;\nvarying vec3 vRockNormalW;\nvarying float vRockLocalY;';
const ROCK_VERT_MAIN = /* glsl */ `
  vec4 rockW = vec4(transformed, 1.0);
  vec3 rockN = objectNormal;
  #ifdef USE_INSTANCING
    mat3 rockM = mat3(instanceMatrix);
    rockW = instanceMatrix * rockW;
    rockN = rockM * (rockN / vec3(dot(rockM[0], rockM[0]), dot(rockM[1], rockM[1]), dot(rockM[2], rockM[2])));
  #endif
  rockW = modelMatrix * rockW;
  vRockWorld = rockW.xyz;
  vRockNormalW = normalize(mat3(modelMatrix) * rockN);
  vRockLocalY = position.y;
`;
const ROCK_FRAG_PARS = /* glsl */ `
varying vec3 vRockWorld;
varying vec3 vRockNormalW;
varying float vRockLocalY;
uniform vec3 uRockDark;
uniform vec3 uRockLight;
uniform vec3 uRockSand;
uniform float uStrataScale;
uniform float uStrataContrast;
uniform float uStreaks;
uniform float uRockRim;
${GLSL_NOISE}
`;
const ROCK_FRAG_COLOR = /* glsl */ `
{
  float ry = vRockWorld.y;
  float s = ry * uStrataScale + vnoise(vRockWorld.xz * 0.015) * 1.8;
  float f = fract(s);
  float tone = nHash11(floor(s) + 3.0);
  float ledge = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.82, 0.9, f));
  vec3 rc = mix(uRockDark, uRockLight, clamp(tone * 0.75 + (1.0 - ledge) * 0.35 * uStrataContrast, 0.0, 1.0));
  float streak = vnoise(vec2((vRockWorld.x - vRockWorld.z) * 0.45, ry * 0.02));
  streak = mix(streak, vnoise(vec2((vRockWorld.x + vRockWorld.z) * 1.3, ry * 0.05)), 0.4);
  rc *= mix(1.0 - 0.4 * uStreaks, 1.0, streak);
  vec3 rn = normalize(vRockNormalW);
  float sandy = max(1.0 - smoothstep(0.0, 0.07, vRockLocalY), smoothstep(0.8, 0.97, rn.y) * 0.6);
  rc = mix(rc, uRockSand, sandy);
  diffuseColor.rgb *= rc;
}
`;
const ROCK_FRAG_RIM = /* glsl */ `
{
  vec3 rV = normalize(cameraPosition - vRockWorld);
  vec3 rn = normalize(vRockNormalW);
  float fres = pow(1.0 - clamp(dot(rn, rV), 0.0, 1.0), 3.0);
  float back = pow(max(dot(-rV, uSunDir), 0.0), 4.0);
  totalEmissiveRadiance += uSunColor * diffuseColor.rgb * fres * back * uRockRim;
}
`;

// Displace along the normal: vertical grooves (x/z only), lumps and strata ledges.
function erode(geo, noise, o) {
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  const p = geo.attributes.position, n = geo.attributes.normal, sx = o.seed * 13.7;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const grooves = noise(x * o.groove + sx, z * o.groove) * 0.65 + noise(x * o.groove * 2.3 - sx, z * o.groove * 2.3 + 4.1) * 0.35;
    const lump = noise(x * 1.4 + y * 1.1 + sx, z * 1.4 - y * 0.8);
    const s = y * o.strata + noise(x * 0.8, z * 0.8) * 0.6;
    const ledge = Math.pow(s - Math.floor(s), 3);
    const d = o.amount * (grooves * 0.6 + lump * 0.4) + o.ledge * (ledge - 0.5);
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d * 0.5, z + n.getZ(i) * d);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function buildGeometries(noise) {
  const lathe = (pts, seg) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  return {
    mesa: erode(new THREE.CylinderGeometry(1.0, 1.25, 1, 32, 20).translate(0, 0.5, 0), noise, { groove: 6, strata: 7, amount: 0.07, ledge: 0.05, seed: 1 }),
    butte: erode(new THREE.CylinderGeometry(0.55, 0.9, 1, 26, 24).translate(0, 0.5, 0), noise, { groove: 8, strata: 9, amount: 0.09, ledge: 0.06, seed: 2 }),
    hoodoo: erode(lathe([[0.45, 0], [0.4, 0.12], [0.3, 0.3], [0.24, 0.45], [0.2, 0.6], [0.22, 0.68], [0.36, 0.74], [0.42, 0.8], [0.36, 0.88], [0.18, 0.93], [0, 0.95]], 22), noise, { groove: 10, strata: 14, amount: 0.12, ledge: 0.08, seed: 3 }),
    arch: erode(new THREE.TorusGeometry(1, 0.3, 14, 40, Math.PI).scale(1, 1.1, 1.6).translate(0, -0.08, 0).scale(0.7, 0.7, 0.7), noise, { groove: 5, strata: 8, amount: 0.09, ledge: 0.03, seed: 4 }),
  };
}

// Width/height multipliers per shape, and three distance rings.
const SHAPE = { mesa: { w: 1.5, h: 0.75 }, butte: { w: 1, h: 1.15 }, hoodoo: { w: 0.35, h: 0.55 }, arch: { w: 0.7, h: 0.65 } };
const RINGS = [
  { key: 'near', min: 140, max: 650, size: [16, 45], height: [12, 38], shadows: true, bias: 0.4, weights: { mesa: 0.15, butte: 0.3, hoodoo: 0.4, arch: 0.15 } },
  { key: 'mid', min: 650, max: 1500, size: [45, 130], height: [35, 110], shadows: false, bias: 1, weights: { mesa: 0.4, butte: 0.35, hoodoo: 0.15, arch: 0.1 } },
  { key: 'far', min: 1500, max: 2700, size: [110, 340], height: [80, 240], shadows: false, bias: 1, weights: { mesa: 0.6, butte: 0.35, hoodoo: 0.05, arch: 0 } },
];

export class Rocks {
  constructor(scene, terrain, config) {
    this.uniforms = {
      uRockDark: { value: new THREE.Color() },
      uRockLight: { value: new THREE.Color() },
      uRockSand: { value: new THREE.Color() },
      uStrataScale: { value: 0.11 },
      uStrataContrast: { value: 1 },
      uStreaks: { value: 0.55 },
      uRockRim: { value: 0.9 },
    };
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    withAtmosphere(this.material, 'rock', (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + ROCK_VERT_PARS)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + ROCK_VERT_MAIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + ROCK_FRAG_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + ROCK_FRAG_COLOR)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + ROCK_FRAG_RIM);
    });

    const rand = mulberry32(config.rocks.seed);
    const geos = buildGeometries(createNoise2D(config.rocks.seed + 101));
    const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
    const lerp = (r) => r[0] + (r[1] - r[0]) * rand();
    const sunAz = THREE.MathUtils.degToRad(config.sun.azimuth);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    this.meshes = [];

    for (const ring of RINGS) {
      const total = config.rocks[ring.key];
      for (const type of Object.keys(geos)) {
        const count = Math.round(total * ring.weights[type]);
        if (count === 0) continue;
        const mesh = new THREE.InstancedMesh(geos[type], this.material, count);
        for (let i = 0; i < count; i++) {
          // Bias placement toward the sun so formations silhouette against the glow.
          const ang = rand() < config.rocks.sunBias * ring.bias ? sunAz + gauss() * 0.75 : rand() * Math.PI * 2;
          const dist = ring.min + (ring.max - ring.min) * Math.sqrt(rand());
          const x = Math.sin(ang) * dist, z = Math.cos(ang) * dist;
          const base = lerp(ring.size), sh = SHAPE[type];
          s.set(base * sh.w * (0.8 + rand() * 0.45), lerp(ring.height) * sh.h, base * sh.w * (0.8 + rand() * 0.45));
          // Bury the base at the lowest point of the footprint.
          const fr = Math.max(s.x, s.z) * 1.1;
          let y = terrain.heightAt(x, z);
          y = Math.min(y, terrain.heightAt(x + fr, z), terrain.heightAt(x - fr, z), terrain.heightAt(x, z + fr), terrain.heightAt(x, z - fr));
          p.set(x, y - s.y * 0.06, z);
          q.setFromEuler(e.set(gauss() * 0.03, rand() * Math.PI * 2, gauss() * 0.03));
          mesh.setMatrixAt(i, m.compose(p, q, s));
          const b = 0.85 + rand() * 0.25;
          mesh.setColorAt(i, c.setRGB(b, b * (0.95 + rand() * 0.07), b * (0.9 + rand() * 0.1)));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = ring.shadows;
        mesh.receiveShadow = ring.shadows;
        scene.add(mesh);
        this.meshes.push(mesh);
      }
    }
    this.sync(config);
  }

  sync(config) {
    const u = this.uniforms, r = config.rocks;
    u.uRockDark.value.set(config.palette.rockDark);
    u.uRockLight.value.set(config.palette.rockLight);
    u.uRockSand.value.set(config.palette.rockSand);
    u.uStrataScale.value = r.strataScale;
    u.uStrataContrast.value = r.strataContrast;
    u.uStreaks.value = r.streaks;
    u.uRockRim.value = r.rim;
  }
}
