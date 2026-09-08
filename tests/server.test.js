'use strict';
/**
 * Server integration tests (spec §9 platform): time, daily immutability,
 * leaderboard validation (verified vs casual vs rejected), achievement
 * idempotency, save checksum enforcement, and static serving.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const { GameSession } = require('../js/session.js');

let serverProc;
let base;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-test-'));
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: '0', SPECTRUM_ORBS_DATA_DIR: dataDir }),
  });
  base = await new Promise((resolve, reject) => {
    let buf = '';
    serverProc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/listening on http:\/\/localhost:(\d+)/);
      if (m) resolve('http://localhost:' + m[1]);
    });
    serverProc.stderr.on('data', (d) => { buf += d; if (buf.includes('EADDRINUSE')) reject(new Error(buf)); });
    setTimeout(() => reject(new Error('server did not start: ' + buf)), 10000);
  });
});

test.after(() => {
  if (serverProc) serverProc.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function solveDaily(date) {
  const lv = Content.dailyForDate(date);
  const s = new GameSession(lv, { mode: 'daily' });
  const sol = Rules.solve(s.state, { maxNodes: 400000 });
  assert.ok(sol, 'daily must be solvable');
  for (const m of sol) {
    const r = s.move(m.from, m.to);
    assert.ok(r.accepted);
  }
  assert.equal(s.state.status, 'won');
  return s;
}

test('time endpoint returns server now', async () => {
  const r = await fetch(base + '/api/v1/time');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Math.abs(body.now - Date.now()) < 60000);
});

test('daily endpoint is deterministic and validated', async () => {
  const a = await (await fetch(base + '/api/v1/daily?date=2026-08-18')).json();
  const b = await (await fetch(base + '/api/v1/daily?date=2026-08-18')).json();
  assert.deepEqual(a, b);
  assert.equal(a.excluded, false);
});

test('static index and starhermit served', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /Spectrum Orbs/);
  const sh = await (await fetch(base + '/starhermit.txt')).text();
  assert.match(sh, /name=Spectrum Orbs/);
  assert.match(sh, /launch=index\.html/);
  assert.match(sh, /server=server\.js/);
  const trav = await fetch(base + '/../etc/passwd');
  assert.ok([400, 403, 404].includes(trav.status));
});

test('verified replay lands on ranked board; bogus claim is quarantined', async () => {
  const date = '2026-08-18';
  const s = solveDaily(date);
  const payload = {
    board: 'daily:' + date, score: s.terminalResult.total,
    rulesetVersion: Rules.RULESET_VERSION, contentVersion: Content.CONTENT_VERSION,
    seed: s.state.seed, assists: { hints: 0, undos: 0 },
    durationMs: Math.max(1000, s.terminalResult.elapsedMs),
    sessionId: s.state.sessionId, replay: s.replayEnvelope(), player: 'Tester',
  };
  const ok = await (await fetch(base + '/api/v1/leaderboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })).json();
  assert.equal(ok.stored, 'cloud');
  assert.equal(ok.verified, true);
  assert.equal(ok.casual, false);

  // Tampered replay rejected.
  const bad = JSON.parse(JSON.stringify(payload));
  bad.replay.commands[2] = Object.assign({}, bad.replay.commands[2], { from: 99 });
  const rej = await fetch(base + '/api/v1/leaderboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad),
  });
  assert.equal(rej.status, 400);
  assert.match((await rej.json()).error, /replay-invalid|bad-seed/);

  // No replay: stored casually, never on the ranked board.
  const noReplay = Object.assign({}, payload, { replay: null, score: payload.score + 500 });
  const casual = await (await fetch(base + '/api/v1/leaderboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noReplay),
  })).json();
  assert.equal(casual.casual, true);
  const ranked = await (await fetch(base + '/api/v1/leaderboard?board=' + encodeURIComponent('daily:' + date))).json();
  assert.equal(ranked.entries.length, 1, 'ranked board contains only verified entries');
  assert.equal(ranked.entries[0].score, payload.score);
  const casualBoard = await (await fetch(base + '/api/v1/leaderboard?board=' + encodeURIComponent('casual:daily:' + date))).json();
  assert.equal(casualBoard.entries.length, 1);

  // Stale content version rejected.
  const stale = Object.assign({}, payload, { contentVersion: 999 });
  const staleRes = await fetch(base + '/api/v1/leaderboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stale),
  });
  assert.equal(staleRes.status, 400);
  assert.equal((await staleRes.json()).error, 'stale-content-version');
});

test('achievements are idempotent and validated', async () => {
  const post = (key) => fetch(base + '/api/v1/achievement', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }).then((r) => r.json());
  assert.equal((await post('first_completion')).already, false);
  assert.equal((await post('first_completion')).already, true);
  const bad = await fetch(base + '/api/v1/achievement', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'not_real' }),
  });
  assert.equal(bad.status, 400);
});

test('save rejects bad checksums and forbidden fields', async () => {
  const bad = await fetch(base + '/api/v1/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: { version: 1, checksum: 'deadbeef', token: 'x' } }),
  });
  assert.equal(bad.status, 400);
});

test('replay validation rejects forged board geometry (config-mismatch)', async () => {
  const date = '2026-08-20';
  const s = solveDaily(date);
  const env = s.replayEnvelope();
  // Forged: claim the daily content id but rebuild from an easier board.
  const forged = JSON.parse(JSON.stringify(env));
  forged.config.colors = 2;
  forged.config.tubeCount = 4;
  const direct = GameSession.validateReplay(forged);
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'config-mismatch');
  // A forged seed is rejected too.
  const forgedSeed = JSON.parse(JSON.stringify(env));
  forgedSeed.seed = 12345;
  assert.equal(GameSession.validateReplay(forgedSeed).reason, 'config-mismatch');
  // Forged limits (a phantom generous clock) are rejected.
  const forgedLimits = JSON.parse(JSON.stringify(env));
  forgedLimits.config.limits = { moves: null, timeMs: 999999, undo: true };
  assert.equal(GameSession.validateReplay(forgedLimits).reason, 'config-mismatch');
  // End-to-end: the forged envelope never reaches the ranked board.
  const res = await fetch(base + '/api/v1/leaderboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board: 'daily:' + date, score: 5000,
      rulesetVersion: Rules.RULESET_VERSION, contentVersion: Content.CONTENT_VERSION,
      seed: forged.seed, assists: {}, durationMs: 1000, sessionId: 'x',
      replay: forged, player: 'Forger',
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /config-mismatch/);
});

test('timing-assist widened time limit still validates (declared assist)', () => {
  const lv = Content.levelById('challenge-speed');
  assert.ok(lv.limits && lv.limits.timeMs);
  const assisted = Object.assign({}, lv, { limits: { timeMs: Math.floor(lv.limits.timeMs * 1.5) } });
  const s = new GameSession(assisted, { mode: 'challenge' });
  const sol = Rules.solve(s.state, { maxNodes: 400000 });
  assert.ok(sol, 'challenge-speed must be solvable');
  for (const m of sol) assert.ok(s.move(m.from, m.to).accepted);
  assert.equal(s.state.status, 'won');
  const check = GameSession.validateReplay(s.replayEnvelope());
  assert.equal(check.ok, true, 'assisted replay must validate: ' + check.reason);
});

test('snapshot restore carries the authoritative clock forward', () => {
  let t = 1000000;
  const now = () => t;
  const lv = Content.dailyForDate('2026-08-21');
  const s = new GameSession(lv, { mode: 'daily', now });
  const first = Rules.legalActions(s.state)[0];
  assert.ok(s.move(first.from, first.to).accepted);
  t += 30000; // 30s of play with no command since the last move
  const snap = s.snapshot();
  const r = GameSession.restore(snap, { now });
  assert.ok(r.elapsedMs() >= 30000, 'elapsed must not rewind across restore, got ' + r.elapsedMs());
  t += 5000;
  assert.ok(r.elapsedMs() >= 35000);
  // The engine clock stays monotonic on the next command after restore.
  const next = Rules.legalActions(r.state)[0];
  assert.ok(r.move(next.from, next.to).accepted);
  assert.ok(r.state.elapsedMs >= 35000, 'state clock must not rewind, got ' + r.state.elapsedMs);
});

test('oversized payloads are refused', async () => {
  const big = await fetch(base + '/api/v1/telemetry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ event: 'x'.repeat(300000) }] }),
  });
  assert.ok([400, 413].includes(big.status));
});
