import GUI from "lil-gui";
import * as THREE from "three";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import type { Pass } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Performance debug panel (press P). Lets you switch the expensive parts of the
 * renderer on/off at runtime so you can see which one costs the most GPU time.
 * Watch the stats-gl box (FPS / CPU / GPU) while you flip the toggles.
 *
 * Note: toggling lights, shadows or the shadow filter makes three.js recompile
 * shaders once, so ignore the first second after a change when comparing.
 */
export interface PerfTargets {
    renderer: THREE.WebGLRenderer;
    composer: EffectComposer;
    scene: THREE.Scene;
    sun: THREE.DirectionalLight;
    bloom: Pass;
    atmosphere: Pass; // god rays + colour grade
    smaa: Pass;
    flags?: { cullFarTerrain: boolean }; // read by Game each frame
}

export class PerfPanel {
    private readonly gui: GUI;
    private readonly timer: number;
    private visible = true;

    private readonly state = {
        pixelRatio: 1,
        bloom: true,
        atmosphere: true,
        smaa: true,
        shadows: true,
        shadowMapSize: 2048,
        shadowFilter: "PCFSoft",
        realLights: true,
    };

    private readonly readout = {
        drawCalls: "-",
        triangles: "-",
        geometries: "-",
        textures: "-",
        lights: "-",
        renderSize: "-",
    };

    // Snapshot of the last full frame (all composer passes included).
    private frameCalls = 0;
    private frameTris = 0;

    constructor(private readonly t: PerfTargets) {
        const { renderer, sun } = t;

        // renderer.info normally resets on every render() call, and the composer
        // renders once per pass. Reset manually once per frame instead (endFrame()).
        renderer.info.autoReset = false;

        this.state.pixelRatio = renderer.getPixelRatio();
        this.state.bloom = t.bloom.enabled;
        this.state.atmosphere = t.atmosphere.enabled;
        this.state.smaa = t.smaa.enabled;
        this.state.shadows = sun.castShadow;
        this.state.shadowMapSize = sun.shadow.mapSize.x;
        this.state.shadowFilter = renderer.shadowMap.type === THREE.PCFShadowMap ? "PCF" : "PCFSoft";

        const gui = new GUI({ title: "Performance (P)" });
        this.gui = gui;
        gui.domElement.style.cssText += ";position:fixed;left:8px;top:110px;z-index:40;";
        // Typing or using arrows inside the panel must not steer the car.
        gui.domElement.addEventListener("keydown", (e) => e.stopPropagation());
        gui.domElement.addEventListener("keyup", (e) => e.stopPropagation());
        gui.domElement.addEventListener("focusin", () => window.dispatchEvent(new Event("blur")));

        const render = gui.addFolder("Rendering");
        render.add(this.state, "pixelRatio", 0.5, Math.max(2, this.state.pixelRatio), 0.25)
            .name("Pixel ratio").onChange((v: number) => this.applyPixelRatio(v));
        render.add(this.state, "bloom").name("Bloom").onChange((v: boolean) => this.applyBloom(v));
        render.add(this.state, "atmosphere").name("God rays + grade").onChange((v: boolean) => this.applyAtmosphere(v));
        render.add(this.state, "smaa").name("SMAA").onChange((v: boolean) => this.applySmaa(v));
        if (t.flags) render.add(t.flags, "cullFarTerrain").name("Cull far terrain");

        const light = gui.addFolder("Lights & shadows");
        light.add(this.state, "shadows").name("Sun shadows").onChange((v: boolean) => this.applyShadows(v));
        light.add(this.state, "shadowMapSize", [512, 1024, 2048]).name("Shadow map")
            .onChange((v: number) => this.applyShadowMapSize(Number(v)));
        light.add(this.state, "shadowFilter", ["PCFSoft", "PCF"]).name("Shadow filter")
            .onChange((v: string) => this.applyShadowFilter(v));
        light.add(this.state, "realLights").name("Spot/point lights").onChange((v: boolean) => this.applyRealLights(v));

        const presets = gui.addFolder("Presets");
        presets.add({ run: () => this.setAll(true) }, "run").name("Everything ON");
        presets.add({ run: () => this.setAll(false) }, "run").name("Everything OFF (baseline)");

        const info = gui.addFolder("Frame info");
        const row = (key: keyof typeof this.readout, label: string) =>
            info.add(this.readout, key).name(label).disable();
        row("renderSize", "Render size");
        row("drawCalls", "Draw calls");
        row("triangles", "Triangles");
        row("geometries", "Geometries");
        row("textures", "Textures");
        row("lights", "Lights (on/total)");

        gui.add({ log: () => this.logBreakdown() }, "log").name("Log scene breakdown (console)");
        gui.add({ copy: () => this.copyReport() }, "copy").name("Copy report to clipboard");

        window.addEventListener("keydown", (e) => {
            if (e.key.toLowerCase() !== "p" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target as HTMLElement | null)?.tagName ?? "";
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            this.toggle();
        });

        this.timer = window.setInterval(() => this.refresh(), 500);
        this.refresh();
    }

    /** Call once per frame, right after composer.render(). */
    endFrame() {
        const info = this.t.renderer.info;
        this.frameCalls = info.render.calls;
        this.frameTris = info.render.triangles;
        info.reset();
    }

    toggle() {
        this.visible = !this.visible;
        this.gui.show(this.visible);
    }

    dispose() {
        window.clearInterval(this.timer);
        this.gui.destroy();
    }

    // --- appliers -------------------------------------------------------------

    private applyPixelRatio(v: number) {
        this.t.renderer.setPixelRatio(v);
        this.t.composer.setPixelRatio(v); // resizes every pass (incl. SMAA) consistently
    }
    private applyBloom(v: boolean) { this.t.bloom.enabled = v; }
    private applyAtmosphere(v: boolean) { this.t.atmosphere.enabled = v; }
    private applySmaa(v: boolean) { this.t.smaa.enabled = v; }
    private applyShadows(v: boolean) { this.t.sun.castShadow = v; }

    private applyShadowMapSize(n: number) {
        const sh = this.t.sun.shadow;
        sh.mapSize.set(n, n);
        sh.map?.dispose();
        sh.map = null; // three recreates it at the new size on the next frame
    }

    private applyShadowFilter(v: string) {
        this.t.renderer.shadowMap.type = v === "PCF" ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
        this.t.scene.traverse((o) => {
            const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
            if (!mat) return;
            if (Array.isArray(mat)) mat.forEach((m) => (m.needsUpdate = true));
            else mat.needsUpdate = true;
        });
    }

    private applyRealLights(v: boolean) {
        this.forEachDynamicLight((l) => (l.visible = v));
    }

    private forEachDynamicLight(fn: (l: THREE.Light) => void) {
        this.t.scene.traverse((o) => {
            if (o instanceof THREE.SpotLight || o instanceof THREE.PointLight) fn(o);
        });
    }

    /** Flip every toggle at once (pixel ratio and shadow map size are left alone). */
    private setAll(on: boolean) {
        this.state.bloom = on;
        this.state.atmosphere = on;
        this.state.smaa = on;
        this.state.shadows = on;
        this.state.realLights = on;
        this.applyBloom(on);
        this.applyAtmosphere(on);
        this.applySmaa(on);
        this.applyShadows(on);
        this.applyRealLights(on);
        this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }

    // --- readout --------------------------------------------------------------

    private refresh() {
        const { renderer, scene } = this.t;

        // A car swap spawns fresh lights; keep them off if the toggle is off.
        if (!this.state.realLights) this.forEachDynamicLight((l) => (l.visible = false));

        let total = 0;
        let active = 0;
        scene.traverse((o) => {
            if ((o as THREE.Light).isLight) {
                total++;
                if (o.visible) active++;
            }
        });

        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        this.readout.renderSize = `${size.x} x ${size.y}`;
        this.readout.drawCalls = String(this.frameCalls);
        this.readout.triangles = this.frameTris.toLocaleString();
        this.readout.geometries = String(renderer.info.memory.geometries);
        this.readout.textures = String(renderer.info.memory.textures);
        this.readout.lights = `${active}/${total}`;
        this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }

    /** Print where the triangles and texture memory live (open the browser console, F12). */
    private logBreakdown() {
        type MeshRow = { name: string; triangles: number; castShadow: boolean; material: string };
        const meshes: MeshRow[] = [];
        const byRoot = new Map<string, { meshes: number; triangles: number }>();
        const textures = new Set<THREE.Texture>();
        const slots = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"];

        const triCount = (m: THREE.Mesh): number => {
            const g = m.geometry as THREE.BufferGeometry;
            const n = g.index ? g.index.count : g.getAttribute("position")?.count ?? 0;
            const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
            return Math.round(n / 3) * inst;
        };

        this.t.scene.children.forEach((child) => {
            let count = 0;
            let tris = 0;
            child.traverse((o) => {
                const m = o as THREE.Mesh;
                if (!m.isMesh) return;
                const t = triCount(m);
                count++;
                tris += t;
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                meshes.push({ name: m.name || child.name || child.type, triangles: t, castShadow: m.castShadow, material: mats[0]?.type ?? "?" });
                for (const mat of mats) {
                    const rec = mat as unknown as Record<string, THREE.Texture | null | undefined>;
                    for (const slot of slots) if (rec[slot]) textures.add(rec[slot] as THREE.Texture);
                }
            });
            if (count) {
                const key = child.name || child.type;
                const e = byRoot.get(key) ?? { meshes: 0, triangles: 0 };
                e.meshes += count;
                e.triangles += tris;
                byRoot.set(key, e);
            }
        });

        let totalMB = 0;
        const texRows = [...textures].map((tex) => {
            const img = tex.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined;
            const w = img?.width ?? img?.naturalWidth ?? 0;
            const h = img?.height ?? img?.naturalHeight ?? 0;
            const mb = (w * h * 4 * (tex.generateMipmaps ? 1.33 : 1)) / (1024 * 1024);
            totalMB += mb;
            return { name: tex.name || tex.uuid.slice(0, 8), size: `${w}x${h}`, estMB: Math.round(mb * 10) / 10 };
        });

        console.group("[PerfPanel] scene breakdown");
        console.log("Top-level scene objects (meshes / triangles):");
        console.table(Object.fromEntries([...byRoot.entries()].sort((a, b) => b[1].triangles - a[1].triangles)));
        console.log("Heaviest 15 meshes:");
        console.table(meshes.sort((a, b) => b.triangles - a.triangles).slice(0, 15));
        console.log("Largest 10 textures (uncompressed estimate, incl. mipmaps):");
        console.table(texRows.sort((a, b) => b.estMB - a.estMB).slice(0, 10));
        console.log(`Unique material textures: ${textures.size}, est. total ${totalMB.toFixed(0)} MB`);
        console.groupEnd();
    }

    private copyReport() {
        const report = JSON.stringify(
            {
                settings: this.state,
                frame: this.readout,
                window: `${window.innerWidth}x${window.innerHeight}`,
                devicePixelRatio: window.devicePixelRatio,
                note: "Add the FPS / CPU / GPU numbers from the stats-gl box here",
            },
            null,
            2
        );
        console.log("[PerfPanel] report\n" + report);
        navigator.clipboard?.writeText(report).catch(() => { /* clipboard blocked: see console */ });
    }
}