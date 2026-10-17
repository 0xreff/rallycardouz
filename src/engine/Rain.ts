import * as THREE from "three";

/**
 * GPU rain: one LineSegments object, every streak animated in the vertex shader around the
 * car (same trick as the blowing sand), so the CPU cost per frame is a few uniform writes.
 * The amount (0..1) only changes the draw range, so light rain also costs less GPU.
 */
export class Rain {
    private readonly max: number;
    private readonly geo = new THREE.BufferGeometry();
    private readonly mat: THREE.ShaderMaterial;
    readonly object: THREE.LineSegments;
    private time = 0;

    constructor(scene: THREE.Scene, quality: "high" | "low") {
        this.max = quality === "high" ? 3200 : 1400;
        const n = this.max;
        const pos = new Float32Array(n * 6);               // 2 vertices per streak (unused: shader places them)
        const seed = new Float32Array(n * 8);              // vec4 per vertex, same seed for both ends
        const end = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
            const s = [Math.random(), Math.random(), Math.random(), Math.random()];
            for (let k = 0; k < 2; k++) {
                seed.set(s, (i * 2 + k) * 4);
                end[i * 2 + k] = k;
            }
        }
        this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        this.geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
        this.geo.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
        this.geo.setDrawRange(0, 0);
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uFocus: { value: new THREE.Vector3() },
                uWind: { value: new THREE.Vector3(3, 0, 1) },   // horizontal drift of the drops (m/s)
                uBox: { value: 46 },
                uHeight: { value: 28 },
                uLen: { value: 1.1 },
                uAlpha: { value: 0.5 },
                uColor: { value: new THREE.Color(0.75, 0.82, 0.95) },
            },
            vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uFocus; uniform vec3 uWind;
        uniform float uBox; uniform float uHeight; uniform float uLen; uniform float uAlpha;
        attribute vec4 aSeed; attribute float aEnd;
        varying float vA;
        void main() {
          float speed = 20.0 + aSeed.w * 9.0;
          vec3 vel = vec3(uWind.x, -speed, uWind.z);
          vec3 p = vec3(aSeed.x * uBox, aSeed.y * uHeight, aSeed.z * uBox) + vel * uTime;
          vec2 rel = vec2(mod(p.x - uFocus.x + 0.5 * uBox, uBox) - 0.5 * uBox,
                          mod(p.z - uFocus.z + 0.5 * uBox, uBox) - 0.5 * uBox);
          float y = mod(p.y, uHeight);
          vec3 world = vec3(uFocus.x + rel.x, uFocus.y - 2.0 + y, uFocus.z + rel.y);
          world -= normalize(vel) * uLen * aEnd;       // the tail trails behind the head
          float edge = 1.0 - smoothstep(0.35 * uBox, 0.5 * uBox, length(rel));
          vA = uAlpha * edge * (0.45 + 0.55 * aSeed.w) * (1.0 - 0.75 * aEnd);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
            fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA;
        void main() { if (vA < 0.004) discard; gl_FragColor = vec4(uColor, vA); }`,
        });
        this.object = new THREE.LineSegments(this.geo, this.mat);
        this.object.frustumCulled = false;
        this.object.renderOrder = 4;
        this.object.visible = false;
        scene.add(this.object);
    }

    /** 0 = off, 1 = downpour. */
    setAmount(a: number) {
        const k = Math.max(0, Math.min(1, a));
        this.object.visible = k > 0.01;
        this.geo.setDrawRange(0, Math.round(this.max * k) * 2);
        this.mat.uniforms.uAlpha.value = 0.28 + 0.4 * k;
    }

    setColor(c: THREE.Color) {
        (this.mat.uniforms.uColor.value as THREE.Color).copy(c);
    }

    /** Horizontal drift of the drops in m/s (slants the streaks). */
    setWind(x: number, z: number) {
        (this.mat.uniforms.uWind.value as THREE.Vector3).set(x, 0, z);
    }

    update(dt: number, focus: THREE.Vector3) {
        if (!this.object.visible) return;
        this.time += dt;
        this.mat.uniforms.uTime.value = this.time;
        (this.mat.uniforms.uFocus.value as THREE.Vector3).copy(focus);
    }

    dispose() {
        this.object.removeFromParent();
        this.geo.dispose();
        this.mat.dispose();
    }
}