# Reborn Racer — Mobile / Native App To-Do

_A separate track from the main `TODO.md` (which covers gameplay phases). This one is
about shipping the game as real installable apps. Created 2026-06-09._

## Goal & decision
- **Desktop:** browser (Win / Mac / Linux) — works today, no extra packaging needed.
- **Mobile:** ship **native iOS + Android apps** (App Store / Play Store), **not** a
  browser page. Decision made: native app, not PWA/in-browser.
- **Approach:** wrap the existing web build with **Capacitor** — no rewrite, reuses
  100% of the Three.js + Rapier code; the game renders in the device WebView
  (WebGL2 + WASM, supported on modern devices).

## Prerequisites — game-side work (do these FIRST; the packaging is the easy part)
- [ ] **Touch controls** — on-screen steering + throttle/brake/handbrake (no keyboard
      on phones). The biggest task. Needs a clean overlay that maps to the existing
      `ControlState` (so the car/physics need no changes).
- [ ] **Mobile quality preset** — a low/high switch that drops shadow-map resolution
      and/or disables bloom on mobile GPUs to hold framerate. Auto-detect mobile,
      allow manual override.
- [ ] **Mobile plumbing** — lock to landscape, handle notch/safe-area insets,
      keep-awake (prevent screen sleep), fullscreen, disable pinch-zoom / text select.
- [ ] (Optional) gamepad support, collision haptics (vibration).

## Packaging — Capacitor
- [ ] `npm i -D @capacitor/cli && npm i @capacitor/core` ; `npx cap init`.
- [ ] `npm run build` → `dist/` (already the web build output).
- [ ] `npx cap add android` / `npx cap add ios` (creates native project folders).
- [ ] `npx cap copy` after each build to sync `dist/` into the native shells.
- [ ] Open `android/` in Android Studio, `ios/` in Xcode → build, sign, run on device.

## Tooling & accounts required
- [ ] **Android:** Android Studio (any OS) + Google Play account ($25 one-time).
- [ ] **iOS:** a **Mac + Xcode** (mandatory for iOS) + Apple Developer account ($99/yr).
- [ ] App icons, splash screens, store screenshots, listing copy.

## Caveats to remember
- **Performance:** WebView WebGL is good on modern phones (iPhone A12+/iOS 15+,
  Android ~2020+) **at the reduced preset**; older/cheap Androids struggle with
  shadows+bloom — hence the quality switch.
- **Apple review (Guideline 4.2):** thin web wrappers get rejected; a full original
  game with native polish is fine. Make it feel like an app, not a website.
- **WebView baseline:** iOS WKWebView (WebGL2 since iOS 15) and Android System
  WebView (Chrome-based, auto-updating) are both fine on supported devices.

## Suggested order
1. Touch controls overlay → 2. Mobile quality preset → 3. Mobile plumbing →
4. Capacitor wrap + first on-device test build → 5. Store assets & submission.
