# Bagong Ilog: Hide and Seek (Local Network Prototype)

A 3D local-network hide-and-seek game. One player is a random Seeker
(police officer), everyone else picks a fictional barangay character
and hides across a simplified map inspired by Barangay Bagong Ilog,
Pasig City (C-5 highway edge, Pasig River edge, an industrial zone,
and a dense residential zone of narrow eskinitas, sari-sari stores,
and tricycles to hide behind).

## Project layout

```
.
├── .github/workflows/build.yml   # CI: builds Android APK + macOS app on every push
├── server.js                     # Node + ws WebSocket game server (run on the host machine)
├── package.json                  # Node deps + Capacitor/Tauri scripts
├── capacitor.config.json         # Android wrapper config (points at www/)
├── src-tauri/                    # macOS desktop shell (Tauri)
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   ├── build.rs
│   └── src/main.rs
└── www/                          # the actual game client (shared by Android + macOS + browser)
    ├── index.html                # lobby, HUD, joysticks
    └── game.js                   # Three.js map, avatars, controls, networking
```

`www/` is the single source of truth for the game UI/logic — both the
Android build (via Capacitor's `webDir`) and the macOS build (via
Tauri's `distDir`) just wrap that same folder, so you only maintain
one client codebase.

## Running it locally (fastest way to test)

```bash
npm install
node server.js        # prints your Local IP — share it with players
```

Then open `www/index.html` in a browser (or serve it with any static
file server) on each device, and type the host's Local IP into the
lobby screen. Everyone must be on the same Wi-Fi network.

## How the automated builds work

Every push to any branch runs `.github/workflows/build.yml`, which:

1. **Android job** — installs the Android SDK + JDK, runs
   `npx cap add android` / `npx cap sync` to generate the native
   Android project from `www/`, then runs Gradle to produce a debug
   `.apk`, uploaded as a workflow artifact named
   `hideandseek-android-apk`.
2. **macOS job** — installs Rust + the Tauri CLI, then runs
   `tauri build` against `www/` to produce a universal `.app` and
   `.dmg`, uploaded as `hideandseek-macos-app` / `hideandseek-macos-dmg`.
3. **Release job** — if you push a git tag (e.g. `git tag v1.0.0 && git push --tags`),
   both build outputs are attached directly to a GitHub Release.

Download builds from the repo's **Actions** tab → the workflow run →
**Artifacts**, or from **Releases** if you pushed a tag.

## Hosting from a phone or Mac directly (no laptop required)

The lobby screen has a **"📡 Create Lobby"** button. Tapping it starts
a real embedded WebSocket server on that device itself and
auto-connects you to it — no separate `node server.js` needed:

- **macOS app**: the server runs in-process in Rust
  (`src-tauri/src/host_server.rs`), using a real OS socket.
- **Android app**: the server runs in a native plugin
  (`plugins/capacitor-host-server/`), using the
  `org.java-websocket` library.
- **Browser tab**: hosting isn't possible from a plain browser tab
  (browsers can't accept incoming connections) — use `node server.js`
  on a laptop instead, same as before.

Both native servers speak the exact same message protocol as
`server.js`, so any other player — laptop, phone, whatever — just
types in the host device's IP address and connects normally, or
finds it automatically via **"🔍 Browse Lobbies"** (see below).

## Lobby, players, and characters

- **2–10 players** can play a round, seeker included. The host's
  "Start Round" button is disabled until at least 2 people have
  joined, and every server rejects new connections once 10 are in.
- **13 fictional characters** are available, each in Filipino
  formalwear (barong for the men, filipiniana with butterfly sleeves
  for the women). **No two players can pick the same character** —
  the character grid updates live for everyone in the lobby, greying
  out whatever's already taken.
- The **Seeker is chosen at random** each round from whoever's
  connected, and their model swaps to an NBI-style uniform (navy
  shirt, cap with brim, gold badge) regardless of which character
  they'd picked as a hider.
- **Browse Lobbies**: every host (laptop, phone, or Mac) broadcasts
  a small UDP announcement on the LAN every 2 seconds. Tapping
  "Browse Lobbies" on the Android or macOS app listens for these for
  a few seconds and lists any it finds — tap one to join, no typing
  required. Manual IP entry is still there as a fallback (and is the
  only option when testing in a plain browser tab, since browsers
  can't do this kind of network discovery).

**Known limitation:** stopping the embedded host mid-session is
best-effort (the underlying socket listener may keep running until
the app fully closes) — fine for a prototype, worth hardening before
a real release.

## Notes / next steps

- The debug APK is unsigned (fine for local testing/sideloading).
  For a signed release APK you'd add a signing step with a keystore
  stored in GitHub Secrets.
- `server.js` is authoritative for roles, the hiding-phase blind lock,
  and shot range checks, so clients can't cheat by unlocking early or
  reporting fake hits.
- The hider roster in `www/game.js` (`CHARACTERS`) is original/fictional
  — swap in your own names, colors, or hats freely.
