import { Physics } from "./physics/Physics";
import { Game } from "./game/Game";

// Dev-only control panels (LightsPanel = L, AudioPanel = M). Their files are gitignored: they are
// used when present and skipped otherwise, so a checkout without them still builds and runs.
const optionalPanels = import.meta.glob<{
  LightsPanel?: new () => unknown;
  AudioPanel?: new () => unknown;
}>(["./game/LightsPanel.ts", "./game/AudioPanel.ts"], { eager: true });

/**
 * Preload all car models and audio files into the browser cache.
 * This runs in parallel with physics init so the assets are ready when the game starts.
 * The fetched responses are discarded — the real loaders (GLTFLoader, AudioContext.decodeAudioData)
 * will hit the warm cache and return instantly.
 */
async function preloadAssets(): Promise<void> {
  const base = import.meta.env.BASE_URL;

  // --- 1. GLB models ---
  const models = ["toyota.glb", "toyota6.glb", "toyota-24.glb"];
  const modelFetches = models.map((m) =>
    fetch(`${base}assets/${m}`).catch(() => {})
  );

  // --- 2. Audio manifests + all audio files from every engine sound set ---
  const audioBase = `${base}assets/audio/engine/`;
  const engineSets = ["toyota", "toyota6"]; // all engine sound folders

  // Fetch the root manifest and per-set manifests
  const manifestFetches: Promise<void>[] = [
    fetch(`${audioBase}manifest.json`).catch(() => {}),
  ];

  for (const set of engineSets) {
    const setBase = `${audioBase}${set}/`;
    manifestFetches.push(
      fetch(`${setBase}manifest.json`)
        .then(async (res) => {
          if (!res.ok) return;
          const manifest = await res.json();
          const audioFiles: string[] = [];

          // Collect all engine loop files (on/off per RPM point)
          if (manifest.points) {
            for (const p of manifest.points) {
              if (p.on) audioFiles.push(p.on);
              if (p.off) audioFiles.push(p.off);
            }
          }
          // Collect limiter
          if (manifest.limiter) audioFiles.push(manifest.limiter);
          // Collect one-shot files (pops, bovs, land, wind)
          if (manifest.oneShots) {
            for (const file of Object.values(manifest.oneShots)) {
              audioFiles.push(file as string);
            }
          }
          // Fetch all audio files in parallel (warm the cache)
          await Promise.all(
            audioFiles.map((f) => fetch(`${setBase}${f}`).catch(() => {}))
          );
        })
        .catch(() => {})
    );
  }

  // Also prefetch the root manifest's audio files (paths are relative to audioBase)
  manifestFetches.push(
    fetch(`${audioBase}manifest.json`)
      .then(async (res) => {
        if (!res.ok) return;
        const manifest = await res.json();
        const audioFiles: string[] = [];
        if (manifest.points) {
          for (const p of manifest.points) {
            if (p.on) audioFiles.push(p.on);
            if (p.off) audioFiles.push(p.off);
          }
        }
        if (manifest.limiter) audioFiles.push(manifest.limiter);
        if (manifest.oneShots) {
          for (const file of Object.values(manifest.oneShots)) {
            audioFiles.push(file as string);
          }
        }
        await Promise.all(
          audioFiles.map((f) => fetch(`${audioBase}${f}`).catch(() => {}))
        );
      })
      .catch(() => {})
  );

  await Promise.all([...modelFetches, ...manifestFetches]);
  console.info("[Preload] All models and audio cached.");
}

async function boot() {
  const container = document.getElementById("app")!;
  const loader = document.getElementById("loader")!;

  try {
    // Start preloading assets in parallel with physics initialization
    const [physics] = await Promise.all([Physics.create(), preloadAssets()]);
    const game = new Game(physics, container);
    game.start();
    const LightsPanelCls = optionalPanels["./game/LightsPanel.ts"]?.LightsPanel;
    const AudioPanelCls = optionalPanels["./game/AudioPanel.ts"]?.AudioPanel;
    if (LightsPanelCls) new LightsPanelCls(); // press L: edit the vehicle lights, Save to apply
    if (AudioPanelCls) new AudioPanelCls(); // press M: edit audio volumes and loudness
    // Fade out the loading overlay.
    loader.style.opacity = "0";
    setTimeout(() => loader.remove(), 600);
  } catch (err) {
    console.error(err);
    loader.querySelector(".sub")!.textContent = "Failed to start — see console.";
  }
}

boot();