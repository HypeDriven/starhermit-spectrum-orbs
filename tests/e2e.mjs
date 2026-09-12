/**
 * Spectrum Orbs — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play (Journey setup) → Begin → countdown → active board →
 *   the board is solved for REAL by clicking the on-screen accessible
 *   tube chips (#board-status button[data-tube]) — the same DOM input
 *   path the game wires to onTubePick (main.js:_bindGlobal) — until it
 *   reaches the results overlay ("Results", score breakdown, won). Then
 *   Next stage, plus pause/resume, undo, hint and restart through the
 *   visible controls. A second pass runs the load → Play → Begin →
 *   tap-a-few-tube chip flow on a mobile touch viewport.
 *
 * The game exposes a debug handle `window.SpectrumGame` and the rules
 * module `window.SpectrumRules` (main.js / rules.js). The test reads those
 * ONLY to observe round state and to ask the game's own solver which pair
 * of visible chips is the next legal move (the same legality knowledge the
 * player has). It never calls the game's move API — every move is a real
 * click/tap on the on-screen board chips or HUD buttons. No game code is
 * modified.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt). The game is fully playable offline — hosted
 * mode activates only when a launch token is present, and without one
 * (platform.js) every screen (journey, daily, practice, challenge, learn,
 * results) works locally, degrading to localStorage. So, per the test
 * conventions of the sibling titles (picture-logic/blockstead/balance-spire),
 * this test embeds a minimal node:http static server on an ephemeral port
 * and answers /api/* probes with 200 `{}` (the /api/v1/time sync then sees
 * no `now` and keeps the local clock), leaving zero console noise. If the UI
 * ever starts requiring the real backend this can be swapped for spawning
 * `server.js`; today it is not needed.
 *
 * Run: npm run test:e2e   (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/spectrum-orbs-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform adapter stays in its documented standalone mode without
    // console noise (platform.js: no launch token → hosted=false locally).
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the game's debug handle ----------

// window.SpectrumGame is the game's own debug/validation handle (main.js),
// window.SpectrumRules the pure rules module (rules.js). We read state and
// ask the solver for the next legal pair of chips only; every move is made
// by clicking the real on-screen board chips, never via the API.
const readState = (page) => page.evaluate(() => {
  const g = window.SpectrumGame;
  const s = g?.session?.state;
  if (!s) return null;
  return {
    fsm: g.fsm, mode: g.mode, status: s.status,
    moves: s.moves, undos: s.undos, invalids: s.invalids, hints: s.hintsUsed,
    tubes: s.tubes.map((t) => t.slice()),
    selected: g.selectedTube,
  };
});

const fullSolution = (page) => page.evaluate(() => {
  const s = window.SpectrumGame.session.state;
  const sol = window.SpectrumRules.solve(s, { maxNodes: 400000 });
  return sol ? sol.map((m) => ({ from: m.from, to: m.to })) : null;
});

const waitActive = (page) =>
  page.waitForFunction(() => window.SpectrumGame && window.SpectrumGame.fsm === 'active', null, { timeout: 20000 });

const tubeChip = (page, i) => page.locator(`#board-status button[data-tube="${i}"]`);

// Click a real on-screen tube chip to select/move, then wait for the
// resolution animation to release input lock before the next action.
async function pickTube(page, i) {
  await tubeChip(page, i).click();
  try {
    await page.waitForFunction(() => !window.SpectrumGame.inputLocked, null, { timeout: 4000 });
  } catch {
    /* move not locked in some paths (selection/invalid) — continue */
  }
}

// Solve the active board for real by clicking chips. The solver gives the
// full ordered sequence from the initial state; every move is a real click
// on the on-screen chips and must advance the move counter by exactly one.
async function solveToWin(page) {
  const sol = await fullSolution(page);
  if (!sol || !sol.length) throw new Error('solver returned no solution for the board');
  for (let i = 0; i < sol.length; i++) {
    const st = await readState(page);
    if (st.status === 'won') return st;
    if (st.status === 'lost') throw new Error('board lost while solving: ' + JSON.stringify(st));
    const { from, to } = sol[i];
    await pickTube(page, from);
    await pickTube(page, to);
    const stAfter = await readState(page);
    if (stAfter.moves !== st.moves + 1) {
      const reason = await page.evaluate(() => document.getElementById('invalid-reason').textContent);
      throw new Error(`move ${i} (${from}->${to}) not accepted (moves ${st.moves}->${stAfter.moves}; invalid-reason: "${reason}"); tubes=${JSON.stringify(stAfter.tubes)}`);
    }
  }
  const fin = await readState(page);
  if (fin.status !== 'won') throw new Error('board did not reach won after replay: ' + JSON.stringify(fin));
  return fin;
}

// Start Journey via the visible controls: title Play button → setup Begin.
async function startJourney(page) {
  await page.click('#screen-title [data-action="play-journey"]');
  await page.waitForFunction(() => window.SpectrumGame && window.SpectrumGame.fsm === 'setup', null, { timeout: 10000 });
  await page.click('#btn-begin');
  await waitActive(page);
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
    await page.waitForFunction(() => !!window.SpectrumGame && window.SpectrumGame.fsm === 'title');
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible ("${(await page.textContent('#title-heading')).trim()}")`);

    // Title → Journey setup → Begin → countdown → active board.
    await startJourney(page);
    const st0 = await readState(page);
    if (st0.mode !== 'journey') throw new Error('expected journey mode, got ' + st0.mode);
    if (st0.moves !== 0) throw new Error('new board should start at 0 moves, got ' + st0.moves);
    const chips = await page.locator('#board-status button[data-tube]').count();
    if (chips < st0.tubes.length) throw new Error(`expected ${st0.tubes.length} tube chips, got ${chips}`);
    await page.screenshot({ path: SHOT('play', name) });
    ok(`${name}: journey board active (${chips} tube chips, first tube ${st0.tubes[0].length} orbs)`);

    if (full) {
      // pause / resume via the visible controls before solving.
      await page.click('#rail-right [data-action="pause"]');
      await page.waitForFunction(() => window.SpectrumGame.fsm === 'paused' && !document.getElementById('screen-pause').hidden);
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#screen-pause [data-action="resume"]');
      await page.waitForFunction(() => window.SpectrumGame.fsm === 'active' && document.getElementById('screen-pause').hidden);
      await waitActive(page);
      ok(`${name}: pause (⏸) and resume work`);

      // solve the board for real on the visible chips → win + results.
      const won = await solveToWin(page);
      if (won.status !== 'won') throw new Error('board did not reach won: ' + won.status);
      await page.waitForFunction(() => window.SpectrumGame.fsm === 'results', null, { timeout: 8000 });
      await page.waitForSelector('#screen-results:not([hidden])');
      const headline = (await page.textContent('#results-headline')).trim();
      const total = (await page.textContent('#score-total')).trim();
      const rows = await page.locator('#score-rows tr').count();
      const wonFlag = await page.evaluate(() => window.SpectrumGame.session?.terminalResult?.won === true);
      if (!wonFlag) throw new Error(`results did not indicate a win (headline: "${headline}")`);
      if (!/flawless|sorted|settles|refine/i.test(headline)) throw new Error(`unexpected win headline: "${headline}"`);
      if (!total || total === '0') throw new Error('score total missing/zero: ' + total);
      if (rows < 1) throw new Error('score breakdown table is empty');
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: journey board solved on-screen — results ("${headline}", ${rows} rows, total ${total})`);

      // Next stage → a fresh active journey board.
      await page.click('#btn-results-next');
      await page.waitForFunction(() => {
        const f = window.SpectrumGame?.fsm;
        return f === 'active' || f === 'countdown';
      }, null, { timeout: 10000 });
      await waitActive(page);
      const stNext = await readState(page);
      if (stNext.moves !== 0) throw new Error('next stage should start at 0 moves');
      ok(`${name}: results → Next stage starts a fresh board (moves ${stNext.moves})`);

      // one legal move, then Undo restores it (visible controls).
      const undoSeq = await fullSolution(page);
      if (!undoSeq || !undoSeq.length) throw new Error('no move available on next stage for undo check');
      const first = undoSeq[0];
      await pickTube(page, first.from);
      await pickTube(page, first.to);
      const afterMove = await readState(page);
      if (afterMove.moves !== 1) throw new Error(`expected 1 move, got ${afterMove.moves}`);
      await page.click('#btn-undo');
      await page.waitForFunction(() => window.SpectrumGame.session.state.moves === 0, null, { timeout: 4000 });
      const afterUndo = await readState(page);
      if (afterUndo.undos !== 1) throw new Error(`expected 1 undo, got ${afterUndo.undos}`);
      ok(`${name}: make a move → Undo restores it (moves 1→0, undos ${afterUndo.undos})`);

      // Hint button reveals a suggestion (hintsUsed counter increments).
      await page.click('#btn-hint');
      await page.waitForFunction((n) => (window.SpectrumGame.session.state.hintsUsed ?? 0) > n, afterUndo.hints, { timeout: 4000 });
      const afterHint = await readState(page);
      if (afterHint.hints !== afterUndo.hints + 1) throw new Error(`hint counter wrong: ${afterUndo.hints} -> ${afterHint.hints}`);
      await page.screenshot({ path: SHOT('hint', name) });
      ok(`${name}: Hint button increments hints ${afterUndo.hints}→${afterHint.hints}`);

      // Restart resets the board to 0 moves from the visible Restart control.
      await page.click('#btn-restart');
      await waitActive(page);
      const afterRestart = await readState(page);
      if (afterRestart.moves !== 0) throw new Error(`restart did not reset moves: ${afterRestart.moves}`);
      ok(`${name}: Restart resets the board (moves ${afterRestart.moves})`);

      // Settings and Help overlays open and close (visible controls).
      await page.click('#topbar [data-action="settings"]');
      await page.waitForSelector('#screen-settings:not([hidden])');
      await page.click('#screen-settings [data-action="close-overlay"]');
      await page.click('#topbar [data-action="help"]');
      await page.waitForSelector('#screen-help:not([hidden])');
      const helpCards = await page.locator('#help-cards .card').count();
      await page.click('#screen-help [data-action="close-overlay"]');
      if (helpCards < 4) throw new Error('help cards missing: ' + helpCards);
      ok(`${name}: settings + help overlays open/close (${helpCards} rule cards)`);
    } else {
      // mobile: tap a few legal tube chips via touchscreen.tap and confirm
      // the engine registers real progress.
      let taps = 0;
      const mseq = await fullSolution(page);
      const movesForMobile = mseq ? mseq.slice(0, 3) : [];
      for (const m of movesForMobile) {
        const bb = await tubeChip(page, m.from).boundingBox();
        if (!bb || bb.width < 1 || bb.height < 1) throw new Error('tap target too small: ' + JSON.stringify(bb));
        await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForFunction(() => !window.SpectrumGame.inputLocked && window.SpectrumGame.selectedTube >= 0, null, { timeout: 4000 });
        const bb2 = await tubeChip(page, m.to).boundingBox();
        await page.touchscreen.tap(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
        await page.waitForFunction(() => !window.SpectrumGame.inputLocked, null, { timeout: 4000 });
        taps++;
      }
      const stFinal = await readState(page);
      if (stFinal.moves < 1) throw new Error(`expected >=1 move on mobile, got ${stFinal.moves}`);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started journey and made ${taps} real moves via touchscreen.tap`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — spectrum-orbs, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
