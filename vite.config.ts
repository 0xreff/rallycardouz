import { defineConfig } from "vite";

// Rapier ships a .wasm file; Vite handles it as an asset automatically.
// We exclude it from dep-optimization so the wasm loads correctly in dev.
export default defineConfig({
  server: { host: true, port: 5173 },
  optimizeDeps: { exclude: ["@dimforge/rapier3d-compat"] },
  build: { target: "es2022" },
});
