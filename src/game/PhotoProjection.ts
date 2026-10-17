import * as THREE from "three";

/**
 * Paints a model's body from six photos (front, back, left, right, top, bottom) instead of
 * its own (scrambled) UV atlas. Each photo is projected straight onto the model through its
 * bounding box, and the six projections are blended by surface direction (triplanar).
 *
 * Put the six .webp files in public/assets/<folder>/ (front, back, left, right, top, bottom).
 * Every photo must be cropped TIGHT to the truck so its edges touch the model's bounding box.
 *
 * Model axes (glTF): +Z = front of the truck, +Y = up, +X = the truck's LEFT side.
 * If left and right come out swapped on your model, pass { swapSides: true }.
 */
export interface PhotoProjectionOptions {
  swapSides?: boolean;   // true if the photo "left" ended up on the truck's right side
  sharpness?: number;    // blend sharpness between projections (higher = harder seams), default 6
  brightness?: number;   // multiplies the photo colours (photos already contain baked light), default 1
  metalness?: number;    // default 0.3
  roughness?: number;    // default 0.5
}

const FACES = ["front", "back", "left", "right", "top", "bottom"] as const;

export function applyPhotoProjection(
  root: THREE.Object3D,
  model: THREE.Object3D,
  baseUrl: string,
  opts: PhotoProjectionOptions = {}
): void {
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // Bounding box of the whole truck in the root's own space (wheels, mirrors and cage included,
  // like the photos).
  const box = new THREE.Box3().setFromObject(model, true).applyMatrix4(rootInv);

  const loader = new THREE.TextureLoader();
  const tex: Record<string, THREE.Texture> = {};
  for (const f of FACES) {
    const t = loader.load(`${baseUrl}${f}.webp`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    tex[f] = t;
  }
  const swap = !!opts.swapSides;

  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const meshToRoot = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);

    for (const m of mats as THREE.MeshStandardMaterial[]) {
      if (!m.map) continue; // only the textured body, plain parts (tyres, trim) stay as they are

      // Drop everything that depended on the broken atlas UVs.
      m.map = null;
      m.normalMap = null;
      m.metalnessMap = null;
      m.roughnessMap = null;
      m.aoMap = null;
      m.color.set(0xffffff);
      m.metalness = opts.metalness ?? 0.3;
      m.roughness = opts.roughness ?? 0.5;

      const prev = m.onBeforeCompile; // keep the rim glow patch from RimMaterial
      m.onBeforeCompile = (shader, renderer) => {
        prev.call(m, shader, renderer);

        shader.uniforms.uMeshToRoot = { value: meshToRoot };
        shader.uniforms.uBoxMin = { value: box.min };
        shader.uniforms.uBoxMax = { value: box.max };
        shader.uniforms.uSharp = { value: opts.sharpness ?? 6 };
        shader.uniforms.uBright = { value: opts.brightness ?? 1 };
        shader.uniforms.uSwap = { value: swap ? 1 : 0 };
        shader.uniforms.uFront = { value: tex.front };
        shader.uniforms.uBack = { value: tex.back };
        shader.uniforms.uLeft = { value: tex.left };
        shader.uniforms.uRight = { value: tex.right };
        shader.uniforms.uTop = { value: tex.top };
        shader.uniforms.uBottom = { value: tex.bottom };

        shader.vertexShader = shader.vertexShader
          .replace(
            "void main() {",
            `uniform mat4 uMeshToRoot;
             varying vec3 vTpPos;
             varying vec3 vTpNrm;
             void main() {`
          )
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
             vTpPos = (uMeshToRoot * vec4(position, 1.0)).xyz;
             vTpNrm = mat3(uMeshToRoot) * normal;`
          );

        shader.fragmentShader = shader.fragmentShader
          .replace(
            "void main() {",
            `uniform vec3 uBoxMin;
             uniform vec3 uBoxMax;
             uniform float uSharp;
             uniform float uBright;
             uniform float uSwap;
             uniform sampler2D uFront;
             uniform sampler2D uBack;
             uniform sampler2D uLeft;
             uniform sampler2D uRight;
             uniform sampler2D uTop;
             uniform sampler2D uBottom;
             varying vec3 vTpPos;
             varying vec3 vTpNrm;
             void main() {`
          )
          .replace(
            "#include <map_fragment>",
            `{
               vec3 tp = clamp((vTpPos - uBoxMin) / max(uBoxMax - uBoxMin, vec3(1e-4)), 0.0, 1.0);
               vec3 n = normalize(vTpNrm);
               vec3 w = pow(abs(n), vec3(uSharp));
               w /= (w.x + w.y + w.z + 1e-5);

               // front (+Z) / back (-Z)
               vec3 cFront = texture2D(uFront, vec2(tp.x, tp.y)).rgb;
               vec3 cBack  = texture2D(uBack,  vec2(1.0 - tp.x, tp.y)).rgb;
               vec3 cZ = mix(cBack, cFront, step(0.0, n.z));

               // sides: +X is the truck's left, -X its right (uSwap flips this)
               vec3 cLeft  = texture2D(uLeft,  vec2(1.0 - tp.z, tp.y)).rgb;
               vec3 cRight = texture2D(uRight, vec2(tp.z, tp.y)).rgb;
               float plusX = mix(step(0.0, n.x), 1.0 - step(0.0, n.x), uSwap);
               vec3 cX = mix(cRight, cLeft, plusX);

               // top (+Y) / bottom (-Y)
               vec3 cTop    = texture2D(uTop,    vec2(tp.x, 1.0 - tp.z)).rgb;
               vec3 cBottom = texture2D(uBottom, vec2(tp.x, tp.z)).rgb;
               vec3 cY = mix(cBottom, cTop, step(0.0, n.y));

               diffuseColor.rgb *= (cX * w.x + cY * w.y + cZ * w.z) * uBright;
             }`
          );
      };
      m.customProgramCacheKey = () => "photoProjection";
      m.needsUpdate = true;
    }
  });

  if (import.meta.env.DEV) {
    const s = box.getSize(new THREE.Vector3());
    console.info(
      `[PhotoProjection] box ${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(2)} m from ${baseUrl}`
    );
  }
}
