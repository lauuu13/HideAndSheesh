# Bagong Ilog: Hide and Seek (Android)

A 3D local-network hide-and-seek game for Android. One player is a
random Seeker (NBI-style uniform), everyone else picks one of 13
fictional characters (barong for the men, filipiniana for the women)
and hides across a simplified map inspired by Barangay Bagong Ilog,
Pasig City (C-5 highway edge, Pasig River edge, an industrial zone,
and a dense residential zone of narrow eskinitas, sari-sari stores,
and tricycles to hide behind).

## Project layout

```
.
├── .github/workflows/build.yml   # CI: builds the Android APK on every push
├── package.json                  # Node deps + Capacitor scripts
├── capacitor.config.json         # Android wrapper config (points at www/)
├── plugins/capacitor-host-server/  # Native Android plugin: embedded WebSocket
│   │                                host server + LAN lobby discovery
│   ├── android/src/main/java/com/bagongilog/hostserver/HostServerPlugin.java
│   └── android/build.gradle
└── www/                          # the game client
    ├── index.html                # lobby, HUD, joysticks
    └── game.js                   # Three.js map, avatars, controls, networking
```

## How hosting works

Every game is fully self-contained on Android — no laptop, no
separate server process. The lobby screen has two primary actions:

- **📡 Create Lobby** — starts a real embedded WebSocket server
  in-process on that phone (native Java plugin, using
  `org.java-websocket`), then connects you to it automatically.
- **🔍 Browse Lobbies** — listens for LAN broadcast announcements
  from any nearby phone that tapped "Create Lobby," and lists them
  as tappable entries — no typing an IP required.

Manual IP entry is still there as a fallback if discovery doesn't
find anything (e.g. a router that blocks broadcast traffic between
devices).

## Lobby, players, and characters

- **2–10 players** can play a round, seeker included. "Start Round"
  is disabled until at least 2 people have joined, and the host
  rejects new connections once 10 are in.
- **13 fictional characters**, each in Filipino formalwear — barong
  for the men, filipiniana with butterfly sleeves for the women.
  **No two players can pick the same character** — the grid updates
  live for everyone in the lobby, greying out whatever's taken.
- The **Seeker is chosen at random** each round, and their model
  swaps to an NBI-style uniform (navy shirt, capped hat, gold badge)
  regardless of which character they'd picked as a hider.

## Running / building

Push to any branch and `.github/workflows/build.yml` builds a debug
`.apk` automatically, uploaded as a workflow artifact — check the
**Actions** tab, or push a version tag (`git tag v1.0.0 && git push
--tags`) to also get it attached to a GitHub Release.

## Notes / next steps

- The debug APK is unsigned (fine for local testing/sideloading).
- The embedded host server (`plugins/capacitor-host-server/`) is
  authoritative for roles, the hiding-phase blind lock, shot range
  checks, and character-uniqueness — clients can't cheat by
  reporting fake state.
- If the 3D view ever renders blank, the app now shows an on-screen
  red error banner with the actual JS error (added specifically to
  make that kind of bug diagnosable from a screenshot instead of
  guesswork).
