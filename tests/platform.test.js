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
      if (method === 'PUT') { save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(204); }
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
  assert.deepEqual(JSON.parse(put.body), { bindings: { hint: ['KeyJ'] } }, 'rebind persisted');

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
  const sh = SDK.create({ window: win('', 'spectrum-orbs.starhermit.com'), fetch: async () => res(500) });
  sh.init();
  const { Platform } = load(sh);
  assert.equal(new Platform().canSignIn(), true);
});
