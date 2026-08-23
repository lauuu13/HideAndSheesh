# Hide and Sheesh (Android)

A 3D local-network hide-and-seek game for Android, set inside a
3-story house. One or two players are randomly chosen as Officers
(NBI-style uniform), everyone else picks one of 13 fictional
characters and hides across the house's rooms, closets, and
furniture — with a side stairwell connecting all three floors.

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
    └── game.js                   # Three.js house, avatars, controls, networking
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

- **2–10 players** can play a round, officers included. "Start Round"
  is disabled until at least 2 people have joined, and the host
  rejects new connections once 10 are in.
- **1 or 2 Officers** — whoever starts the round picks the officer
  count from a toggle in the lobby (2 officers only unlocks once
  there are at least 3 players, so at least one hider remains).
  Officers are chosen at random from the connected players each
  round.
- **13 fictional characters**, each in Filipino formalwear — barong
  for the men, filipiniana with butterfly sleeves for the women.
  **No two players can pick the same character** — the grid updates
  live for everyone in the lobby, greying out whatever's taken.
- Officers' models swap to an NBI-style uniform (navy shirt, capped
  hat, gold badge) regardless of which character they'd picked as a
  hider.
- **Ghost mode** — hiders camouflage to near-invisible while standing
  still, and become partially visible (low opacity) while moving.
  Officers are always fully visible.

## The house

- **3 floors**, connected by a single stairwell running along the
  west side of the house (not the middle) — two flights, one from
  floor 1→2 and another from floor 2→3.
- Each floor has 4 rooms off the stair hall: living/kitchen areas
  downstairs, two bedrooms on floor 2, and a game room + home gym on
  floor 3 — plus a bathroom and a utility/storage room on every floor.
  Distinct flooring per room (wood, tile, carpet, ceramic tile).
- Furniture is detailed rather than plain boxes — sofas have
  backrests and armrests, chairs and tables have tapered legs, the
  TV has an actual screen, the fridge has a door seam and handles.
- **Jump** clears low furniture (the collision system ignores any
  obstacle once your feet rise above its top); **Duck** slows you
  down but lowers your profile.

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
- If the 3D view ever renders blank, the app shows an on-screen red
  error banner with the actual JS error (added specifically to make
  that kind of bug diagnosable from a screenshot instead of
  guesswork).
