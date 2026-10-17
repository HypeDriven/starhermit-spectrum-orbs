/**
 * Platform adapter tests: js/platform.js over the shipped StarHermit SDK with
 * a stubbed fetch and launch fragment — token read/strip, profile nickname,
 * cloud-save round-trip on game:<slug>, settings KV (platform wins, then
 * mirrored), key bindings + rebind, read-only board, sign-out, and no
 * network at all standalone.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SDK = require('../starhermit-sdk.js');

const USER = 'abcdef12-3456-7890-abcd-ef1234567890';
const SLUG = 'spectrum-orbs-test';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = b64u({ alg: 'none' }) + '.' + b64u({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

function res(status, body) {
  const bytes = body instanceof Uint8Array ? body : null;
  const text = bytes || body == null ? '' : JSON.stringify(body);
  return {
    status, ok: status >= 200 && status < 300, statusText: String(status),
    text: async () => text, json: async () => JSON.parse(text),
    arrayBuffer: async () => (bytes || Buffer.from(text)).slice().buffer,
  };
}
function win(hash, hostname = 'localhost') {
  return {
    location: { hash, search: '', pathname: '/', hostname, href: 'http://' + hostname + '/' + hash },
    history: { state: null, replaceState(_s, _t, url) { this.last = url; } },
  };
}
function load(sh) {
  global.StarHermit = sh;
  for (const m of ['../js/platform.js', '../js/rng.js']) delete require.cache[require.resolve(m)];
  return require('../js/platform.js');
}
const DEFAULT_BINDINGS = { confirm: ['Enter', 'Space'], cancel: ['Escape'], undo: ['KeyU'] };

test('hosted: token, profile, cloud save, settings, controls, board, sign-out', async () => {
  mem.clear();
  const calls = [];
  let save = null;
  const kv = { palette: 'cvd', audio: { music: 0.1, effects: 0.2, ambience: 0.3, voice: 0.4, muted: true } };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET', path = url.split('?')[0];
    calls.push({ url, method, auth: init.headers.Authorization, body: init.body, keepalive: init.keepalive });
    if (path === `/api/v1/users/${USER}/profile`) return res(200, { username: 'orb_u', nickname: 'Prism' });
    if (path === '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG)) {
      if (method === 'PUT') { save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(200, { etag: '"v' + calls.length + '"' }); }
      return save ? res(200, new Uint8Array(save)) : res(404);
    }
    if (path === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') Object.assign(kv, JSON.parse(init.body).settings);
      return res(200, { settings: kv });
    }
    if (path === `/api/v1/games/${SLUG}/controls`) {
      if (method === 'PUT') return res(200, {});
      return res(200, { actions: [{ action: 'undo', codes: ['KeyZ'] }] });
    }
    if (path === `/api/v1/games/${SLUG}/leaderboards`) return res(200, [{ id: 'lb', key: 'score' }]);
    if (path === '/api/v1/leaderboards/lb/entries') return res(200, { items: [{ userId: USER, score: 77, rank: 1 }] });
    return res(404);
  };
  const w = win('#game_token=' + TOKEN);
  const sh = SDK.create({ window: w, fetch, setTimeout: () => 0, clearTimeout() {} });
  sh.init();
  const { Platform, DEFAULT_SETTINGS } = load(sh);
  const p = new Platform();
  assert.equal(w.history.last, '/', 'token stripped');
  assert.equal(p.hosted, true);
  assert.equal(p.gameScope, SLUG);
  assert.equal((await p.loadProfile()).name, 'Prism');

  // settings: no mirroring until the platform values are applied
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  p.saveSettings(settings);
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'local defaults never overwrite the platform');
  assert.equal(await p.loadRemoteSettings(settings, DEFAULT_BINDINGS), true);
  assert.equal(settings.palette, 'cvd', 'platform value wins');
  assert.equal(settings.audio.muted, true);
  assert.deepEqual(settings.bindings.undo, ['KeyZ'], 'platform binding applied');
  settings.largeText = true;
  p.saveSettings(settings);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(kv.largeText, true, 'settings PATCH');
  assert.ok(!('bindings' in kv) && !('version' in kv), 'bindings/version not in the KV');
  p.setControl('hint', ['KeyJ']);
  await new Promise((r) => setTimeout(r, 0));
  const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/controls'));
  // The SDK writes the full binding set (current platform bindings + the change).
  assert.deepEqual(JSON.parse(put.body), { bindings: { undo: ['KeyZ'], hint: ['KeyJ'] } }, 'rebind persisted');

  // cloud save round-trip
  const prog = p.loadProgression();
  prog.journey.l1 = { medal: 'gold' };
  await p.saveProgression(prog);
  await p.flushCloudSave();
  const cput = calls.find((c) => c.method === 'PUT' && c.url.includes('/cloud-saves/'));
  assert.ok(cput.url.endsWith('/cloud-saves/game%3A' + SLUG), 'slot game:<slug>');
  assert.equal(cput.keepalive, true);
  const r = await p.syncProgression({ updatedAt: 0 });
  assert.equal(r.source, 'cloud');
  assert.deepEqual(r.resolved.journey.l1, { medal: 'gold' }, 'cloud round-trip');

  const board = await p.leaderboard('platform', false);
  assert.deepEqual(board.entries.map((e) => [e.player, e.score]), [['Prism', 77]]);
  assert.ok(calls.every((c) => c.auth === 'Bearer ' + TOKEN), 'Bearer on every call');

  assert.ok(p.inviteLink().endsWith(`/game-invite/${USER}/${SLUG}`));
  assert.equal(p.canSignIn(), false);
  let out = 0;
  p.onSignedOut = () => out++;
  sh.signOut('expired');
  assert.equal(out, 1);
  assert.equal(p.hosted, false);
  assert.equal(p.inviteLink(), null);
});

test('standalone: local only, no fetch', async () => {
  mem.clear();
  const calls = [];
  const sh = SDK.create({ window: win(''), fetch: async (u) => { calls.push(u); return res(500); } });
  sh.init();
  const { Platform, DEFAULT_SETTINGS } = load(sh);
  const p = new Platform();
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  assert.equal(await p.loadRemoteSettings(settings, DEFAULT_BINDINGS), false);
  p.saveSettings(settings);
  p.setControl('undo', ['KeyZ']);
  p.resetControls();
  assert.equal(await p.loadProfile(), null);
  await p.saveProgression(p.loadProgression());
  await p.flushCloudSave();
  assert.equal((await p.syncProgression({ updatedAt: 0 })).source, 'local');
  assert.equal((await p.leaderboard('journey')).casual, true);
  assert.equal(p.canSignIn(), false);
  assert.equal(p.syncStatus(), 'offline');
  assert.equal(calls.length, 0);
});

test('on <id>.starhermit.com without a token: sign-in offered', () => {
  // canSignIn() is only true on a game's UUID host (<uuid>.starhermit.com).
  const sh = SDK.create({ window: win('', '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com'), fetch: async () => res(500) });
  sh.init();
  const { Platform } = load(sh);
  assert.equal(new Platform().canSignIn(), true);
});

test('mergeProgression keeps the better side of every record', () => {
  const { mergeProgression, defaultProgression } = load(SDK.create({ window: win(''), fetch: async () => res(500) }));
  const a = Object.assign(defaultProgression(), {
    journey: { s1: { medal: 'bronze', score: 500 }, s2: { medal: 'gold', score: 900 } },
    challenges: { c1: { score: 300, won: true } },
    dailies: { '2026-10-01': { score: 100, won: true } },
    streak: { count: 2, lastDate: '2026-10-01' },
    achievements: { first_completion: '2026-10-01T00:00:00.000Z' },
    stats: { totalCompletions: 4, totalMoves: 80, practiceRounds: 1 }, updatedAt: 10,
  });
  const b = Object.assign(defaultProgression(), {
    journey: { s1: { medal: 'gold', score: 800 } },
    challenges: { c1: { score: 200, won: true }, c2: { score: 50, won: true } },
    dailies: { '2026-10-02': { score: 120, won: true } },
    streak: { count: 3, lastDate: '2026-10-02' },
    achievements: { first_completion: '2026-09-30T00:00:00.000Z', tube_master: '2026-10-02T00:00:00.000Z' },
    stats: { totalCompletions: 6, totalMoves: 60, practiceRounds: 3 }, updatedAt: 20,
  });
  const m = mergeProgression(a, b);
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

test('save conflict: another device saved first → reload, merge, save the merge', async () => {
  mem.clear();
  const slot = '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG);
  const zipOf = async (doc) => {
    let bytes = null;
    const z = SDK.create({ window: win('#game_token=' + TOKEN), fetch: async (u, init = {}) => {
      if (init.method === 'PUT') { bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(200, { etag: '"z"' }); }
      return res(404);
    }, setTimeout: () => 0, clearTimeout() {} });
    z.init();
    await z.writeSave(JSON.stringify(doc));
    return bytes;
  };
  let stored = null, etag = null;
  const puts = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET', path = url.split('?')[0];
    if (path === slot + '/info') return res(200, { exists: !!stored, etag });
    if (path === slot && method === 'GET') return res(200, new Uint8Array(stored));
    if (path === slot && method === 'PUT') {
      const match = init.headers['If-Match'];
      puts.push(match || init.headers['If-None-Match']);
      if ((match && match !== etag) || (!match && stored)) return res(412, { error: 'precondition_failed' });
      stored = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
      etag = '"v' + puts.length + '"';
      return res(200, { etag });
    }
    return res(404);
  };
  const sh = SDK.create({ window: win('#game_token=' + TOKEN), fetch, setTimeout: () => 0, clearTimeout() {} });
  sh.init();
  const { Platform, defaultProgression, checksum } = load(sh);
  const p = new Platform();
  await p.syncProgression(p.loadProgression()); // empty slot: later writes are conditional
  let merged = null;
  p.onProgressionMerged = (doc) => { merged = doc; };
  const other = Object.assign(defaultProgression(), { journey: { s9: { medal: 'gold', score: 999 } }, updatedAt: 5 });
  other.checksum = checksum(other);
  stored = await zipOf(other);
  etag = '"other"';
  const mine = p.loadProgression();
  mine.journey.s1 = { medal: 'silver', score: 600 };
  await p.saveProgression(mine);
  await p.flushCloudSave();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(merged, 'conflict merged');
  assert.deepEqual(Object.keys(merged.journey).sort(), ['s1', 's9'], 'both devices kept');
  assert.equal(sh.saveConflicted(), false);
  await p.flushCloudSave();
  assert.equal(puts.at(-1), '"other"', 'the merge is written on top of the reloaded version');
  assert.equal(p.syncStatus(), 'synced');
});
