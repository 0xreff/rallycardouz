import { defineConfig } from "vite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const root = import.meta.dirname;

export default defineConfig({
  base: "./",
  server: { host: true, port: 5173 },
  optimizeDeps: { exclude: ["@dimforge/rapier3d-compat"] },
  build: {
    target: "es2022",
    rolldownOptions: {
      input: {
        main: resolve(root, "index.html"),
        ...(existsSync(resolve(root, "desert/index.html"))
          ? { desert: resolve(root, "desert/index.html") }
          : {}),
      },
      output: {
        codeSplitting: {
          groups: [
            { name: "rapier", test: /node_modules[\\/]@dimforge/, priority: 20 },
            { name: "three", test: /node_modules[\\/]three/, priority: 10 },
          ],
        },
      },
    },
  },
});