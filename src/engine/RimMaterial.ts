import * as THREE from "three";

/**
 * PBR material with the project's signature rim/edge glow injected into the
 * fragment shader. Ported from the reference build's model_fs.glsl, where a
 * cool blue-white highlight (vec3(0.45, 0.60, 1.0)) is mixed in at grazing
 * angles. We drive it from the view-space normal so it works with Three's
 * standard lighting and post-processing (bloom picks up the rim nicely).
 */
export interface RimOptions {
  color?: THREE.ColorRepresentation;
  metalness?: number;
  roughness?: number;
  rimColor?: THREE.Color;
  rimStrength?: number; // matches the 0.32 mix factor from the reference
  rimPower?: number;    // edge falloff sharpness
}

export function createRimMaterial(opts: RimOptions = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    metalness: opts.metalness ?? 0.35,
    roughness: opts.roughness ?? 0.55,
  });

  const rimColor = opts.rimColor ?? new THREE.Color(0.45, 0.6, 1.0);
  const rimStrength = opts.rimStrength ?? 0.32;
  const rimPower = opts.rimPower ?? 2.4;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: rimStrength };
    shader.uniforms.uRimPower = { value: rimPower };

    // Pass the view-space normal & position through to the fragment shader.
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vRimViewNormal;
         varying vec3 vRimViewPos;`
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
         vRimViewNormal = normalize(normalMatrix * normal);
         vRimViewPos = (modelViewMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform vec3 uRimColor;
         uniform float uRimStrength;
         uniform float uRimPower;
         varying vec3 vRimViewNormal;
         varying vec3 vRimViewPos;`
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
         vec3 viewDir = normalize(-vRimViewPos);
         float rim = 1.0 - max(dot(viewDir, normalize(vRimViewNormal)), 0.0);
         rim = pow(clamp(rim, 0.0, 1.0), uRimPower);
         gl_FragColor.rgb = mix(gl_FragColor.rgb, uRimColor, rim * uRimStrength);`
      );
  };

  return mat;
}
