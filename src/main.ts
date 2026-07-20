import { Physics } from "./physics/Physics";
import { Game } from "./game/Game";
import { injectSpeedInsights } from "@vercel/speed-insights";

async function boot() {
  // Initialize Vercel Speed Insights
  injectSpeedInsights();
  const container = document.getElementById("app")!;
  const loader = document.getElementById("loader")!;

  try {
    const physics = await Physics.create();
    const game = new Game(physics, container);
    game.start();

    // Fade out the loading overlay.
    loader.style.opacity = "0";
    setTimeout(() => loader.remove(), 600);
  } catch (err) {
    console.error(err);
    loader.querySelector(".sub")!.textContent = "Failed to start — see console.";
  }
}

boot();
