import { Physics } from "./physics/Physics";
import { Game } from "./game/Game";
import { LightsPanel } from "./game/LightsPanel";

async function boot() {
  const container = document.getElementById("app")!;
  const loader = document.getElementById("loader")!;

  try {
    const physics = await Physics.create();
    const game = new Game(physics, container);
    game.start();
    new LightsPanel(); // press L: edit the vehicle lights, Save to apply

    // Fade out the loading overlay.
    loader.style.opacity = "0";
    setTimeout(() => loader.remove(), 600);
  } catch (err) {
    console.error(err);
    loader.querySelector(".sub")!.textContent = "Failed to start — see console.";
  }
}

boot();