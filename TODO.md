# Reborn Racer — To-Do

_Last updated: 2026-06-09 (end of handling/feel + visuals session)_

> 📱 Mobile / native-app work (iOS + Android via Capacitor) is tracked separately in
> [TODO-mobile.md](./TODO-mobile.md).

## Where we are
Phase 1 prototype works. **Phase 2 (handling & feel) is essentially done** — the
car now slides convincingly and you can *see* it. The handling is a full,
spec-driven model; every lever below is a per-car knob in `CarSpec.ts` (no tuning
is hardcoded in `Car.ts`).

### Handling model (all implemented, all tunable per car)
- **Braking** — real model, not a velocity script: pedal pressure build-up
  (`brakeRamp`), weight transfer to the nose (`weightTransfer`, subtle dip),
  friction circle so braking shares grip with cornering (`FRICTION_CIRCLE`
  const → trail-brake rotation), and lockup/skid past `lockupAt` (front lock =
  understeer, rear lock = slide; slamming *lengthens* the stop). Foot brake is
  front-biased (`brakeBiasFront`); handbrake (Space) locks the rear for a slide
  but still stops (`lockupGrip` = rear grip while locked — lower = wilder slide).
- **Drift / slip** — per-axle static→kinetic grip; rear breaks loose first
  (`rearGripBias`) for catchable oversteer (`slipThreshold`, `kineticGripRatio`).
- **Persistent tail-out slip** — `tailSlip`: turning at speed always bleeds a
  little rear grip → every car carries a slip angle (momentum resists the turn).
- **Lift-off oversteer** — release throttle mid-corner to rotate: grip-based
  (`liftoffOversteer`) + a low-speed yaw assist (`liftoffYaw`, capped by
  `MAX_ASSIST_YAW`) that pivots the tail to tighten slow turns.
- **Momentum feel** — raised yaw inertia (`inertia.y`) + lowered `angularDamping`
  so the tail carries and trails through slides.
- **Cosmetic body lean** — visual-only chassis roll into the slide
  (`leanStrength`, `leanLowSpeedAmp`); physics body never tips, wheels stay planted.
- **Skid marks** — `src/engine/SkidMarks.ts` (InstancedMesh pool, owned by Game):
  dark tyre trails laid wherever a wheel slides (drift or lock). `SKID_SLIP_SPEED`
  gates onset; material opacity / stamp size tune the look.

## Phase 2 — remaining polish (optional)
- [ ] Final tuning pass: confirm Bolt / Hornet / Tank feel distinct & none flip.
- [ ] Polish the brake→reverse hand-off (the S-held transition through zero).
- [ ] (Optional) Tyre **smoke** particles off sliding wheels — the next visual
      step after skid marks if more drift drama is wanted.

## Remaining phases
- **Phase 2 — Handling & feel** _(essentially complete — polish only)_.
- **Phase 3 — Visual identity (2026 look)** — original car models & textures,
  themed track, skybox, refined rim-glow GLSL, bloom/colour grade.
- **Phase 4 — Lap system & single-player race** — car-selection screen,
  checkpoints, lap counting, timer, start/finish, AI opponents or time-trial.
- **Phase 5 — Multiplayer (Node + Socket.io)** — lobby, rooms, state sync &
  interpolation; player chooses single-player or multiplayer.
- **Phase 6 — Deploy & embed on the blog** — production build, host static
  client + Node multiplayer server, embed/link from the blog.

## How to run
```bash
cd web
npm run dev        # http://localhost:5173
```
Controls: W/↑ accel · S/↓ front brake & reverse · A D / ← → steer ·
Space handbrake (full stop) · F flip upright · R reset · C change car
