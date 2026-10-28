// The save model (js/progress.js): the browser build's progression merge kept
// exactly, the engine save document and its two-device merge, the browser
// build's cloud slot (the checksummed progression JSON the JS SDK's saveJSON
// wrote) read as a foreign save, and its settings-KV preferences carried over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../js/progress.js');

const progA = () => Object.assign(P.defaultProgression(), {
  journey: { s1: { medal: 'bronze', score: 500 }, s2: { medal: 'gold', score: 900 } },
  challenges: { c1: { score: 300, won: true } },
  dailies: { '2026-10-01': { score: 100, won: true } },
  streak: { count: 2, lastDate: '2026-10-01' },
  achievements: { first_completion: '2026-10-01T00:00:00.000Z' },
  stats: { totalCompletions: 4, totalMoves: 80, practiceRounds: 1 }, updatedAt: 10,
});
const progB = () => Object.assign(P.defaultProgression(), {
  journey: { s1: { medal: 'gold', score: 800 } },
  challenges: { c1: { score: 200, won: true }, c2: { score: 50, won: true } },
  dailies: { '2026-10-02': { score: 120, won: true } },
  streak: { count: 3, lastDate: '2026-10-02' },
  achievements: { first_completion: '2026-09-30T00:00:00.000Z', tube_master: '2026-10-02T00:00:00.000Z' },
  stats: { totalCompletions: 6, totalMoves: 60, practiceRounds: 3 }, updatedAt: 20,
});

test('mergeProgression keeps the better side of every record', () => {
  const m = P.mergeProgression(progA(), progB());
  assert.deepEqual(Object.keys(m.journey).sort(), ['s1', 's2']);
  assert.equal(m.journey.s1.score, 800);
  assert.equal(m.challenges.c1.score, 300);
  assert.ok(m.challenges.c2 && m.dailies['2026-10-01'] && m.dailies['2026-10-02']);
  assert.deepEqual(m.streak, { count: 3, lastDate: '2026-10-02' });
  assert.equal(m.achievements.first_completion, '2026-09-30T00:00:00.000Z');
  assert.ok(m.achievements.tube_master);
  assert.deepEqual(m.stats, { totalCompletions: 6, totalMoves: 80, practiceRounds: 3 });
  assert.equal(m.updatedAt, 20);
});

test('engine save: fresh, migrate cleans, mergeDocs keeps both progressions and this device\'s preferences', () => {
  const f = P.fresh();
  assert.equal(f.v, 1);
  assert.deepEqual(f.settings, P.defaultSettings());
  assert.equal(P.migrate({ v: 2 }), null);
  const dirty = P.migrate({ v: 1, progression: progA(), settings: { palette: 'cvd', camera: 'nope', haptics: false, extra: 1 } });
  assert.equal(dirty.settings.palette, 'cvd');
  assert.equal(dirty.settings.camera, 'default');
  assert.equal(dirty.settings.haptics, false);
  assert.ok(!('extra' in dirty.settings));
  const remote = { v: 1, progression: progB(), settings: { ...P.defaultSettings(), palette: 'contrast' } };
  const local = { v: 1, progression: progA(), settings: { ...P.defaultSettings(), palette: 'cvd' } };
  const m = P.mergeDocs(remote, local);
  assert.equal(m.settings.palette, 'cvd');
  assert.equal(m.progression.journey.s1.score, 800);
  assert.ok(m.progression.journey.s2);
  assert.deepEqual(P.mergeDocs(remote, null).settings.palette, 'contrast');
  assert.deepEqual(P.mergeDocs(null, null), P.fresh());
});

test('the browser build\'s cloud save: checksummed progression JSON', () => {
  const doc = progA();
  doc.checksum = P.checksum(doc);
  const got = P.fromBrowserSave(JSON.stringify(doc));
  assert.equal(got.journey.s2.score, 900);
  assert.ok(!('checksum' in got));
  const unsummed = progB();
  assert.equal(P.fromBrowserSave(JSON.stringify(unsummed)).stats.totalCompletions, 6);
  const broken = { ...doc, checksum: 'deadbeef' };
  assert.equal(P.fromBrowserSave(JSON.stringify(broken)), null);
  assert.equal(P.fromBrowserSave('{"version":2}'), null);
  assert.equal(P.fromBrowserSave('not json'), null);
  assert.equal(P.fromBrowserSave(null), null);
});

test('the browser build\'s settings KV: the game\'s preferences carry over, every old key is removed', () => {
  const kv = { audio: { music: 0.4 }, graphics: { preset: 'high' }, palette: 'cvd', camera: 'wide', leftHanded: true, holdToSelect: 'yes',
    timingAssist: true, haptics: false, tutorialDone: true, reducedMotion: true, 'ui.language': { choice: 'de-DE' } };
  assert.deepEqual(P.legacyPreferences(kv), { palette: 'cvd', camera: 'wide', leftHanded: true, timingAssist: true, haptics: false, tutorialDone: true });
  for (const k of Object.keys(kv)) assert.ok(P.isBrowserKey(k), k);
  assert.ok(!P.isBrowserKey('somethingElse'));
});
