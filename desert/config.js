// Central tuning for the desert demo. Every look/feel knob lives here.
// The lil-gui panel edits this object live; use "Copy config to clipboard"
// and paste the result back into this file to keep a look.

// Quality presets. All fields apply live when switching in the panel.
export const QUALITY_PRESETS = {
  LOW: { pixelRatioCap: 1.0, shadowMapSize: 1024, shadowExtent: 45, msaa: 0, bloom: false, post: false, maxParticles: 500, hazeSheets: 2, rippleDetail: 0, terrainSegments: 192 },
  MEDIUM: { pixelRatioCap: 1.5, shadowMapSize: 2048, shadowExtent: 60, msaa: 2, bloom: true, post: true, maxParticles: 1400, hazeSheets: 4, rippleDetail: 1, terrainSegments: 288 },
  HIGH: { pixelRatioCap: 2.0, shadowMapSize: 4096, shadowExtent: 70, msaa: 4, bloom: true, post: true, maxParticles: 2800, hazeSheets: 6, rippleDetail: 1, terrainSegments: 384 },
};

export const config = {
  quality: 'MEDIUM',
  exposure: 1.0,

  // Sun: elevation/azimuth in degrees. The car spawns heading 25 deg left of the
  // sun so it sits upper-right of frame (backlit shot).
  sun: { elevation: 14, azimuth: 200, intensity: 3.4, color: '#ffbf80', discSize: 1.4, discIntensity: 40 },

  sky: { zenith: '#a8968c', horizonBlend: 0.32, curve: 0.7, glow: 0.35, mieG: 0.78, coreGlow: 2.5 },

  // Height-aware exp2 fog with a sun-scatter tint. density = overall haze.
  fog: { color: '#d99a62', sunColor: '#ffd9a0', density: 0.00085, heightFalloff: 0.022, baseHeight: -5, sunPower: 6, sunStrength: 0.85 },

  palette: {
    sand: '#c9773f', sandShadow: '#7a3a22', sandCrest: '#eeb07a',
    rockDark: '#6a2a1a', rockLight: '#b8603a', rockSand: '#c9773f',
    dust: '#c98a5a', dustLit: '#ffd8a8',
  },

  hemi: { sky: '#7f8aa0', ground: '#a8552e', intensity: 1.1 },

  // Terrain shape (applies when the terrain is rebuilt: quality change or reload).
  terrain: { size: 6000, duneHeight: 22, duneScale: 0.0022, warp: 1.2, rollHeight: 1.6, flattenRadius: 160, seed: 7 },

  sand: { rippleScale: 1.1, rippleStrength: 0.6, rippleStretch: 3.5, rippleFadeDistance: 260, sparkle: 0.6, rim: 0.55, variation: 0.12 },

  wind: { direction: 35, speed: 3.2 },

  // Rock counts/seed apply on reload; shading params are live.
  rocks: { near: 26, mid: 40, far: 46, sunBias: 0.45, seed: 3, strataScale: 0.11, strataContrast: 1.0, streaks: 0.55, rim: 0.9 },

  dust: { amount: 1.0, size: 1.0, growth: 5.0, lifetime: 1.0, opacity: 0.55, backlight: 1.4, backPower: 4.0 },

  haze: { opacity: 0.16, height: 18, speed: 1.0 },

  camera: { fov: 64, fovKick: 9, distance: 7.2, height: 2.4, lookAhead: 6, lookHeight: 1.1, followDamping: 5.5, lookDamping: 8, shake: 0.6, bob: 0.4 },

  post: {
    bloomStrength: 0.85, bloomRadius: 0.65, bloomThreshold: 1.1,
    vignette: 0.45, vignetteTint: '#3a1408', grain: 0.045, chromatic: 0.0025,
    saturation: 0.92, contrast: 1.05, warmth: 0.35,
    lift: { r: 0.03, g: 0.012, b: 0.0 },
    gamma: { r: 1.0, g: 0.98, b: 0.94 },
    gain: { r: 1.03, g: 0.99, b: 0.93 },
    shimmer: 0.0018, shimmerWidth: 0.05,
  },

  vehicle: { maxSpeed: 32, accel: 11, brake: 22, drag: 0.35, turnRate: 1.6, headlightColor: '#cfe6ff', headlightIntensity: 7, spotIntensity: 40, autoDrive: true },
};
