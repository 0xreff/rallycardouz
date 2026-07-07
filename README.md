# Reborn Racer — 2026 (Web)

A browser-based, Re-Volt–*inspired* RC racing game. **All game assets are
original.** The original Re-Volt files in the parent folder are used only as a
**design and physics reference** (handling feel, tuning ratios, level layout
ideas, shader techniques) — no copyrighted meshes, textures, or audio are
shipped here.

## Tech stack
- **Three.js** — WebGL rendering, custom GLSL (rim-light glow), post chain:
  RenderPass → UnrealBloom → OutputPass (ACES tone map + sRGB) → SMAA
- **Rapier** (WebAssembly) — physics + built-in raycast vehicle controller,
  stepped at a **fixed 60 Hz** (accumulator with capped substeps) so handling
  is deterministic and framerate-independent
- **TypeScript + Vite** — typed code, fast dev server / bundling
- **Vitest** — unit tests for the pure handling math (`src/game/handling.ts`)
- **Socket.io + Node** — real-time multiplayer (planned, Phase 5)

## Run it
```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/ (static — host anywhere)
npm test           # handling-math unit tests
```

## Controls
- **W / ↑** accelerate · **S / ↓** front brake & reverse
- **A D / ← →** steer · **Space** handbrake (full stop)
- **F** flip upright · **R** reset to start · **C** change car

## Engine notes
- **Fixed-timestep physics** — `Physics.step` accumulates real frame time and
  advances the Rapier world in fixed 1/60 s substeps (max 4 per frame, extra
  time dropped). Vehicle forces are applied per-substep from the game loop, so
  a 45 fps laptop and a 144 Hz monitor produce identical handling.
- **Surface model** — every static collider registers a surface type in
  `game/Surfaces.ts` (terrain = **dirt**, road/curbs/ramps = **tarmac**,
  perimeter = wall). Each car probes the surface under every wheel with a short
  downward ray each substep, then scales axle side-friction, per-wheel engine
  traction and brake deceleration: full bite on the road; wide, loose and
  longer-stopping on dirt — the rally-game core.
- **Handling model** — fully spec-driven (`game/CarSpec.ts`, no tuning in
  `Car.ts`): static→kinetic slip per axle, weight transfer, friction circle,
  lockup/skid, lift-off oversteer, persistent tail-out slip, cosmetic body lean.
- **Particles & marks** — pooled, zero-allocation-per-frame systems: tyre smoke
  (tarmac slip), **dust trails** (dirt × speed/slip, thrown back along travel),
  collision sparks at real contact points, InstancedMesh skid marks.
- **Rendering** — all geometry is procedural (~25 draw calls); one tight
  car-following shadow frustum instead of a huge map-wide shadow map; SMAA in
  the composer (canvas MSAA is bypassed by offscreen targets, so it was dropped).

## Roadmap
1. ✅ Drivable prototype (car physics, chase cam, test track, rim look, bloom)
2. ✅ Handling & feel (slip/braking model, fixed 60 Hz timestep, surface grip:
   tarmac vs dirt, dust trails, SMAA)
3. Visual identity / 2026 look (original models, textures, themed track, skybox)
   — add Draco/KTX2 asset compression + LOD here, once real assets exist
4. Lap system & single-player race (checkpoints, timer, AI/time-trial)
5. Multiplayer (Node + Socket.io lobby & sync)
6. Deploy & embed on the blog (static `dist/` client + Node server)

## Project layout
```
src/
  main.ts                 entry / boot (async Rapier WASM init + loader overlay)
  engine/
    Input.ts              keyboard → control state
    ChaseCamera.ts        smooth trailing camera (speed/impact aware)
    RimMaterial.ts        PBR + signature rim-glow (ported from model_fs.glsl)
    SkidMarks.ts          InstancedMesh pool of tyre marks
    Sparks.ts             collision spark particles
    Smoke.ts              tyre-smoke point sprites (tarmac)
    Dust.ts               loose-surface dust trails (dirt)
  physics/
    Physics.ts            Rapier world wrapper — fixed 60 Hz substep accumulator
  game/
    Car.ts                chassis + raycast vehicle controller + surface probing
    CarSpec.ts            per-car tuning + the roster (Bolt / Hornet / Tank)
    CarFX.ts              routes car state → sparks / skids / smoke / dust
    Surfaces.ts           surface registry: tarmac / dirt / wall → grip, dust
    Track.ts              terrain + road + ramps + colliders (surface-tagged)
    BotController.ts      wandering AI opponent (raycast avoidance)
    handling.ts           pure handling math (unit-tested in handling.test.ts)
    Game.ts               renderer, lights, post-processing, game loop
```

## Known trade-offs
- **Fixed 60 Hz without render interpolation** — on 120/144 Hz displays motion
  can micro-judder (0 or 2 substeps on some frames). Render interpolation of
  body transforms is the fix if it becomes noticeable.
- **SMAA instead of MSAA** — the EffectComposer's offscreen targets bypass
  canvas MSAA, so SMAA does the AA; slightly softer than 4× MSAA but honest
  (before, no AA was actually applied).
- **No texture/model assets yet** — everything is procedural, so Draco/KTX2
  compression, texture-tiling fixes and LOD are deferred to Phase 3 when real
  assets land; today's scene is already light (~25 draw calls, one 96×96
  terrain mesh).
- **Surface probe cost** — 4 short raycasts per car per substep (≤ 480 rays/s
  per car); negligible, but worth knowing it scales with car count.
