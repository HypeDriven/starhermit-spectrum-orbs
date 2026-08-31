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
| `node --check` on all modules | clean (9 `js/*.js` + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | no file of that name; the game ships **`tests/browser-smoke.mjs`**, which was run against real headless Chrome on port 39604 — **PASS**, "console errors: none". It boots, solves a journey board through the real input path, reaches results, advances a stage, exercises undo, daily, practice, challenge, a learn lesson, pause/resume, settings and help. |

## Confirmed defects

Each defect below was reproduced by executing the real modules against the running server, not
merely reported by the model.

### 1. The leaderboard stores the client's claimed score, never the score the replay produces

- **File:** `server.js:189` (`POST /api/v1/leaderboard`), with `js/session.js:145`
  (`GameSession.validateReplay`)
- **Trigger:** submit an entirely genuine winning replay together with `score: 100000`.
- **Behaviour:** `validateReplay` re-executes the command log and checks the initial hash, the
  periodic hashes, the terminal status and `moves`/`invalids` — but it deliberately scores with a
  dummy par (`Rules.score(s, { gold: 1, silver: 2, bronze: 3 })`, `js/session.js:168`) and compares
  only those two counters. The handler then writes `score: body.score | 0` straight from the
  payload, sets `verified: true`, and files the entry on the **ranked** board (`ranked = verified`,
  `server.js:183`). The only bound on the number is the `0 … 100000` range check in
  `validateScoreSubmission` (`server.js:251`).
- **Expected:** spec §6: "validate score claims through a lightweight authoritative script using
  replayable input logs and deterministic seeds; reject impossible or stale-version scores", and
  spec §5: "Treat client clocks, scores … as untrusted in competitive contexts."
- **Evidence:** an honest solve of `journey-01` scores 1260. Submitting that same replay with
  `score: 100000`:

  ```
  honest score: 1260  status: won  moves: 18
  validateReplay: {"ok":true,"finalHash":"cb2b1996","status":"won"}
  POST /api/v1/leaderboard -> 200 {"stored":"cloud","rank":1,"verified":true,"casual":false}
  GET  /api/v1/leaderboard?board=journey ->
    entries[0] = {"player":"Cheater","score":100000,"verified":true,...}
    entries[1] = {"player":"Guest","score":1260,"verified":true,...}   <- the real run
  ```

  (`entries[1]` is the legitimate 1260 written by the browser smoke test minutes earlier.)

### 2. Undo rolls back the invalid-action counter, erasing its penalty and its tie-break weight

- **File:** `js/rules.js:343` (`applyCommand`, `undo` branch) with `js/rules.js:258`
  (`snapshotForUndo`)
- **Trigger:** make a legal move, then any number of illegal moves, then press Undo once.
- **Behaviour:** `snapshotForUndo` captures `invalids` at the time of the last committed move, and
  the undo branch restores it wholesale (`state.invalids = snap.invalids;`). Every invalid action
  taken since that move disappears. Scoring charges `-25` per invalid and only `-15` per undo
  (`js/rules.js:388-389`), so undoing is strictly cheaper than carrying two or more invalids, and
  the spec's "fewer invalid actions" tie-break can be laundered to zero.
- **Expected:** spec §2 lists invalid actions as a ranking criterion; an undo of a *move* should not
  rewrite the record of actions that were never applied to the board in the first place.
- **Evidence:**

  ```
  after move   : moves 1  invalids 0  undos 0
  after 5 bad  : moves 1  invalids 5   (invalidPenalty -125)
  after undo   : moves 0  invalids 0  undos 1   <- invalids erased
  ```

  Independently confirmed by the review model when shown only the two functions:
  "`state.invalids` is set to `snap.invalids` … Any prior invalid moves are discarded."

### 3. Dead conditional: undo always revives a terminal board

- **File:** `js/rules.js:345`
- **Trigger:** lose a board by `move-limit-exceeded` or `time-expired`, then press Undo.
- **Behaviour:** `state.status = snap.status === 'active' ? 'active' : 'active';` — both arms of the
  ternary are the same literal, so the snapshot's status is read and thrown away. The board always
  returns to `active`, `terminalReason` is cleared, and the undo branch returns without calling
  `checkTerminal`, so play resumes past a limit that has already been exceeded (the next command
  re-terminates it). The trailing comment "undo revives terminal boards" documents the *effect* but
  the expression that is supposed to control it does nothing.
- **Expected:** either `state.status = snap.status;`, or an unconditional assignment with the
  conditional removed. As written the intent is unrecoverable from the code.
- **Evidence:** `js/rules.js:345` as quoted. Confirmed by the review model shown only that line:
  "Both the true and false branches of the ternary yield `'active'`, so the conditional is a no-op."

### 4. Leaderboard ordering drops two of the four mandated tie-break criteria

- **File:** `server.js:199`
- **Trigger:** two ranked entries with the same score.
- **Behaviour:** `entries.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs)`. The
  invalid-action count — which *does* vary between the wins on a ranked board — is never compared,
  and the only tie-break actually in use, `durationMs`, is taken straight from the client
  (`server.js:194`) rather than from the replay. The stored entry records neither `invalids` nor a
  session identifier, so the ordering cannot be repaired at read time. (Objective completion is
  moot here: `ranked` requires `check.status === 'won'`, so every ranked entry is a win.)
- **Expected:** spec §2: "Ties use, in order: primary objective completion, fewer invalid actions,
  lower authoritative elapsed time, then stable session identifier."
- **Evidence:** `server.js:186-199`; the entry literal has `player, playerKey, score, seed,
  rulesetVersion, contentVersion, durationMs, assists, verified, at` — and nothing else.

## Suspected — not confirmed

### 1. `validateReplay` rebuilds the board from client-supplied geometry

- **File:** `js/session.js:148-152`
- **Concern:** the replay is re-created from `envelope.config.colors / tubeCount / capacity /
  limits` and `envelope.seed`, none of which is checked against the authoritative content record
  for `envelope.contentId`. A trivially easy board could be passed off as a hard journey stage.
- **Why unconfirmed:** because defect 1 already makes the score arbitrary, the additional leverage
  from a forged config could not be isolated, and `Rules.createState` does validate internal
  consistency (`validateLayout`), so an outright impossible board is refused.

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

- **`tests/e2e.mjs`**: no file of that name exists; `tests/browser-smoke.mjs` was run in its place
  and passed.
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
