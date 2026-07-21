# RcDouz Render-Pipeline Perf Fix — Agent Blueprint

Context: Chrome trace showed ~28fps avg, main thread ~90% busy, `renderBufferDirect`
at 29.7% of frame time. Source review found the likely causes: the post-processing
chain (Bloom + SMAA) plus a 2048×2048 soft shadow map re-rendered every frame, and a
physics-substep/framerate feedback loop. This doc is the ONLY source of truth for
what to change. If something here doesn't match the file, STOP and report back —
do not improvise a similar-looking edit.

## Ground rules (read before touching anything)

1. **One step = one commit.** Never combine two steps into one commit.
2. **Touch only the files named in the step you're on.** No other file, no exceptions.
3. **No refactoring, renaming, reformatting, or dependency changes** beyond exactly
   what's specified — even if you spot something else that looks improvable.
4. **Out of scope, do not touch under any circumstances:** `CarSpec.ts`,
   `handling.ts`, `Track.ts`, `Physics.ts`, any tuning numbers or physics logic in
   `Car.ts`, `package.json`, `package-lock.json`, anything under `public/assets` or
   `dist/assets`.
5. **After every step:** run `npm run build` (must succeed, 0 errors), then manually
   drive around in the browser for ~15s and confirm no console errors and nothing
   looks visually broken — *before* moving to the next step.
6. **If the exact text you're told to find isn't in the file verbatim** (whitespace
   included), stop and report the mismatch instead of guessing at an equivalent edit.
7. Step 3 is a **diagnostic**, not a shippable change — see its notes.

---

## Step 0 — Checkpoint

```bash
git checkout -b perf/render-pipeline-audit
git add -A && git commit -m "checkpoint before perf audit" --allow-empty
```

---

## Step 1 — Enable build sourcemaps (zero behavior risk)

**File:** `vite.config.ts`

Find:
```ts
  build: { target: "es2022" },
```

Replace:
```ts
  build: { target: "es2022", sourcemap: true },
```

**Verify:** `npm run build` succeeds; a `.js.map` file appears next to each emitted
JS file in `dist/assets/`.

**Commit:** `perf: enable build sourcemaps for profiling`

**Rollback:** `git revert HEAD`

*(Do this first — every step after this should be measured with a fresh Chrome
Performance trace, and you want real function names in it instead of `ks`/`nD`.)*

---

## Step 2 — Cheaper shadow filtering (1-line test)

**File:** `src/game/Game.ts` (inside the constructor)

Find:
```ts
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

Replace:
```ts
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
```

**Verify:** build succeeds; drive around and confirm shadow edges look acceptable
(harder-edged than before — that's expected — but no flicker/artifacts).

**Commit:** `perf: switch to PCFShadowMap (cheaper than PCFSoft)`

**Rollback:** `git revert HEAD` if the harder shadow edge isn't acceptable visually.

---

## Step 3 — DIAGNOSTIC: isolate the post-processing cost (temporary, do not ship)

**File:** `src/game/Game.ts`, inside the constructor

Find:
```ts
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.55, // strength
      0.6,  // radius
      0.85  // threshold
    );
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    const pr = this.renderer.getPixelRatio();
    this.composer.addPass(new SMAAPass(window.innerWidth * pr, window.innerHeight * pr));
```

Replace with (note: passes are commented out, not deleted):
```ts
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.55, // strength
      0.6,  // radius
      0.85  // threshold
    );
    // TEMP-DISABLED for perf diagnostic (Step 3) — do not delete, do not leave
    // this way as the final state.
    // this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    const pr = this.renderer.getPixelRatio();
    // this.composer.addPass(new SMAAPass(window.innerWidth * pr, window.innerHeight * pr));
```

**Verify:** build succeeds; record a new Chrome Performance trace over roughly the
same ~30s driving pattern as the original trace.

**Commit:** `diagnostic: temporarily disable bloom+SMAA to isolate cost (DO NOT MERGE)`
— this commit is expected to be reverted or replaced, not kept.

**Do not decide what to do with the result.** Stop here and report back:
- new avg fps / frame time
- new Scripting vs Rendering split from the Summary tab
side-by-side with the original numbers. A human decides the follow-up (drop SMAA
only, replace with FXAA, reduce bloom resolution, or revert entirely) — that
decision becomes its own separate commit, not a continuation of this one.

---

## Step 4 — Optional, lowest priority, do only if separately asked to continue

Not the current bottleneck (only one bot exists right now) — worth doing before
more AI cars are added, not urgent.

**File:** `src/game/BotController.ts`

Add these scratch fields alongside the existing ones:
```ts
  private _pos = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _vel = new THREE.Vector3();
  private _origin = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _left = new THREE.Vector3();
  private _out: ControlState = {
    throttle: 0, brake: 0, steer: 0, handbrake: false, reset: false,
    recover: false, cycleCar: false, changeView: false, lookLeft: false, lookRight: false,
  };
```

Replace the `idle` object + `pos`/`fwd`/`vel` lookups at the top of `sample()`:
```ts
    const pos = this.car.position(this._pos);
    const fwd = this.car.forwardVector(this._fwd);
    const vel = this.car.velocity(this._vel);
    const speed = vel.dot(fwd);

    const out = this._out;
    out.throttle = 0; out.brake = 0; out.steer = 0; out.handbrake = false;
    out.reset = false; out.recover = false; out.cycleCar = false; out.changeView = false;
    out.lookLeft = false; out.lookRight = false;
```

Replace each `return { ...idle, ... }` with mutating `out` then `return out`, e.g.:
```ts
      out.brake = 1; out.steer = this.reverseDir;
      return out;
```

Replace the ray-origin block:
```ts
    const origin = this._origin.copy(pos).addScaledVector(fwd, 1.2);
    const right = this._right.copy(fwd).applyAxisAngle(UP, 0.45);
    const left = this._left.copy(fwd).applyAxisAngle(UP, -0.45);
```

And the final return:
```ts
    out.throttle = throttle; out.steer = steer;
    return out;
```

**Required correctness check before committing:** confirm `Car.update()` (in
`Game.ts`'s loop) only reads properties off the returned controls object
synchronously within the same call and never stores the reference for later — it
does today, but this step makes that assumption load-bearing, so re-verify it
wasn't changed in an earlier step.

**Verify:** build succeeds; drive alongside the bot for ~30s, confirm it still
wanders/avoids obstacles/reverses when stuck exactly as before.

**Commit:** `perf: remove per-frame allocations in BotController.sample()`

**Rollback:** `git revert HEAD`

---

## Reporting format (after Steps 1–3, or 1–4 if done)

Report back a simple before/after table: avg fps, % frames <30fps, and the
Scripting/Rendering/Painting split from the Summary tab. Do not make further
changes beyond what's listed above without checking in first.
