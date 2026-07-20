import * as THREE from "three";

/**
 * Soft round puff sprite (white core fading to transparent).
 * Used by both Smoke and Dust — cached so only ONE texture is ever created
 * and uploaded to the GPU, regardless of how many particle systems exist.
 */
let cached: THREE.Texture | null = null;

export function getPuffTexture(): THREE.Texture {
  if (cached) return cached;
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  cached = new THREE.CanvasTexture(c);
  return cached;
}
