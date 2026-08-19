'use strict';
/**
 * Engine tests for Spectrum Orbs (spec §9):
 *  - every legal action + invalid-action reason
 *  - scoring components, medals, terminal states, tie-breaks
 *  - serialization round-trip and v1->v2 migration
 *  - replay determinism (property): same version+seed+commands -> same hashes
 *  - fuzz malformed commands
 *  - catalogue validation: all shipped content solvable, no soft locks
 *  - golden sessions: easy / medium / terminal / interrupted-resumed
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Rng = require('../js/rng.js');

function mkState(overrides) {
  return Rules.createState(Object.assign({
    contentId: 'test', seed: 12345, colors: 3, tubeCount: 5, capacity: 4,
  }, overrides || {}));
}

// Authored near-win board for deterministic tests.
// 2 colors, cap 2, 3 tubes: [0] [1,0] [1].
// Legal: 1->0 (top 0 onto 0). Mismatch: 2->0. tube 1 is full.
function crafted() {
  return Rules.createState({
    contentId: 'crafted', seed: 1, colors: 2, tubeCount: 3, capacity: 2,
    stacks: [[0], [1, 0], [1]],
  });
}

test('createState produces valid serializable state', () => {
  const s = mkState();
  assert.equal(s.status, 'active');
  assert.equal(s.tick, 0);
  assert.equal(s.tubes.length, 5);
  const counts = {};
  for (const t of s.tubes) for (const c of t) counts[c] = (counts[c] || 0) + 1;
  assert.deepEqual(counts, { 0: 4, 1: 4, 2: 4 });
  assert.doesNotThrow(() => Rules.deserialize(Rules.serialize(s)));
});

test('canMove reports every invalid reason', () => {
  const s = crafted();
  assert.deepEqual(Rules.canMove(s, 0, 0), { ok: false, reason: 'same-tube' });
  assert.deepEqual(Rules.canMove(s, 5, 0), { ok: false, reason: 'out-of-bounds' });
  assert.deepEqual(Rules.canMove(s, 2, 0), { ok: false, reason: 'color-mismatch' });
  const emptySrc = Rules.createState({
    contentId: 'c2', seed: 1, colors: 2, tubeCount: 4, capacity: 2,
    stacks: [[0, 0], [1], [1], []],
  });
  assert.deepEqual(Rules.canMove(emptySrc, 3, 1), { ok: false, reason: 'empty-source' });
  assert.deepEqual(Rules.canMove(emptySrc, 1, 0), { ok: false, reason: 'target-full' });
  assert.equal(Rules.canMove(s, 1, 0).ok, true);
  // terminal
  const won = Rules.createState({
    contentId: 'c3', seed: 1, colors: 2, tubeCount: 3, capacity: 2,
    stacks: [[0, 0], [1, 1], []],
  });
  assert.equal(won.status, 'won');
  assert.equal(won.terminalReason, 'completed');
  assert.deepEqual(Rules.canMove(won, 0, 2), { ok: false, reason: 'terminal' });
});

test('legalActions only returns legal moves and matches canMove', () => {
  const s = mkState({ seed: 777 });
  const acts = Rules.legalActions(s);
  assert.ok(acts.length > 0);
  for (const a of acts) assert.equal(Rules.canMove(s, a.from, a.to).ok, true);
});

test('applyCommand move is deterministic and immutable', () => {
  const s = crafted();
  const before = Rules.serialize(s);
  const r = Rules.applyCommand(s, { type: 'move', from: 1, to: 0 });
  assert.equal(Rules.serialize(s), before, 'input state must not mutate');
  assert.equal(r.rejected, null);
  assert.equal(r.state.tick, 1);
  assert.equal(r.state.moves, 1);
  assert.deepEqual(r.state.tubes[0], [0, 0]);
  assert.ok(r.events.some((e) => e.type === 'move'));
});

test('invalid move increments invalids and tick, records reason', () => {
  const s = crafted();
  const r = Rules.applyCommand(s, { type: 'move', from: 2, to: 0 });
  assert.equal(r.rejected.reason, 'color-mismatch');
  assert.equal(r.state.invalids, 1);
  assert.equal(r.state.tick, 1);
  assert.equal(r.state.moves, 0);
  assert.equal(r.state.history[0].reason, 'color-mismatch');
});

test('undo restores exact prior board and preserves history', () => {
  const s = crafted();
  const m = Rules.applyCommand(s, { type: 'move', from: 1, to: 0 }).state;
  const u = Rules.applyCommand(m, { type: 'undo' });
  assert.equal(u.rejected, null);
  assert.deepEqual(u.state.tubes, s.tubes);
  assert.equal(u.state.moves, 0);
  assert.equal(u.state.undos, 1);
  assert.equal(u.state.history.length, 2, 'full history preserved');
  // undo with empty stack
  const u2 = Rules.applyCommand(u.state, { type: 'undo' });
  assert.equal(u2.rejected.reason, 'nothing-to-undo');
  // undo disabled by limits
  const locked = mkState();
  locked.limits.undo = false;
  const m2 = Rules.applyCommand(locked, { type: 'move', from: 0, to: 3 }).state;
  const u3 = Rules.applyCommand(m2, { type: 'undo' });
  assert.equal(u3.rejected.reason, 'undo-disabled');
});

test('undo revives a terminal board', () => {
  // move limit 1: first move (not a win) loses; undo must revive.
  const s = mkState({ seed: 42, limits: { moves: 1 } });
  const acts = Rules.legalActions(s);
  const r = Rules.applyCommand(s, { type: 'move', from: acts[0].from, to: acts[0].to }).state;
  assert.equal(r.status, 'lost');
  assert.equal(r.terminalReason, 'move-limit-exceeded');
  const u = Rules.applyCommand(r, { type: 'undo' }).state;
  assert.equal(u.status, 'active');
});

test('terminal: time-expired via tick-clock and concede', () => {
  const s = mkState({ limits: { timeMs: 1000 } });
  const r = Rules.applyCommand(s, { type: 'tick-clock', elapsedMs: 1500 }).state;
  assert.equal(r.status, 'lost');
  assert.equal(r.terminalReason, 'time-expired');
  const c = Rules.applyCommand(mkState(), { type: 'concede' }).state;
  assert.equal(c.status, 'lost');
  assert.equal(c.terminalReason, 'abandoned');
});

test('terminal: no-legal-moves soft lock detected', () => {
  // 2 colors cap 2, 2 tubes, no empty tube, unsorted -> deadlocked.
  const s = Rules.createState({
    contentId: 'lock', seed: 1, colors: 2, tubeCount: 2, capacity: 2,
    stacks: [[0, 1], [1, 0]],
  });
  assert.equal(s.status, 'lost');
  assert.equal(s.terminalReason, 'no-legal-moves');
});

test('win detection and completed reason', () => {
  let g = Rules.createState({
    contentId: 'w', seed: 1, colors: 2, tubeCount: 3, capacity: 2,
    stacks: [[0, 0], [1], [1]],
  });
  const r = Rules.applyCommand(g, { type: 'move', from: 1, to: 2 });
  assert.equal(r.state.status, 'won');
  assert.equal(r.state.terminalReason, 'completed');
  assert.ok(r.events.some((e) => e.type === 'won'));
  // moves on terminal board are rejected but logged
  const post = Rules.applyCommand(r.state, { type: 'move', from: 0, to: 2 });
  assert.equal(post.rejected.reason, 'terminal');
});

test('scoring: component breakdown, medals, clamped total', () => {
  let g = Rules.createState({
    contentId: 'w', seed: 1, colors: 2, tubeCount: 3, capacity: 2,
    stacks: [[0, 0], [1], [1]],
  });
  const won = Rules.applyCommand(g, { type: 'move', from: 1, to: 2 }).state;
  const sc = Rules.score(won, { gold: 1, silver: 2, bronze: 3, timeMs: 60000 });
  assert.equal(sc.won, true);
  assert.equal(sc.base, 1000);
  assert.equal(sc.medal, 'gold');
  assert.equal(sc.medalBonus, 500);
  assert.ok(sc.efficiency > 0);
  assert.equal(sc.total, Math.max(0, sc.base + sc.efficiency + sc.speed + sc.invalidPenalty + sc.undoPenalty + sc.medalBonus));

  const lost = Rules.score(mkState(), { gold: 1, silver: 2, bronze: 3 });
  assert.equal(lost.won, false);
  assert.equal(lost.base, 0);
  assert.equal(lost.medal, null);
});

test('tie-breaks: completion, invalids, elapsed, sessionId', () => {
  const base = { won: true, invalids: 0, elapsedMs: 1000, total: 100, sessionId: 'b' };
  assert.ok(Rules.compareResults(base, Object.assign({}, base, { won: false })) < 0);
  assert.ok(Rules.compareResults(base, Object.assign({}, base, { invalids: 1 })) < 0);
  assert.ok(Rules.compareResults(base, Object.assign({}, base, { elapsedMs: 2000 })) < 0);
  assert.ok(Rules.compareResults(base, Object.assign({}, base, { sessionId: 'a' })) > 0);
  assert.equal(Rules.compareResults(base, Object.assign({}, base)), 0);
});

test('serialization: round-trip and v1 migration', () => {
  const s = mkState({ seed: 99 });
  const back = Rules.deserialize(Rules.serialize(s));
  assert.equal(Rules.stateHash(back), Rules.stateHash(s));
  const v1 = JSON.parse(Rules.serialize(s));
  v1.version = 1;
  delete v1.invalids; delete v1.sessionId;
  const migrated = Rules.deserialize(JSON.stringify(v1));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.invalids, 0);
  assert.equal(migrated.sessionId, 'legacy');
  assert.throws(() => Rules.deserialize('{"version":99}'));
  assert.throws(() => Rules.deserialize('null'));
});

test('replay determinism (property): same seed + commands -> identical hashes', () => {
  for (let trial = 0; trial < 20; trial++) {
    const seed = 1000 + trial * 7;
    const colors = 3 + (trial % 5);
    const run = () => {
      let s = Rules.createState({ contentId: 'p', seed, colors, tubeCount: colors + 2, capacity: 4 });
      const rng = new Rng.RandomStream(seed, 'driver');
      const hashes = [Rules.stateHash(s)];
      for (let i = 0; i < 60 && s.status === 'active'; i++) {
        const acts = Rules.legalActions(s);
        if (!acts.length) break;
        const a = acts[rng.int(0, acts.length - 1)];
        s = Rules.applyCommand(s, { type: 'move', from: a.from, to: a.to, elapsedMs: i * 500 }).state;
        hashes.push(Rules.stateHash(s));
      }
      return hashes;
    };
    assert.deepEqual(run(), run(), 'trial ' + trial + ' must replay identically');
  }
});

test('fuzz: malformed commands never corrupt state or throw', () => {
  const s0 = mkState();
  const junk = [
    null, undefined, {}, { type: 42 }, { type: 'move' }, { type: 'move', from: 'a', to: {} },
    { type: 'move', from: -1, to: 99 }, { type: 'move', from: NaN, to: 0 },
    { type: 'undo', extra: 'x'.repeat(10000) }, { type: 'wat' }, { type: '' },
    { type: 'move', from: 0, to: 0 }, { type: 'tick-clock', elapsedMs: -5 },
    { type: 'move', from: 0.5, to: 1 }, { type: 'concede' },
  ];
  let s = s0;
  for (const cmd of junk) {
    let out;
    assert.doesNotThrow(() => { out = Rules.applyCommand(s, cmd); });
    if (out && out.state) {
      s = out.state;
      // Invariants after every command.
      const counts = {};
      for (const t of s.tubes) {
        assert.ok(t.length <= s.capacity, 'tube over capacity');
        for (const c of t) {
          assert.ok(Number.isInteger(c) && c >= 0 && c < s.colors, 'color in range');
          counts[c] = (counts[c] || 0) + 1;
        }
      }
      for (let c = 0; c < s.colors; c++) assert.equal(counts[c] || 0, s.capacity, 'orbs conserved');
      assert.ok(Number.isFinite(s.elapsedMs));
      assert.ok(s.tick >= 0);
    }
  }
});

test('generator: 200 random boards are solvable and non-trivial', () => {
  const rng = new Rng.RandomStream(0x6eed, 'gentest');
  for (let i = 0; i < 200; i++) {
    const colors = rng.int(2, 6);
    const spare = rng.int(1, 2);
    const capacity = rng.int(3, 5);
    const seed = rng.int(1, 1e9);
    const s = Rules.createState({ contentId: 'g', seed, colors, tubeCount: colors + spare, capacity });
    assert.equal(s.status, 'active', 'generated board must not start terminal (seed ' + seed + ')');
    assert.ok(Rules.solve(s, { maxNodes: 300000 }), 'generated board must be solvable (seed ' + seed + ')');
  }
});

test('hint uses legal actions and advances toward solution', () => {
  const s = mkState({ seed: 31415 });
  const h = Rules.hint(s);
  assert.ok(h, 'hint available on fresh board');
  assert.equal(Rules.canMove(s, h.from, h.to).ok, true, 'hint must be a legal action');
  const solved = Rules.solve(s, { maxNodes: 300000 });
  assert.ok(solved && solved.length > 0);
  if (h.certain) assert.deepEqual([h.from, h.to], [solved[0].from, solved[0].to]);
});

test('catalogue: all journey + challenge content validates', () => {
  const report = Content.validateCatalogue();
  const bad = Object.entries(report.levels).filter(([, r]) => !r.ok);
  assert.equal(bad.length, 0, 'invalid content: ' + JSON.stringify(bad.map(([id, r]) => [id, r.errors])));
  assert.equal(Content.JOURNEY.length, 40);
  assert.equal(Content.CHALLENGES.length, 5);
  assert.ok(Object.keys(Content.THEMES).length >= 5);
});

test('daily: deterministic per UTC day, valid, and distinct across days', () => {
  const a = Content.dailyForDate('2026-08-18');
  const a2 = Content.dailyForDate('2026-08-18');
  const b = Content.dailyForDate('2026-08-19');
  assert.deepEqual(a, a2);
  assert.notEqual(a.seed, b.seed);
  assert.ok(Content.validateLevel(a).ok, 'daily must validate: ' + JSON.stringify(Content.validateLevel(a).errors));
  assert.ok(Content.validateLevel(b).ok);
});

test('golden sessions: easy win, terminal loss, interrupted-resume', () => {
  // Easy golden: crafted 2-move win has a stable hash.
  let g = Rules.createState({
    contentId: 'golden-easy', seed: 1, colors: 2, tubeCount: 3, capacity: 2,
    stacks: [[0, 0], [1], [1]],
  });
  g = Rules.applyCommand(g, { type: 'move', from: 1, to: 2, elapsedMs: 500 }).state;
  assert.equal(g.status, 'won');
  assert.equal(Rules.stateHash(g), '4106da6e'); // golden hash — change only with intent

  // Terminal loss golden.
  let l = mkState({ seed: 42, limits: { moves: 1 } });
  const act = Rules.legalActions(l)[0];
  l = Rules.applyCommand(l, { type: 'move', from: act.from, to: act.to }).state;
  assert.equal(l.terminalReason, 'move-limit-exceeded');

  // Interrupted + resumed: serialize mid-game, resume, finish equivalently.
  let m = mkState({ seed: 2024 });
  const sol = Rules.solve(m, { maxNodes: 300000 });
  assert.ok(sol);
  const half = Math.floor(sol.length / 2);
  for (let i = 0; i < half; i++) {
    m = Rules.applyCommand(m, { type: 'move', from: sol[i].from, to: sol[i].to }).state;
  }
  const resumed = Rules.deserialize(Rules.serialize(m));
  assert.equal(Rules.stateHash(resumed), Rules.stateHash(m));
  for (let i = half; i < sol.length; i++) {
    m = Rules.applyCommand(m, { type: 'move', from: sol[i].from, to: sol[i].to }).state;
  }
  assert.equal(m.status, 'won');
});

test('content validators catch defective levels', () => {
  const bad = Object.assign({}, Content.JOURNEY[0], { id: 'bad', colors: 99 });
  assert.equal(Content.validateLevel(bad).ok, false);
  const badPar = Object.assign({}, Content.JOURNEY[0], { id: 'bad2', par: { gold: 5, silver: 4, bronze: 6 } });
  assert.equal(Content.validateLevel(badPar).ok, false);
});
