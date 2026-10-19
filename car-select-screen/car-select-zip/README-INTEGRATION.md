# Revolt Reborn — Car Selection Screen (for game integration)

This package contains the premium car-select screen ("garage") built in Lovable.
An AI agent can copy these into the rally game project and wire the "ENTER" action
to start a stage with the selected car.

## Contents

```
src/
  routes/index.tsx      Car selection screen (the page)
  routes/__root.tsx     App root (loads fonts via <link>, mounts router)
  styles.css            All design tokens, glow effects, animations
  assets/*.asset.json   Pointer files for the CDN-hosted car images
media/                  The actual car + background images (PNG)
```

## Media files

| File | Used as |
|---|---|
| media/trophy-truck.png | TROPHY TRUCK — Custom Rally Prototype |
| media/land-cruiser-prado-90.png | LAND CRUISER PRADO — Toyota 90 Series |
| media/land-cruiser-79.png | LAND CRUISER 79 — Toyota 70 Series Pickup |
| media/desert-gate.png | Full-screen desert entrance background |

## How to integrate

1. **Car data** lives in the `CARS` array at the top of `src/routes/index.tsx`:

   ```ts
   { id, name, tag, img, hue, stats: { Speed, Handling, Acceleration, Grip },
     hp, weight, drive }
   ```

   Add, remove or rename entries here to match the game's real roster.
   `img` is a URL string — point it at the game's own image paths, or keep the
   included `media/*.png` files.

2. **"Select car" result.** The screen stores the chosen car in React state.
   The integration hook is where `ENTERED` / the enter confirmation appears
   (search for `entered` in `index.tsx`). Replace that overlay with a call into
   the game, e.g.:

   ```ts
   startStage(car.id)        // or: emit("car-selected", car.id)
   ```

   `car.id` values: `trophy-truck`, `prado-90`, `land-cruiser-79`.

3. **Keyboard controls** already wired: ← / → to switch cars, Enter to confirm.

4. **Styles**: copy `styles.css` contents into the project's global stylesheet.
   The screen uses tokens (`--vehicle-truck`, `--vehicle-prado`, `--vehicle-pickup`,
   `--background`, `--card`, `--border`, ...) plus the classes `glow-text`,
   `animate-car-in`, `clip-corner`, `desert-shade`, and the display font class
   `font-display`. Fonts are loaded in `__root.tsx` via <link> tags (Orbitron /
   Rajdhani style display fonts) — keep those links or swap for the game's fonts.

5. **Images**: either use `media/*.png` directly in the game, or keep the CDN
   URLs by reading `src/assets/*.asset.json` (each JSON has a `url` field).

## Notes

- Built with React + Tailwind CSS v4. If the game uses another stack, the
  agent can port the markup/styles; the logic (CARS array + selected-car state)
  is plain and framework-agnostic in spirit.
- Stats (HP, weight, drive, bar values) are placeholder values the designer
  invented — replace with the game's real numbers.
