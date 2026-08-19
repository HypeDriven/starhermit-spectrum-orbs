# Spectrum Orbs

A kinetic sculpture gallery ordering puzzle. Move the top orb between tubes
until every tube holds a single color.

## Run

```
npm start          # node server.js -> http://localhost:8080
```

Or open `index.html` via any static file server. The game is fully playable
offline (guest practice, journey, daily); when served by `server.js`, hosted
features activate: server-time sync, cloud saves, validated leaderboards,
durable achievements.

## Tests

```
npm test                                   # rules engine unit/property/golden tests
node --test tests/server.test.js           # authoritative server integration tests
SMOKE_PORT=8080 node tests/browser-smoke.mjs  # end-to-end headless-Chrome playthrough
```

## Layout

- `index.html`, `css/style.css` — semantic UI shell (screens, overlays, a11y mirror)
- `js/rng.js` — seeded streams (rules / decor / audio)
- `js/rules.js` — pure deterministic rules engine (shared client/server)
- `js/content.js` — 40 journey stages, daily rulesets, challenges, themes, validators
- `js/session.js` — command dispatch, undo, replay envelopes, snapshots
- `js/platform.js` — StarHermit host adapter (launch token, time sync, saves, boards)
- `js/render.js` — Three.js gallery scene (vendored `vendor/three.module.min.js`)
- `js/audio.js` — synthesized buses and event sounds
- `js/ui.js` — DOM screens, HUD, settings, help, leaderboards
- `js/main.js` — bootstrap + game state machine
- `server.js` — authoritative script (validation, leaderboards, saves)
- `starhermit.txt` — distribution manifest (`name`, `launch`, `server`)
