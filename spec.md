# Spectrum Orbs — Game Specification

**Status:** running specification of the shipped game (present tense).
**Genre:** ordering puzzle · **Players:** 1, with asynchronous score comparison
**Platform:** a StarHermit engine script game (TypeScript on the host API, engine 1.28.0, `engine.minor=30`), played natively by the StarHermit client and in browsers by the engine's web runtime; one package for both.
**Rendering:** `starhermit:scene` (a port of the three.js r160 gallery) with the whole interface on `starhermit:ui`.

## 1. Product vision

Spectrum Orbs is a game in which players move the top orb between tubes until each tube holds a single color. Its signature setting is a polished kinetic sculpture gallery. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Move the top orb between tubes until each tube holds a single color.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **select a stack, move its top object onto a legal stack, and consolidate colors**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Award three medals from par-move thresholds and preserve complete undo history. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.


## 3. Interaction and user-interface design

### Screens

- **Top bar** (every screen): the brand (a press goes home; mid-round the round is kept for Resume), ● Online / Offline, the sync badge (✓ Synced / … Saving…, signed in), the platform's UTC clock, the player's name (or Guest), Help (?) and Settings (⚙), which open over whatever is showing.
- **Title:** Play (the next unfinished Journey stage's setup, with "n / 40 stages"), Daily Challenge (starts today's board; "next board in m:ss"), All Modes, Learn to Play, Scores & Friends, Profile & Progress, Sign in with StarHermit (signed out), Invite a friend (signed in: copies the invite link), and **Resume unfinished round (name)** when an unfinished round's snapshot is on the device.
- **All Modes:** six cards — Journey, Daily, Practice, Challenge, Learn, Score Chase — with their blurbs and meta lines.
- **Setup:** Journey (the stage's facts: mode and players, duration, assists, colors / capacity / spares, the par medals, stage number, mastery and theme, the rules line with limits); Practice (Relaxed / Standard / Expert cards, the chosen one outlined; the unranked facts); Challenge (the five trials with their best scores; a card starts it). Begin and ← Back.
- **Game:** the Objective rail (level, moves, the move or time limit left, time, medal pace, the par bar, the mode note), the playfield (the 3D gallery; numbered tube labels over the tubes; the board-status chips — one button per tube listing its orbs' glyphs in colour; the lesson card in Learn), the Actions rail (Undo, Hint, Restart, Camera, Pause with their current keys; the reason an illegal move was refused). The countdown (3, 2, 1, Go; Go alone with reduced motion) shows as toasts.
- **Overlays:** Pause (Resume, Settings, Help, Restart board, Leave round), Results (the medal headline, the three medals, the score breakdown — completion, move efficiency, speed, medal bonus, invalid and undo penalties, time — the total, Journey progress or the Daily streak, new achievements, where the record went, the leaderboard post line; the recommended next step, Retry, Title), Settings and Help. Escape closes the top overlay (closing Pause resumes).
- **Scores & Friends:** a board select — Global (platform, signed in), Daily (today), Journey (all stages) and each challenge — Friends only on the platform board, and the table (#, player, score, seed, duration; phones: #, player, score). Local boards are this device's personal bests.
- **Profile & Progress:** the summary line, the guest note, the achievements and the Mastery track (40 stage cells with medals; unlocked ones start their stage).

### Layouts (by the window's logical size)

- **Wide desktop (≥ 1024 px):** rails beside the playfield (Objective 250 px left, Actions 210 px right; swapped with Left-handed controls).
- **Compact (< 1024 px):** the playfield fills the screen; ☰ and ⚙ at its top corners open the rails as drawers; the lesson card sits under the toggles.
- **Portrait phone (≤ 700 px wide):** the top bar takes two rows; a bottom tray carries Undo ↶, Hint 💡, Restart ⟳ and Pause.
- **Short landscape (≤ 500 px tall):** a narrow static Objective rail, the tray under the board, at most two rows of chips, the lesson card docked right.
- The camera fits the tube row (with the labels) into the playfield less the lesson card and the chip strip (a view offset), at every size; menus centre one column (scrolling when taller than the window).

### Controls

| Action | Keys (default) | Gamepad | Pointer / touch |
| --- | --- | --- | --- |
| Previous / next tube | ← ↑ / → ↓ | D-pad, left stick | — |
| Select / pour | Enter, Space | South (A) | tap a tube, its number or its chip |
| Cancel / close | Escape (deselects, else pauses) | East (B) | tap empty space deselects |
| Pause | P | Start | Pause button / tray |
| Undo · Hint · Restart | U · H · R | West · North · Select | rail buttons / tray |
| Reset camera | C | right stick press | Camera button |

Keys and pad buttons are rebound in the runtime's Options (Settings › Key bindings opens it). A tap is a press and release within 12 px and 600 ms (a drag is ignored); with **Hold to select**, pressing on a tube lifts it and the next tap pours. Focus moves among the HUD's buttons with Tab; Enter on a focused chip or label acts on that tube. A hidden window pauses the round's clock and resumes it on return ("Welcome back" after 30 s).

### Settings

The runtime's Options own music / effects / interface volume and mute, the sound limit, graphics quality and frame rate, language, text size, high contrast and reduced motion (Settings › Open Options). The game's own settings, kept in the save: **Camera** (Default / Close / Wide), **Color palette** (Default / Color-vision safe / High contrast), **Left-handed controls**, **Hold to select**, **Timing assist** (+50 % on time limits, declared in the record), **Haptics**, and **Replay tutorial**.

### Accessibility

Every tube is a button twice over: its number label ("Tube 3") and its chip ("Tube 3: Coral, Amber, …, 2 of 4[, selected]"), so screen readers, keyboards and play scripts reach the board without the 3D view. Colour is always reinforced by the glyph (● ▲ ■ ◆ ★ ⬟ ✚ ◐) on the orb and in the chip. Selections, pours, completed tubes, invalid reasons, hints, focus moves, undo and the round's end are announced. High contrast swaps the UI tokens; reduced motion skips the move arc, lift tweens, shake, parallax, sparks and ambient motion.

### Localization

Nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) for every string the client shows: `js/strings.js` (rows keyed by the English text; en-GB, es-ES and fr-CA list differences) through `js/lang.js`, the account strings in `js/sh-strings.js`. The locale is the runtime's interface language (Options › Language, else the account's or the device's); a change shows on the next frame without restarting a round.

## 4. Visual and audio design

### The gallery (render.ts)

The three.js r160 scene ported to `starhermit:scene`: the theme's sky and fog (14–42 m), a hemisphere fill, a warm key directional light with shadows and a cool rim (r160 physical intensities ÷ π, the engine's legacy units), the floor disc with its accent ring, a curved back wall of panels, and the tube row on a gentle arc — pedestal, open glass tube, rim and base disc, contact blob and a grounded marker ring per tube. Orbs are lacquered spheres carrying their glyph as a camera-facing sprite and a back-side halo for the selection. Selecting lifts the top orb 0.34 m with the halo and emission; legal targets' rings glow green, the hint's two tubes blue, an illegal target flashes red with a small shake. A pour plays the 0.42 s lift–travel–drop arc. Completed tubes burst sparks; a won round bursts from every tube. The camera (34° FOV, 40° pitch, Default / Close / Wide on critically damped springs) is fitted by projecting the row's corners and follows the pointer slightly (parallax).

### Graphics per quality tier (quality.ts: gfx.js's presets and budgets)

| Tier | Shading | Shadows | AO | Bloom / grade | AA | Reflections | Gallery detail | Particles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Low | Lambert, 16-seg orbs | off | off | off | MSAA | off | plain (5 panels) | off |
| Balanced | standard, 24 seg | 512 | off | on | FXAA | on | detailed: 9 panels, light strips, terrazzo 256, pool, 2 mobiles, motes | low (30 %) |
| High | physical (clearcoat, glass IOR), 32 seg | 1024 | on | on | SMAA | on | 11 panels, 3 mobiles | high |
| Ultra | physical, 48 seg | 2048 | high | on (full res) | MSAA | on | 13 panels, terrazzo 512, 5 mobiles | high |

Spark and mote counts scale within a tier by the runtime's level index (at most 2×). Reflections are `new RoomEnvironment(renderer)` filtered by PMREM (σ 0.04) as each lit material's envMap at its old envMapIntensity (glass 0.35, rims 0.6, pedestals 0.4, orbs 0.55, floor 0.12). Post effects are the runtime's: GTAO (radius 0.35, glass and markers excluded), bloom (0.5 / 0.4 / threshold 0.88), the old colour grade (S-curve 0.22, saturation 1.1, cool shadows / warm highlights, vignette 0.26) as a WGSL `renderer.post`, ACES at exposure 1.05. The terrazzo floor is the old procedural speckle baked offline (tools/bake-textures.mjs → assets/terrazzo-*.png). Auto, render scale, adaptive resolution and the frame-rate limit are the runtime's.

### Sound (audio.ts)

The authored one-shots (sfx/*.opus): focus, pick, drop, invalid, tube complete, win, lose, undo on the effects bus, the hint chime on the interface bus. During a round the theme's ambience (three slow-swelling sine pads at the theme's base frequency) loops on the music bus, and the adaptive music plays a sparse pentatonic pluck every 600 ms (density rising with the share of completed tubes) and a low drone every 16th beat, choices and ±6 % pitch variants from the level's seeded audio stream. Both are rendered once per theme into clips.

## 5. Technical architecture

- `js/rng.js`, `js/rules.js`, `js/content.js`, `js/session.js` — the browser build's pure rules, content, session (command log, undo, replay envelope, snapshot) — unchanged, shared with server.js and the Node tests, loaded with `loadClassic` (native/classic.ts).
- `js/progress.js` — the save model and migrations; `js/strings.js`, `js/lang.js`, `js/sh-strings.js` — strings.
- `native/main.ts` — the state machine, modes, input, timers, results; `screens.ts` — every screen on `starhermit:ui`; `render.ts` — the gallery; `audio.ts`; `platform.ts` — save, platform, boards; `quality.ts`; `style.ts` (assets/ui-style.json from tools/ui-style.css via `npm run css`); `i18n.ts`.
- **Determinism:** the runtime runs 60 fixed steps a second; the session's clock (`GameSession`'s `now`), the countdown, the 0.42 s pour resolution that locks input, the gameplay tweens, the timed boards' 250 ms clock check, the music beat and every timer advance on them. Slow frames never change a round; play scripts replay exactly.
- `index.html` and `starhermit-files.json` are the engine's web loader and file index (`npm run package`); `.starhermitignore` leaves tests, tools, server.js and docs out of the package.

## 6. StarHermit integration

- **Save:** the engine save (`saves`, schema 1) holds `{ v, progression, settings }`: the Journey records, challenge bests, dailies, streak, achievements and stats, plus the game's settings. It lives on the device and, signed in, in the account; a conflict merges both progressions record by record (the better score, the earliest achievement, the larger counts, the later streak) and keeps this device's settings. The browser build's cloud slot (the JS SDK's checksummed progression JSON) shows as a foreign save: it is merged in and replaced once (a broken checksum is refused, as before). Its settings-KV copies of the game's preferences are adopted once and every old key removed. Guests' old browser localStorage progress cannot migrate.
- **Device only:** the unfinished round's snapshot (Resume) and the personal-best boards (top 50 per board with seed, assists, duration, versions).
- **Scores:** a won Journey, Daily or Challenge round, signed in, posts its total to the high-score board through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores }`; the script range-checks it), then shows the rank. Practice and lessons are never posted. Achievements are recorded in the save.
- **Clock:** the Daily's UTC date and the top bar's clock use the platform's server time when it has answered, else the device's.
- **Account:** sign-in request, display name, invite link (copied to the clipboard), sign-out notice.
- `server.js` is a local development server (static files, the old replay-validating endpoints); it is not part of the package.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

The client captures no analytics; host-side measurement may cover tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage in aggregate. Never collect message content, drawings, voice, private board notes, or exact pointer trails.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Checks

- `npm run test:unit`: rules unit / property / fuzz / golden tests and the catalogue validators (tests/rules.test.js), the dev server (tests/server.test.js), the save model and migrations (tests/progress.test.mjs), localization coverage (tests/i18n.test.mjs).
- `npm run test:native` (tests/native.mjs): the web index is current, `tsc`, `starhermit check .` with zero warnings, and the play scripts in tests/native (generated by tools/gen-plays.mjs from the rules' solver): Journey 1 by keys and 2 by the tube labels with an illegal pour, an undo and a hint, both to their exact totals; the five lessons by finger on a DPR-3 phone; the timed Speedrun challenge by keys; the menus (Help, Settings with the palette and left-handed rails, Profile, Scores, Practice paused, left for the title, resumed from the snapshot, solved, then a board left from the pause panel); Practice on a DPR-3 landscape phone with the tray; today's Daily (written at test time).
- `npm run test:browser` (tools/browser-play.mjs): the packaged game in Chrome on the GPU at desktop, phone and landscape — Journey 1 by the labels, 2 by clicks on the 3D tubes with a pause, two lessons by finger, today's Daily by the chips — with no console errors.

## Known limitations

- The old canvas's rounded playfield corners and the overlays' backdrop blur are approximated (painted corners, a plain dim).
- The engine runs the colour grade before bloom (the old composer ran it after).
- The old Graphics panel's per-effect overrides and the in-game volume sliders are replaced by the runtime's Options (quality tiers, volumes); the voice and ambience buses are the runtime's interface and music buses.
- The synthesized fallback sounds the old build played while a sample decoded are not ported: a clip still loading is silent.
- Guests' progress in the old browser build's localStorage does not carry over; signed-in players' cloud progress does.
- Signed-in paths (cloud merge, foreign save, score posting, platform board) are covered by unit tests, not live-tested here.
- The left-handed option in the old build reordered the CSS grid in a way that misplaced the rails; here it swaps the Actions and Objective rails.
