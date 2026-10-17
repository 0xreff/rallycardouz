import { Physics } from "./physics/Physics";
import { Game } from "./game/Game";

// Dev-only control panels (LightsPanel = L, AudioPanel = M). Their files are gitignored: they are
// used when present and skipped otherwise, so a checkout without them still builds and runs.
const optionalPanels = import.meta.glob<{
  LightsPanel?: new () => unknown;
  AudioPanel?: new () => unknown;
}>(["./game/LightsPanel.ts", "./game/AudioPanel.ts"], { eager: true });

async function boot() {
  const container = document.getElementById("app")!;
  const loader = document.getElementById("loader")!;

  try {
    const physics = await Physics.create();
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