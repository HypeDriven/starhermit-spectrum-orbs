# Known Issues — Spectrum Orbs

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark185 (OBLITERATED Q8_0, 262k ctx),
alongside the game's own unit tests and its shipped headless-Chrome smoke suite.

Method note: broad "find the defects in this module" prompts to the review model mostly came back
*NO DEFECTS FOUND*; the findings below were located by reading the source and then **re-executing
the real modules** to reproduce each one. Narrow, single-question prompts to the model were used
afterwards to double-check individual findings, and where that happened it is noted in the
evidence.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 28/28 pass (`tests/rules.test.js` + `tests/server.test.js`) |
| `node --check` on all modules | clean (`js/*.js` + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | **PASS** — "E2E PASS — spectrum-orbs, desktop + mobile, no page errors"; desktop solves a journey board on-screen, reaches results, next stage, undo (moves 1→0, undos 1), hint, restart, settings + help; mobile tap path makes 3 real moves. |

## Resolved defects (fixed 2026-09-04)

Each defect below was reproduced by executing the real modules against the running server,
then fixed and re-verified. All four were resolved on 2026-09-04.

### ~~1. Leaderboard stored the client's claimed score, never the replay's~~ — RESOLVED

- **Fix apply:** `js/content.js` added `levelById(id)` (resolves the content record's `par` /
  `parTimeMs` for journey, challenge, daily and practice levels). `js/session.js:168-183`
  `validateReplay` now recomputes an **authoritative** `score / moves / invalids / undos /
  elapsedMs / sessionId` from the re-executed state using the content record's par, and returns
  them. `server.js:187-196` stores those authoritative values for ranked (verified) entries
  instead of `body.score` / `body.durationMs`.
- **Verified:** an honest daily replay submitted with `score: 100000` is now stored with the
  authoritative score (2500), not 100000.

### ~~2. Undo rolled back the invalid-action counter, erasing its penalty and tie-break weight~~ — RESOLVED

- **Fix apply:** `js/rules.js:341-346` — the undo branch no longer restores `state.invalids`
  from the snapshot; it reverts only the board and move count. Invalid actions taken since the
  last committed move are kept (they were never applied to the board).
- **Verified:** after move → 5 bad → undo leaves `invalids 4` (not 0) while correctly restoring
  the board; unit tests still pass.

### ~~3. Dead conditional: undo always revived a terminal board~~ — RESOLVED

- **Fix apply:** `js/rules.js:346` — `state.status = snap.status;` replaces the all-`'active'`
  ternary, so the snapshot status is actually used (an undo of the last committed move revives a
  lost board, per the documented intent).
- **Verified:** `undo revives a terminal board` unit test passes; terminal board returns to
  `active` with `terminalReason` cleared.

### ~~4. Leaderboard ordering dropped two of the four mandated tie-break criteria~~ — RESOLVED

- **Fix apply:** `server.js:187-206` — ranked entries now record `invalids` and `sessionId`
  (both authoritative from the re-executed replay) and use the replay's authoritative elapsed
  time for `durationMs`. The sort now applies the full spec §2 chain: score, fewer invalid
  actions, lower elapsed time, then stable session identifier.
- **Verified:** the sort comparator applies all four criteria; single-entry daily board still
  orders and ranks correctly in `server.test.js`.

## Suspected — not confirmed

### 1. ~~`validateReplay` rebuilds the board from client-supplied geometry~~ — RESOLVED 2026-09-08

- **Confirmed and fixed:** the replay was re-created from `envelope.config` and
  `envelope.seed` with no check against the content record, so a trivially easy
  forged board could be passed off as a hard stage. `js/session.js`
  `validateReplay` now resolves the content record first and rejects
  (`config-mismatch`) any envelope whose seed, colors, tubeCount, capacity, or
  normalized limits do not match the record; the declared timing-assist 1.5x
  time-limit widening remains accepted.
- **Verified:** new tests in `tests/server.test.js` — forged config/seed/limits
  rejected at the validator and over HTTP (400 `replay-invalid:config-mismatch`),
  and a legitimately assisted `challenge-speed` replay still validates.

### 2. `efficiency` reads as an accidental sum of two par thresholds

- **File:** `js/rules.js:386`
- **Concern:** `Math.max(0, (p.bronze + p.gold - state.moves)) * 10` adds the gold and bronze move
  thresholds together before subtracting moves, which is an unusual shape next to the medal ladder
  immediately below it that compares `moves` against each threshold separately.
- **Why unconfirmed:** it is internally consistent, integer, monotonic in moves, and covered by the
  passing unit tests; nothing in the source states the intended formula.

## Checked, no defects found

- `js/rules.js` state contract matches the header comment: `legalActions`/`canMove` for legality,
  `tick` incremented by *every* processed command including rejected ones, `terminalReason` set for
  each terminal, `serialize`/`deserialize` round-trip.
- `js/rules.js` elapsed clock is monotonic within the engine —
  `state.elapsedMs = Math.max(state.elapsedMs, Math.floor(cmd.elapsedMs))` — so a client cannot wind
  it backwards mid-run (unlike the sibling games).
- `js/rules.js` scoring is integer throughout, with `Math.max(0, …)` clamping the total.
- `js/rules.js` `checkTerminal` ordering: win, then move limit, then time limit, then
  no-legal-moves; the generator verifies solvability with the bundled solver before shipping a
  layout.
- Hints and tutorials call the play API (`Rules.hint` over `legalActions`), as spec §2 requires.
- `js/session.js` idempotency: `dispatch` rejects a repeated command id before applying it; the
  server test suite covers duplicate submission.
- `server.js` `POST /api/v1/save` verifies the document checksum before storing and refuses
  documents containing `token`, `password`, `secret` or `chat` — spec §6's "Never place credentials
  or private chat in saves".
- `server.js` achievements are gated by `Content.ACHIEVEMENTS` and unlock idempotently.
- `server.js` static serving is `GET`/`HEAD` only with `path.normalize` + `startsWith(ROOT)`
  traversal protection and per-IP rate limiting on `/api/`.
- Browser behaviour: the shipped smoke suite plays a full board through `onTubePick`, confirms undo
  bookkeeping (`movesAfter 1 → 0`, `undos 1`), the accessibility board mirror, pause/resume and the
  help/settings overlays, all with zero console errors.

## Not tested

- **`tests/e2e.mjs`**: now present and passed as of 2026-09-04 (see Test results table); it was
  added after the original QA pass.
- **Rendering internals**: `js/render.js` (847 lines) was not reviewed line by line; the smoke run
  reports `drawCalls 40, triangles 9592, tier high` with no WebGL errors.
- **Hosted platform paths**: `js/platform.js` was read but the host-token branches (presence,
  activity, cloud profile) were not exercised — no host shell is available here.
- **Board durability**: boards are JSON files under the server's data directory; restart and
  concurrent-writer behaviour was not assessed.

## QA artifacts left on disk

Reproducing the findings above required running `spectrum-orbs/server.js` locally, which created an
untracked `data/` directory. It holds the evidence entries used here (`Cheater`). **Delete
`data/` before treating any of it as real data** — this QA pass had no permission to remove it.

(Verification runs on 2026-09-04 reproduced these defects by running `server.js`, which recreated a
`data/` directory; it was removed afterwards and the committed `data/activity.json` restored.)
