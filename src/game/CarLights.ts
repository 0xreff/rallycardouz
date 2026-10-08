import * as THREE from "three";
import type { CarSpec } from "./CarSpec";

/**
 * Night driving lights for a car, attached to its chassis group so they follow
 * the body (including the cosmetic lean).
 *
 *  - Headlight lenses and tail lights: emissive meshes whose colour is > 1.0 (HDR),
 *    so the bloom pass makes them glow.
 *  - Light beams: two cheap additive cones (fake volumetric light) — they only
 *    show up in dusty night air, which is exactly the look we want.
 *  - One REAL SpotLight (player only): every extra real light makes every material
 *    in the scene more expensive, which hurts on phones, so the bot gets the glow
 *    and the beams but no real light.
 *
 * +Z is the car's forward axis (same as the physics controller).
 * Tune HEAD / TAIL if the lights don't sit on a particular model's grille:
 * values are fractions of the spec's half extents, measured from the chassis centre.
 */
const HEAD = { x: 0.80, y: -0.37, z: 0.89 };
const TAIL = {
    x: 0.5, y: 0.40, z: -0.35
};

const HEAD_COLOR = new THREE.Color(1.0, 0.96, 0.85).multiplyScalar(0.7); // HDR → blooms
const TAIL_IDLE = new THREE.Color(1.0, 0.96, 0.85).multiplyScalar(0.1);
const TAIL_BRAKE = new THREE.Color(1.0, 0.96, 0.85).multiplyScalar(0.5);

const BEAM_LENGTH = 15;
const BEAM_RADIUS = 2.8;

export class CarLights {
    private readonly tailMat: THREE.MeshBasicMaterial;
    private brakeLevel = -1;

    constructor(parent: THREE.Object3D, spec: CarSpec, withSpotLight: boolean) {
        const hx = spec.halfWidth;
        const hy = spec.halfHeight;
        const hz = spec.halfLength;

        const lensGeo = new THREE.BoxGeometry(0.24, 0.12, 0.05);
        const headMat = new THREE.MeshBasicMaterial({ color: HEAD_COLOR });
        this.tailMat = new THREE.MeshBasicMaterial({ color: TAIL_IDLE.clone() });

        for (const side of [-1, 1]) {
            const head = new THREE.Mesh(lensGeo, headMat);
            head.position.set(side * hx * HEAD.x, hy * HEAD.y, hz * HEAD.z);
            parent.add(head);

            const tail = new THREE.Mesh(lensGeo, this.tailMat);
            tail.position.set(side * hx * TAIL.x, hy * TAIL.y, hz * TAIL.z);
            parent.add(tail);

            const beam = new THREE.Mesh(createBeamGeometry(), createBeamMaterial());
            beam.position.set(side * hx * HEAD.x, hy * HEAD.y, hz * HEAD.z + 0.05);
            beam.rotation.x = 0.07; // tilt slightly down onto the road
            beam.renderOrder = 2;
            parent.add(beam);
        }

        if (withSpotLight) {
            const spot = new THREE.SpotLight(0xdfe6ff, 600, 350, 0.72, 0.8, 2);
            spot.position.set(0, hy * HEAD.y, hz * HEAD.z);
            spot.castShadow = false;
            spot.target.position.set(0, -0.2, 28);
            parent.add(spot);
            parent.add(spot.target);
        }
    }

    /** 0..1 brake pressure → tail lights flare up. */
    setBrake(pressure: number) {
        const level = pressure > 0.15 ? 1 : 0;
        if (level === this.brakeLevel) return; // only touch the material on change
        this.brakeLevel = level;
        this.tailMat.color.copy(level ? TAIL_BRAKE : TAIL_IDLE);
    }
}

function createBeamGeometry(): THREE.BufferGeometry {
    // Open cone, apex at the origin, widening along +Z.
    const geo = new THREE.ConeGeometry(BEAM_RADIUS, BEAM_LENGTH, 20, 1, true);
    geo.translate(0, -BEAM_LENGTH / 2, 0); // apex at origin, base at y = -LENGTH
    geo.rotateX(-Math.PI / 2);             // y → +z
    return geo;
}

function createBeamMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uColor: { value: new THREE.Color(0.75, 0.82, 1.0) },
            uIntensity: { value: 0.16 },
            uLength: { value: BEAM_LENGTH },
        },
        vertexShader: /* glsl */ `
      uniform float uLength;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        vAlong = clamp(position.z / uLength, 0.0, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
        fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        // brightest near the lamp, fading to nothing at the far end; soft edges
        float along = pow(1.0 - vAlong, 1.6);
        float edge = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.4);
        float a = along * edge * uIntensity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    });
}
