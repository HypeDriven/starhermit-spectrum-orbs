/**
 * browser-smoke.mjs — end-to-end smoke test driving headless Chrome over CDP
 * (no dependencies; Node 22 built-in WebSocket).
 *
 * Verifies: page boots without errors, title renders, journey setup starts a
 * round, moves apply through the same input path as pointer taps, undo works,
 * a solved board reaches the results screen, and screenshots are captured.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PORT = process.env.SMOKE_PORT || 8471;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 500);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader',
  '--window-size=1280,800', '--hide-scrollbars',
  `--user-data-dir=/tmp/so-chrome-${DEBUG_PORT}`,
  `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) { /* chrome still starting */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

let msgId = 0;
const pending = new Map();
let ws;
const consoleLog = [];
const errors = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expr, awaitPromise) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: !!awaitPromise, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}

async function screenshot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`/tmp/so-${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(`[smoke] screenshot: /tmp/so-${name}.png`);
}

async function main() {
  const target = await getTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLog.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === 'error') errors.push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION: ' + (d.exception && d.exception.description || d.text));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(4000);

  const webgl = await evaluate('!!window.SpectrumGame && window.SpectrumGame.renderer.webglOk');
  console.log('[smoke] webgl:', webgl);
  const fsm0 = await evaluate('window.SpectrumGame && window.SpectrumGame.fsm');
  console.log('[smoke] fsm after boot:', fsm0);
  if (fsm0 !== 'title') throw new Error('expected title, got ' + fsm0);
  await screenshot('title');

  // Title -> Journey setup -> Begin -> countdown -> active.
  await evaluate(`document.querySelector('[data-action="play-journey"]').click()`);
  await sleep(400);
  const fsm1 = await evaluate('window.SpectrumGame.fsm');
  if (fsm1 !== 'setup') throw new Error('expected setup, got ' + fsm1);
  await evaluate(`document.getElementById('btn-begin').click()`);
  await sleep(3500); // countdown
  const fsm2 = await evaluate('window.SpectrumGame.fsm');
  console.log('[smoke] fsm after begin:', fsm2);
  if (fsm2 !== 'active') throw new Error('expected active, got ' + fsm2);
  await sleep(800);
  await screenshot('game');

  // Play the board to a win through the real input path (onTubePick).
  const winInfo = await evaluate(`(async () => {
    const g = window.SpectrumGame;
    const R = window.SpectrumRules;
    const sol = R.solve(g.session.state, { maxNodes: 400000 });
    if (!sol) return { error: 'no solution' };
    for (const m of sol) {
      g.onTubePick(m.from);
      g.onTubePick(m.to);
      // wait for the resolution animation lock to release
      for (let i = 0; i < 100 && g.inputLocked; i++) await new Promise(r => setTimeout(r, 60));
    }
    return { status: g.session.state.status, moves: g.session.state.moves };
  })()`, true);
  console.log('[smoke] played to:', JSON.stringify(winInfo));
  if (winInfo.status !== 'won') throw new Error('board not won: ' + JSON.stringify(winInfo));
  await sleep(2500); // resolving -> results overlay
  const fsm3 = await evaluate('window.SpectrumGame.fsm');
  const resultsVisible = await evaluate(`!document.getElementById('screen-results').hidden`);
  console.log('[smoke] fsm:', fsm3, 'results visible:', resultsVisible);
  if (fsm3 !== 'results' || !resultsVisible) throw new Error('results screen not reached');
  const score = await evaluate(`document.getElementById('score-total').textContent`);
  console.log('[smoke] score shown:', score);
  const boardText = await evaluate(`document.getElementById('results-board-status').textContent`);
  console.log('[smoke] board status:', boardText);
  for (const line of consoleLog) if (line.includes('score-submit')) console.log('[smoke] console:', line);
  await screenshot('results');

  // Results -> Next stage.
  await evaluate(`document.querySelector('[data-action="results-next"]').click()`);
  await sleep(4000);
  const fsm4 = await evaluate('window.SpectrumGame.fsm');
  console.log('[smoke] after next:', fsm4);
  if (fsm4 !== 'active' && fsm4 !== 'countdown') throw new Error('next stage failed: ' + fsm4);

  // Undo path.
  const undoInfo = await evaluate(`(async () => {
    const g = window.SpectrumGame;
    const R = window.SpectrumRules;
    for (let i = 0; i < 100 && g.fsm !== 'active'; i++) await new Promise(r => setTimeout(r, 100));
    const acts = R.legalActions(g.session.state);
    g.onTubePick(acts[0].from); g.onTubePick(acts[0].to);
    for (let i = 0; i < 100 && g.inputLocked; i++) await new Promise(r => setTimeout(r, 60));
    const movesAfter = g.session.state.moves;
    g.doUndo();
    return { movesAfter, movesAfterUndo: g.session.state.moves, undos: g.session.state.undos };
  })()`, true);
  console.log('[smoke] undo:', JSON.stringify(undoInfo));
  if (undoInfo.movesAfter !== 1 || undoInfo.movesAfterUndo !== 0 || undoInfo.undos !== 1) {
    throw new Error('undo failed: ' + JSON.stringify(undoInfo));
  }

  // Keyboard focus + invalid action announcement.
  await evaluate(`window.SpectrumGame.moveKbFocus(1)`);
  const invalid = await evaluate(`(() => {
    const g = window.SpectrumGame;
    g.onTubePick(0); // select tube 1
    return { selected: g.selectedTube };
  })()`);
  console.log('[smoke] keyboard/select:', JSON.stringify(invalid));

  // Board mirror present and labeled.
  const mirror = await evaluate(`document.querySelectorAll('#board-status [data-tube]').length`);
  console.log('[smoke] board mirror chips:', mirror);
  if (!mirror) throw new Error('accessibility mirror empty');

  // Pause / resume overlay.
  await evaluate(`window.SpectrumGame.pause()`);
  await sleep(300);
  const pausedOk = await evaluate(`window.SpectrumGame.fsm === 'paused' && !document.getElementById('screen-pause').hidden`);
  if (!pausedOk) throw new Error('pause overlay failed');
  await evaluate(`window.SpectrumGame.resume()`);
  await sleep(300);
  const resumedOk = await evaluate(`window.SpectrumGame.fsm === 'active' && document.getElementById('screen-pause').hidden`);
  if (!resumedOk) throw new Error('resume failed');
  console.log('[smoke] pause/resume ok');

  // Settings + help overlays open and close with focus restoration.
  await evaluate(`document.querySelector('#topbar [data-action="settings"]').click()`);
  await sleep(200);
  const settingsOpen = await evaluate(`!document.getElementById('screen-settings').hidden`);
  if (!settingsOpen) throw new Error('settings did not open');
  await evaluate(`document.querySelector('#screen-settings [data-action="close-overlay"]').click()`);
  await evaluate(`document.querySelector('#topbar [data-action="help"]').click()`);
  await sleep(200);
  const helpCards = await evaluate(`document.querySelectorAll('#help-cards .card').length`);
  await evaluate(`document.querySelector('#screen-help [data-action="close-overlay"]').click()`);
  if (helpCards < 4) throw new Error('help cards missing: ' + helpCards);
  console.log('[smoke] settings + help ok (' + helpCards + ' rule cards)');

  // Leave round, then daily + practice + challenge entry points.
  await evaluate(`window.SpectrumGame.leaveRound()`);
  await sleep(2500);
  await evaluate(`window.SpectrumGame.closeToTitle()`);
  await sleep(300);
  await evaluate(`window.SpectrumGame.startDaily()`);
  await sleep(3500);
  const dailyOk = await evaluate(`window.SpectrumGame.fsm === 'active' && window.SpectrumGame.mode === 'daily' && window.SpectrumGame.session.state.status === 'active'`);
  if (!dailyOk) throw new Error('daily failed to start');
  console.log('[smoke] daily ok, tubes:', await evaluate(`window.SpectrumGame.session.state.tubes.length`));
  await screenshot('daily');
  await evaluate(`window.SpectrumGame.closeToTitle()`);
  await sleep(200);
  await evaluate(`window.SpectrumGame.setupPractice()`);
  await sleep(200);
  await evaluate(`document.getElementById('btn-begin').click()`);
  await sleep(3500);
  const pracOk = await evaluate(`window.SpectrumGame.fsm === 'active' && window.SpectrumGame.mode === 'practice'`);
  if (!pracOk) throw new Error('practice failed to start');
  console.log('[smoke] practice ok');
  await evaluate(`window.SpectrumGame.closeToTitle()`);
  await sleep(200);
  await evaluate(`window.SpectrumGame.setupChallenge()`);
  await sleep(200);
  await evaluate(`document.querySelectorAll('#setup-body .card')[0].click()`);
  await sleep(3500);
  const chalOk = await evaluate(`window.SpectrumGame.mode === 'challenge' && window.SpectrumGame.session.state.limits.moves === 30`);
  if (!chalOk) throw new Error('challenge failed to start with move limit');
  console.log('[smoke] challenge ok (move limit 30)');
  // Learn flow: lesson 1 expects a move; perform one and confirm lesson 2 starts.
  await evaluate(`window.SpectrumGame.closeToTitle()`);
  await sleep(200);
  await evaluate(`window.SpectrumGame.startLearn()`);
  await sleep(600);
  const learnOk = await evaluate(`window.SpectrumGame.mode === 'learn' && window.SpectrumGame.tutorialIndex === 0 && !document.getElementById('tutorial-card').hidden`);
  if (!learnOk) throw new Error('learn did not start');
  await evaluate(`(async()=>{const g=window.SpectrumGame;const R=window.SpectrumRules;
    const acts=R.legalActions(g.session.state);
    g.onTubePick(acts[0].from);g.onTubePick(acts[0].to);
    for(let i=0;i<100&&g.inputLocked;i++)await new Promise(r=>setTimeout(r,60));})()`, true);
  await sleep(1200);
  const lesson2 = await evaluate(`window.SpectrumGame.tutorialIndex`);
  if (lesson2 !== 1) throw new Error('tutorial did not advance: ' + lesson2);
  console.log('[smoke] learn lesson advance ok');
  await evaluate(`window.SpectrumGame.closeToTitle()`);

  const perf = await evaluate('window.SpectrumGame.renderer.debugInfo && JSON.stringify(window.SpectrumGame.renderer.debugInfo())');
  console.log('[smoke] render info:', perf);

  await screenshot('game2');

  const fatal = errors.filter((e) => !/favicon|Autoplay|WebGL.*fallback|GroupMarkerNotSet/i.test(e));
  console.log('[smoke] console errors:', fatal.length ? fatal : 'none');
  if (fatal.length) throw new Error('console errors: ' + fatal.join(' | '));
  console.log('[smoke] PASS');
}

main().catch((e) => { console.error('[smoke] FAIL:', e.message); process.exitCode = 1; })
  .finally(() => { chrome.kill('SIGKILL'); setTimeout(() => process.exit(), 500); });
