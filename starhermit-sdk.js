/* starhermit-sdk.js — canonical StarHermit client for browser games.
 * Canonical copy lives in tools/starhermit-sdk.js; each game ships a copy
 * (same as browser-guard.js). Do not edit a game's copy by hand — update the
 * canonical file and re-copy.
 *
 * Covers everything a game-scoped launch token may reach (wiki, 2026-10):
 *   launch:        #game_token=<jwt>[&session_id=<guid>]  (library / invite launch)
 *                  #access_token=<jwt>[&game_fragment=..]  (direct sign-in return)
 *   renewal:       POST /api/v1/games/{slug}/launch-token  (12 h from the original launch;
 *                  past that, or once expired, only the launcher can mint a new token)
 *   sign-in:       https://api.starhermit.com/api/v1/auth/games/{gameId}/sign-in?returnUrl=
 *   identity:      GET /api/v1/users/{id}/profile, /avatar ; GET /api/v1/me/friends
 *   game:          GET /api/v1/games/{slug}            (definition + caller stats)
 *   cloud save:    /api/v1/me/cloud-saves/game:{slug}  (+ /info; zip ≤10 MB, JSON {dataBase64})
 *   settings:      /api/v1/games/{slug}/settings[/key] (KV, 200 keys, 2 MB)
 *   controls:      /api/v1/games/{slug}/controls       (control.* lines in starhermit.txt)
 *   achievements:  GET /api/v1/games/{slug}/achievements, linked-achievements/{other}
 *   leaderboards:  GET /api/v1/games/{slug}/leaderboards, /api/v1/leaderboards/{id}/entries
 *   sessions:      sessions/mine, sessions/{id}, sessions/ai
 *   matchmaking:   queues, matchmaking (POST ?queues=, GET, DELETE)
 *   invites:       invites (POST {toUserId[, sessionId]}, GET), invites/{id}/accept|decline ; share link
 *                  (sessionId = invite into that running session; accept then joins it)
 *   replays:       replays/mine, replays/{id}
 *   gameplay WS:   /ws/v1/games?sessionId=&access_token=   ({type:'cmd',data})
 *   chat:          /api/v1/chat/conversations/{id}/messages (REST + polling only)
 *   voice:         /api/v1/voice/rooms… (REST; WebRTC signalling left to the game)
 *   realtime:      /api/v1/realtime/rooms… + /ws/v1/realtime?roomId=
 * Scores and achievement unlocks are written only by the game's server
 * (script result / container control message) — a client can never post them.
 *
 * Every method is safe standalone: with no token, calls resolve to null / []
 * and the game keeps its local behaviour. Browser global: window.StarHermit.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StarHermit = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var PUBLIC_API = 'https://api.starhermit.com';
  var HOST_SUFFIX = '.starhermit.com';

  function create(env) {
    env = env || {};
    var win = env.window || (typeof window !== 'undefined' ? window : null);
    var doFetch = env.fetch || (typeof fetch !== 'undefined' ? fetch.bind(root) : null);
    var WS = env.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    var now = env.now || function () { return Date.now(); };
    var setT = env.setTimeout || setTimeout;
    var clearT = env.clearTimeout || clearTimeout;

    var sh = {
      base: '',             // same-origin when platform-hosted; set for local dev
      token: null,
      claims: null,
      userId: null,
      slug: null,
      launchSessionId: null, // session_id from the launch fragment (invite accept)
      launchKind: null,      // 'launcher' (#game_token) or 'sign-in' (#access_token)
      launcherUrl: 'https://dashboard.starhermit.com/',
      inviteQuery: null,     // query string passed through a share link
      signedIn: false,
    };
    var listeners = {};
    var refreshTimer = null;
    var renewing = null;
    var profileCache = new Map();

    function emit(type, value) {
      var fns = listeners[type] || [];
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](value); } catch (e) { /* listener errors never break the SDK */ }
      }
    }
    sh.on = function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return function () { sh.off(type, fn); };
    };
    sh.off = function (type, fn) {
      var a = listeners[type] || [];
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };

    // ---------------- token ----------------
    function decodeJwt(t) {
      try {
        var seg = String(t).split('.')[1];
        var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
        b64 += '===='.slice(0, (4 - (b64.length % 4)) % 4);
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) { return null; }
    }
    sh.decodeJwt = decodeJwt;

    function hostSlug() {
      var h = win && win.location && win.location.hostname || '';
      return h.slice(-HOST_SUFFIX.length) === HOST_SUFFIX ? h.slice(0, -HOST_SUFFIX.length).split('.').pop() : null;
    }

    function setToken(t) {
      var c = t ? decodeJwt(t) : null;
      sh.token = t || null;
      sh.claims = c;
      sh.userId = c ? (c.sub || c.userId || c.uid || null) : null;
      sh.slug = (c && c.game_scope) || sh.slug || hostSlug();
      sh.signedIn = !!t;
      scheduleRefresh();
      emit('auth', { signedIn: sh.signedIn, userId: sh.userId });
    }
    sh.setToken = setToken;

    function signOut(reason) {
      if (refreshTimer) { clearT(refreshTimer); refreshTimer = null; }
      var was = sh.signedIn;
      sh.token = null; sh.claims = null; sh.userId = null; sh.signedIn = false;
      if (was) emit('auth', { signedIn: false, reason: reason || 'signed-out' });
    }
    sh.signOut = signOut;

    function readLaunch() {
      if (!win || !win.location) return null;
      var loc = win.location;
      var h = new URLSearchParams(String(loc.hash || '').replace(/^#/, ''));
      var t = h.get('game_token') || h.get('access_token');
      if (t) {
        sh.launchKind = h.get('game_token') ? 'launcher' : 'sign-in';
        sh.launchSessionId = h.get('session_id') || null;
        var restore = h.get('game_fragment');
        ['game_token', 'access_token', 'token_type', 'expires_in', 'session_id', 'game_fragment']
          .forEach(function (k) { h.delete(k); });
        var rest = restore != null ? restore : h.toString();
        try {
          win.history.replaceState(win.history.state, '', loc.pathname + loc.search + (rest ? '#' + rest : ''));
        } catch (e) { /* history may be unavailable */ }
      }
      var q = new URLSearchParams(loc.search || '');
      sh.inviteQuery = q.toString() || null;
      // Query-string token is a local-dev convenience only.
      return t || q.get('game_token') || null;
    }

    function scheduleRefresh() {
      if (refreshTimer) { clearT(refreshTimer); refreshTimer = null; }
      if (!sh.token || sh.autoRefresh === false) return;
      var exp = sh.claims && sh.claims.exp ? sh.claims.exp * 1000 : now() + 3600e3;
      var wait = Math.max(30e3, Math.min(exp - now() - 5 * 60e3, 45 * 60e3));
      refreshTimer = setT(function () { sh.refresh().catch(function () {}); }, wait);
    }

    /**
     * Re-mint the launch token (renewal chain); concurrent callers share one
     * request. Resolves 'renewed' (a fresh token is in place), 'retry' (network
     * or server error — the token may still be good, try again later) or
     * 'relaunch' (expired, refused, or past the 12 h chain: signed out, and only
     * the launcher or sign-in can mint a new token — see relaunch()).
     */
    function renew() {
      if (renewing) return renewing;
      if (!sh.token || !sh.slug) return Promise.resolve('relaunch');
      var exp = sh.claims && sh.claims.exp ? sh.claims.exp * 1000 : 0;
      // An expired token cannot authorize its own renewal.
      if (exp && exp <= now()) { signOut('expired'); return Promise.resolve('relaunch'); }
      renewing = raw('POST', gamePath('/launch-token')).then(function (res) {
        if (res.status === 401 || res.status === 403) { signOut('expired'); return 'relaunch'; }
        if (!res.ok) return 'retry';
        return res.json().then(function (j) {
          if (!j || !j.token) return 'retry';
          setToken(j.token);
          return 'renewed';
        }, function () { return 'retry'; });
      }, function () { return 'retry'; }).then(function (r) { renewing = null; return r; });
      return renewing;
    }
    /** Renew now; resolves the new token, or null (signed out when refused). */
    sh.refresh = function () {
      if (!sh.token || !sh.slug) return Promise.resolve(null);
      return renew().then(function (r) {
        if (r === 'retry') retryLater();
        return r === 'renewed' ? sh.token : null;
      });
    };
    /**
     * Call before reopening any socket the game manages itself (realtime, voice):
     * a failed reconnect may be an expired token — the handshake is refused
     * before the upgrade, so the browser reports only 1006 — and reopening the
     * same URL can never recover. On 'renewed' build the URL again; on 'retry'
     * back off and call this again; on 'relaunch' stop and offer relaunch().
     */
    sh.renewForReconnect = renew;
    function retryLater() {
      if (refreshTimer) clearT(refreshTimer);
      var exp = sh.claims && sh.claims.exp ? sh.claims.exp * 1000 : 0;
      if (exp && exp <= now()) { signOut('expired'); return; }
      refreshTimer = setT(function () { sh.refresh().catch(function () {}); }, 60e3);
    }

    /**
     * Send the player back for a fresh launch token once renewal is impossible:
     * through sign-in when the game was opened that way, otherwise to the
     * launcher (the StarHermit library). Inside the launcher's game frame this
     * navigates the top window, which browsers allow only from a user gesture —
     * call it from a click. Returns false when the navigation was refused.
     */
    sh.relaunch = function () {
      if (!win) return false;
      if (sh.launchKind === 'sign-in' && sh.signIn()) return true;
      var top = null;
      try { top = win.top; } catch (e) { top = null; }
      try {
        if (top && top !== win) top.location.href = sh.launcherUrl;
        else win.location.assign(sh.launcherUrl);
        return true;
      } catch (e) { return false; }
    };

    /** True when the game can offer a "Sign in with StarHermit" button. */
    sh.canSignIn = function () { return !sh.signedIn && !!(sh.gameId || hostSlug()); };
    /** Redirect through StarHermit sign-in; returns with #access_token. */
    sh.signIn = function () {
      var id = sh.gameId || hostSlug();
      if (!id || !win) return false;
      var url = new URL('/api/v1/auth/games/' + encodeURIComponent(id) + '/sign-in', PUBLIC_API);
      url.searchParams.set('returnUrl', win.location.href);
      win.location.assign(url.href);
      return true;
    };

    /**
     * Read the launch token and start renewal. Options: { base, gameId, autoRefresh, launcherUrl }.
     * gameId is only needed for sign-in when not served from <id>.starhermit.com.
     * autoRefresh:false leaves renewal to a game that runs its own chain.
     */
    sh.init = function (opts) {
      opts = opts || {};
      if (opts.autoRefresh === false) sh.autoRefresh = false;
      if (opts.launcherUrl) sh.launcherUrl = String(opts.launcherUrl);
      if (opts.base != null) sh.base = String(opts.base).replace(/\/+$/, '');
      if (opts.gameId) sh.gameId = opts.gameId;
      var t = readLaunch();
      if (t) setToken(t); else sh.slug = sh.slug || hostSlug();
      return sh;
    };

    // ---------------- REST ----------------
    function gamePath(suffix) { return '/api/v1/games/' + encodeURIComponent(sh.slug) + (suffix || ''); }
    sh.gamePath = gamePath;

    function raw(method, path, body, extra) {
      var headers = {};
      if (sh.token) headers.Authorization = 'Bearer ' + sh.token;
      var init = { method: method, headers: headers };
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      if (extra && extra.keepalive) init.keepalive = true;
      return doFetch(sh.base + path, init);
    }

    /**
     * Authenticated JSON call. Resolves null when signed out, on 404 and on
     * 204; rejects {status,message} on other failures. A 401 triggers one
     * renewal attempt and a retry.
     */
    sh.api = function (path, opts) {
      opts = opts || {};
      if (!sh.token) return Promise.resolve(null);
      var method = opts.method || 'GET';
      function attempt(retried) {
        return raw(method, path, opts.body, opts).then(function (res) {
          if (res.status === 401 && !retried) {
            return sh.refresh().then(function (t) {
              if (t) return attempt(true);
              throw { status: 401, message: 'Not signed in' };
            });
          }
          if (res.status === 204 || res.status === 404) return null;
          if (opts.blob && res.ok) return res.blob();
          if (opts.bytes && res.ok) return res.arrayBuffer().then(function (b) { return new Uint8Array(b); });
          return res.text().then(function (txt) {
            var j = null;
            try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
            if (!res.ok) throw { status: res.status, message: (j && (j.error || j.message || j.title)) || res.statusText, body: j };
            return j;
          });
        });
      }
      return attempt(false);
    };
    function soft(p, fallback) { return p.then(function (v) { return v == null ? fallback : v; }, function () { return fallback; }); }
    function g(suffix, fallback) { return soft(sh.api(gamePath(suffix)), fallback); }

    // ---------------- identity ----------------
    sh.getGame = function () { return g('', null); };

    /** { userId, username, nickname, displayName } — nickname first (wiki convention). */
    sh.profile = function (userId) {
      userId = userId || sh.userId;
      if (!userId || !sh.token) return Promise.resolve(null);
      if (profileCache.has(userId)) return profileCache.get(userId);
      var p = soft(sh.api('/api/v1/users/' + encodeURIComponent(userId) + '/profile'), null).then(function (j) {
        var nick = j && (j.nickname || j.displayName) || '';
        return {
          userId: userId,
          username: j && j.username || null,
          nickname: nick || null,
          displayName: nick || ('Player ' + String(userId).slice(0, 6)),
        };
      });
      profileCache.set(userId, p);
      return p;
    };
    /** Object URL for a user's avatar PNG, or null. */
    sh.avatarUrl = function (userId) {
      userId = userId || sh.userId;
      if (!userId) return Promise.resolve(null);
      return soft(sh.api('/api/v1/users/' + encodeURIComponent(userId) + '/avatar', { blob: true }), null)
        .then(function (b) { return b && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(b) : null; });
    };
    /** [{ userId, username, online, currentGame }] */
    sh.friends = function () { return soft(sh.api('/api/v1/me/friends'), []); };
    /** Share link that friends the recipient and sends a play invite back. */
    sh.inviteLink = function (query) {
      if (!sh.userId || !sh.slug) return null;
      var q = query ? (typeof query === 'string' ? query.replace(/^\?/, '') : new URLSearchParams(query).toString()) : '';
      return 'https://dashboard.starhermit.com/game-invite/' + encodeURIComponent(sh.userId) + '/' +
        encodeURIComponent(sh.slug) + (q ? '?' + q : '');
    };

    // ---------------- cloud save (zip slot) ----------------
    var CRC = (function () {
      var t = new Uint32Array(256);
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      return t;
    })();
    function crc32(b) { var c = 0xffffffff; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
    function zip(name, data) {
      var nm = new TextEncoder().encode(name), crc = crc32(data), out = [];
      function u16(a, v) { a.push(v & 0xff, (v >> 8) & 0xff); }
      function u32(a, v) { a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
      var lh = []; u32(lh, 0x04034b50); u16(lh, 20); u16(lh, 0); u16(lh, 0); u16(lh, 0); u16(lh, 0);
      u32(lh, crc); u32(lh, data.length); u32(lh, data.length); u16(lh, nm.length); u16(lh, 0);
      var cd = []; u32(cd, 0x02014b50); u16(cd, 20); u16(cd, 20); u16(cd, 0); u16(cd, 0); u16(cd, 0); u16(cd, 0);
      u32(cd, crc); u32(cd, data.length); u32(cd, data.length); u16(cd, nm.length);
      u16(cd, 0); u16(cd, 0); u16(cd, 0); u16(cd, 0); u32(cd, 0); u32(cd, 0);
      var cdOff = lh.length + nm.length + data.length;
      var ed = []; u32(ed, 0x06054b50); u16(ed, 0); u16(ed, 0); u16(ed, 1); u16(ed, 1);
      u32(ed, cd.length + nm.length); u32(ed, cdOff); u16(ed, 0);
      var parts = [new Uint8Array(lh), nm, data, new Uint8Array(cd), nm, new Uint8Array(ed)];
      var len = 0; parts.forEach(function (p) { len += p.length; });
      var buf = new Uint8Array(len), o = 0;
      parts.forEach(function (p) { buf.set(p, o); o += p.length; });
      return buf;
    }
    function unzip(b) {
      var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (b.length < 30 || dv.getUint32(0, true) !== 0x04034b50) return Promise.reject(new Error('bad zip'));
      var method = dv.getUint16(8, true), size = dv.getUint32(18, true);
      var start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
      if (method === 0) return Promise.resolve(b.slice(start, start + size));
      if (method === 8 && typeof DecompressionStream !== 'undefined') {
        var stream = new Blob([b.slice(start, start + size)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (a) { return new Uint8Array(a); });
      }
      return Promise.reject(new Error('unsupported zip entry'));
    }
    function b64(bytes) {
      var s = '';
      for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    sh._zip = zip; sh._unzip = unzip;

    function savePath() { return '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + sh.slug); }
    /** { exists, sizeBytes, updatedAt } or null. */
    sh.saveInfo = function () { return sh.slug ? soft(sh.api(savePath() + '/info'), null) : Promise.resolve(null); };
    // 'unknown' until the first read, then 'ok' or 'failed'. A failed read is
    // not an empty slot, so writes stay blocked until the slot is known.
    var saveLoad = 'unknown';
    /** The saved string (null when none / signed out). Checks /info first so an
     *  empty slot never produces a 404 in the console. A network/server error
     *  also resolves null, but sets saveLoadFailed() and emits 'saveerror'. */
    sh.loadSave = function () {
      if (!sh.slug || !sh.token) return Promise.resolve(null);
      return sh.api(savePath() + '/info').then(function (info) {
        // The platform answers {exists:false} for an empty slot; only an
        // unexpected missing /info falls through to the direct read.
        if (info && info.exists === false) return null;
        return sh.api(savePath(), { bytes: true });
      }).then(function (bytes) {
        return bytes ? unzip(bytes).then(function (d) { return new TextDecoder().decode(d); }) : null;
      }).then(function (text) {
        saveLoad = 'ok';
        return text;
      }, function () {
        saveLoad = 'failed';
        emit('saveerror', { op: 'load' });
        return null;
      });
    };
    /** True when the last cloud-save read failed (as opposed to an empty slot). */
    sh.saveLoadFailed = function () { return saveLoad === 'failed'; };
    /**
     * Write the save slot (string; last write wins). Resolves true on success.
     * After a failed read, a write goes through only once /info confirms the
     * slot is empty; otherwise it resolves false (emits 'saved' false and
     * 'saveerror'), so a stale local copy never overwrites a newer cloud save
     * the game could not see. A later successful loadSave() lifts the block.
     */
    sh.writeSave = function (text, opts) {
      if (!sh.token || !sh.slug) return Promise.resolve(false);
      if (saveLoad === 'failed') {
        return sh.api(savePath() + '/info').then(function (info) {
          return !!(info && info.exists === false);
        }, function () { return false; }).then(function (empty) {
          if (empty) { saveLoad = 'ok'; return sh.writeSave(text, opts); }
          emit('saveerror', { op: 'write', blocked: true });
          emit('saved', false);
          return false;
        });
      }
      var data = zip('save.json', new TextEncoder().encode(String(text)));
      return sh.api(savePath(), { method: 'PUT', body: { dataBase64: b64(data) }, keepalive: opts && opts.keepalive })
        .then(function () { emit('saved', true); return true; }, function () { emit('saved', false); return false; });
    };
    sh.loadJSON = function () { return sh.loadSave().then(function (t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }); };
    var saveTimer = null, pending = null;
    /** Debounced JSON save at checkpoints; flushSave() forces it (e.g. on pagehide). */
    sh.saveJSON = function (obj, delayMs) {
      pending = JSON.stringify(obj);
      if (saveTimer) clearT(saveTimer);
      saveTimer = setT(sh.flushSave, delayMs == null ? 2000 : delayMs);
    };
    sh.flushSave = function (keepalive) {
      if (saveTimer) { clearT(saveTimer); saveTimer = null; }
      if (pending == null) return Promise.resolve(false);
      var t = pending; pending = null;
      return sh.writeSave(t, { keepalive: keepalive === true });
    };

    // ---------------- per-player settings (KV) ----------------
    sh.getSettings = function () { return g('/settings', null).then(function (j) { return j && j.settings || {}; }); };
    sh.getSetting = function (key) { return g('/settings/' + encodeURIComponent(key), null).then(function (j) { return j ? j.value : undefined; }); };
    sh.setSetting = function (key, value) { return soft(sh.api(gamePath('/settings/' + encodeURIComponent(key)), { method: 'PUT', body: { value: value } }), null); };
    /** Merge; a null value removes the key. */
    sh.patchSettings = function (obj) { return soft(sh.api(gamePath('/settings'), { method: 'PATCH', body: { settings: obj } }), null); };
    sh.deleteSetting = function (key) { return soft(sh.api(gamePath('/settings/' + encodeURIComponent(key)), { method: 'DELETE' }), null); };
    sh.clearSettings = function () { return soft(sh.api(gamePath('/settings'), { method: 'DELETE' }), null); };

    // ---------------- controls ----------------
    /** [{ action, label, defaultCodes, codes }] or [] (fall back to the game's own defaults). */
    sh.getControls = function () { return g('/controls', null).then(function (j) { return j && (j.actions || j) || []; }); };
    sh.setControl = function (action, codes) {
      var b = {}; b[action] = codes;
      return sh.api(gamePath('/controls'), { method: 'PUT', body: { bindings: b } });
    };
    sh.setControls = function (bindings) { return sh.api(gamePath('/controls'), { method: 'PUT', body: { bindings: bindings } }); };
    sh.resetControls = function () { return soft(sh.api(gamePath('/controls'), { method: 'DELETE' }), null); };
    /**
     * Resolve the player's bindings: defaults is { action: ['KeyA', ...] }.
     * Returns { action: codes[] } with the platform's overrides applied.
     */
    sh.loadBindings = function (defaults) {
      return sh.getControls().then(function (list) {
        var out = {};
        Object.keys(defaults || {}).forEach(function (k) { out[k] = defaults[k].slice(); });
        (list || []).forEach(function (a) { if (a && a.action && Array.isArray(a.codes) && a.codes.length) out[a.action] = a.codes.slice(); });
        return out;
      });
    };

    // ---------------- achievements & leaderboards ----------------
    sh.achievements = function () { return g('/achievements', []); };
    sh.linkedAchievements = function (otherSlug) { return g('/linked-achievements/' + encodeURIComponent(otherSlug), []); };
    sh.leaderboards = function () { return g('/leaderboards', []); };
    /** { items:[{userId,username,score,rank,...}], total, page, pageSize } */
    sh.leaderboardEntries = function (boardId, opts) {
      opts = opts || {};
      var q = new URLSearchParams({ page: String(opts.page || 1), pageSize: String(opts.pageSize || 10) });
      if (opts.scope) q.set('scope', opts.scope);
      if (opts.region) q.set('region', opts.region);
      return soft(sh.api('/api/v1/leaderboards/' + encodeURIComponent(boardId) + '/entries?' + q), { items: [], total: 0 });
    };
    /** Entries of the board with this key (or the first board). */
    sh.leaderboard = function (key, opts) {
      return sh.leaderboards().then(function (boards) {
        var b = (boards || []).filter(function (x) { return !key || x.key === key; })[0];
        return b ? sh.leaderboardEntries(b.id, opts).then(function (r) { r.board = b; return r; }) : { items: [], total: 0, board: null };
      });
    };

    // ---------------- sessions, matchmaking, invites, replays ----------------
    sh.mySessions = function () { return g('/sessions/mine', []); };
    sh.getSession = function (id) { return g('/sessions/' + encodeURIComponent(id), null); };
    /** Practice session vs "The House": { sessionId }. */
    sh.startAiSession = function () { return sh.api(gamePath('/sessions/ai'), { method: 'POST' }); };
    sh.queues = function () { return g('/queues', []); };
    sh.joinQueue = function (queues) {
      var q = (queues || []).map(function (k) { return 'queues=' + encodeURIComponent(k); }).join('&');
      return sh.api(gamePath('/matchmaking' + (q ? '?' + q : '')), { method: 'POST' });
    };
    sh.matchStatus = function () { return g('/matchmaking', null); };
    sh.cancelMatch = function () { return soft(sh.api(gamePath('/matchmaking'), { method: 'DELETE' }), null); };
    /** Poll the ticket until matched/cancelled/expired; resolves the final ticket. */
    sh.waitForMatch = function (opts) {
      opts = opts || {};
      var every = opts.intervalMs || 2000, stopped = false;
      var p = new Promise(function (resolve) {
        (function tick() {
          if (stopped) return resolve(null);
          sh.matchStatus().then(function (t) {
            if (opts.onTick && t) opts.onTick(t);
            if (!t || t.status !== 'queued') return resolve(t);
            setT(tick, every);
          }, function () { setT(tick, every); });
        })();
      });
      p.stop = function () { stopped = true; };
      return p;
    };
    // With a sessionId the friend is invited into that running session (one you are playing in);
    // accepting admits them to it, if the game takes players mid-match. Without one, accepting
    // starts a new session for the two of you.
    sh.sendInvite = function (toUserId, sessionId) {
      var body = { toUserId: toUserId };
      if (sessionId) body.sessionId = sessionId;
      return sh.api(gamePath('/invites'), { method: 'POST', body: body });
    };
    sh.invites = function () { return g('/invites', { incoming: [], outgoing: [] }); };
    sh.acceptInvite = function (id) { return sh.api(gamePath('/invites/' + encodeURIComponent(id) + '/accept'), { method: 'POST' }); };
    sh.declineInvite = function (id) { return soft(sh.api(gamePath('/invites/' + encodeURIComponent(id) + '/decline'), { method: 'POST' }), null); };
    /**
     * Post a finished run's results to the game's leaderboards: { boardKey: number }.
     * Opens a practice session and sends {type:'result', scores} to the game's
     * score script (tools/score-script.js), which range-checks and posts them.
     * Resolves the accepted board keys ([] when signed out or on failure); emits
     * 'scores' with the same list. Never rejects.
     */
    sh.submitScores = function (scores, opts) {
      opts = opts || {};
      if (!sh.token || !sh.slug || !WS || !scores) return Promise.resolve([]);
      return sh.startAiSession().then(function (s) {
        if (!s || !s.sessionId) return [];
        return new Promise(function (resolve) {
          var done = false, conn, timer;
          function finish(list) {
            if (done) return;
            done = true; clearT(timer);
            if (conn) conn.close();
            emit('scores', list);
            resolve(list);
          }
          timer = setT(function () { finish([]); }, opts.timeoutMs || 15000);
          conn = sh.connect(s.sessionId, {
            onOpen: function () { conn.send({ type: 'result', scores: scores }); },
            onGame: function (d) { if (d && d.type === 'result-ack') finish(d.accepted || []); },
            onError: function () { finish([]); },
            onAbandoned: function () { finish([]); },
            onAuthLost: function () { finish([]); },
          });
        });
      }, function () { emit('scores', []); return []; });
    };
    sh.myReplays = function (limit) { return g('/replays/mine?limit=' + (limit || 10), []); };
    sh.getReplay = function (id) { return g('/replays/' + encodeURIComponent(id), null); };

    // ---------------- WebSockets ----------------
    function wsUrl(path, params) {
      var origin = sh.base || (win && win.location ? win.location.origin : PUBLIC_API);
      var u = new URL(path, origin);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      Object.keys(params).forEach(function (k) { if (params[k] != null) u.searchParams.set(k, params[k]); });
      return u.href;
    }
    sh.wsUrl = wsUrl;

    /**
     * Gameplay socket with reconnect (exponential backoff, persistent-session
     * friendly). Every reconnect renews the launch token first (unless it was
     * renewed since the socket opened): a failed reconnect may be an auth
     * failure, and the same URL can never recover from that. When renewal is
     * impossible the socket stops and onAuthLost() fires — offer relaunch().
     * Handlers: onGame(data), onError(msg), onPresence({userId,online}),
     * onAchievement(data), onResumed(f), onAbandoned(f), onOpen(), onClose(code),
     * onAuthLost(). Returns { send(data, realtime?), close(), get open() }.
     */
    sh.connect = function (sessionId, handlers, opts) {
      handlers = handlers || {}; opts = opts || {};
      var ws = null, closed = false, delay = 1000, timer = null, usedToken = null, conn;
      function later(fn) { timer = setT(fn, delay); delay = Math.min(delay * 2, 30000); }
      function reconnect() {
        timer = null;
        if (closed) return;
        var renewed = sh.token && sh.token !== usedToken ? Promise.resolve('renewed') : renew();
        renewed.then(function (r) {
          if (closed) return;
          if (r === 'renewed') open();
          else if (r === 'retry') later(reconnect);
          else { closed = true; handlers.onAuthLost && handlers.onAuthLost(); }
        });
      }
      function open() {
        if (closed || !sh.token || !WS) return;
        usedToken = sh.token;
        ws = new WS(wsUrl('/ws/v1/games', { sessionId: sessionId, build: opts.build, access_token: usedToken }));
        ws.onopen = function () { delay = 1000; handlers.onOpen && handlers.onOpen(); };
        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          switch (m.type) {
            case 'game': handlers.onGame && handlers.onGame(m.data); break;
            case 'error': handlers.onError && handlers.onError(m.error); break;
            case 'presence': handlers.onPresence && handlers.onPresence(m); break;
            case 'achievement': emit('achievement', m.data); handlers.onAchievement && handlers.onAchievement(m.data); break;
            case 'resumed': handlers.onResumed && handlers.onResumed(m); break;
            case 'abandoned': closed = true; handlers.onAbandoned && handlers.onAbandoned(m); break;
          }
        };
        ws.onclose = function (ev) {
          handlers.onClose && handlers.onClose(ev.code);
          if (closed || ev.code === 1000 || ev.code === 4403 || ev.code === 4404) return;
          later(reconnect);
        };
      }
      open();
      conn = {
        send: function (data, realtime) {
          if (!ws || ws.readyState !== 1) return false;
          var msg = { type: 'cmd', data: data };
          if (realtime) msg.realtime = true;
          ws.send(JSON.stringify(msg));
          return true;
        },
        close: function () { closed = true; if (timer) clearT(timer); if (ws) try { ws.close(1000); } catch (e) {} },
        get open() { return !!ws && ws.readyState === 1; },
      };
      return conn;
    };

    // ---------------- chat (REST + polling; launch tokens cannot use ws/v1/chat) ----------------
    function chatPath(cid) { return '/api/v1/chat/conversations/' + encodeURIComponent(cid) + '/messages'; }
    sh.chatMessages = function (conversationId, opts) {
      opts = opts || {};
      return soft(sh.api(chatPath(conversationId) + '?page=' + (opts.page || 1) + '&pageSize=' + (opts.pageSize || 50)), []);
    };
    sh.sendChat = function (conversationId, content) { return sh.api(chatPath(conversationId), { method: 'POST', body: { content: String(content) } }); };
    /** Poll a session's chat; onMessages(list) gets the latest page. Returns stop(). */
    sh.pollChat = function (conversationId, onMessages, intervalMs) {
      var stop = false;
      (function tick() {
        if (stop) return;
        sh.chatMessages(conversationId).then(function (r) { if (!stop) onMessages(r && r.items || r || []); })
          .then(function () { if (!stop) setT(tick, intervalMs || 5000); });
      })();
      return function () { stop = true; };
    };

    // ---------------- voice (REST; WebRTC via the game) ----------------
    sh.voice = {
      create: function (body) { return sh.api('/api/v1/voice/rooms', { method: 'POST', body: body || {} }); },
      list: function (conversationId) { return soft(sh.api('/api/v1/voice/rooms?conversationId=' + encodeURIComponent(conversationId)), []); },
      get: function (id) { return sh.api('/api/v1/voice/rooms/' + encodeURIComponent(id)); },
      join: function (id) { return sh.api('/api/v1/voice/rooms/' + encodeURIComponent(id) + '/join', { method: 'POST' }); },
      leave: function (id) { return sh.api('/api/v1/voice/rooms/' + encodeURIComponent(id) + '/leave', { method: 'POST' }); },
      mute: function (id, muted) { return sh.api('/api/v1/voice/rooms/' + encodeURIComponent(id) + '/mute', { method: 'POST', body: { muted: muted !== false } }); },
      socketUrl: function (id) { return wsUrl('/ws/v1/voice', { roomId: id, access_token: sh.token }); },
    };

    // ---------------- realtime rooms ----------------
    function rt(path, method, body) { return sh.api('/api/v1/realtime' + path, { method: method || 'GET', body: body }); }
    sh.realtime = {
      createRoom: function (body) { return rt('/rooms', 'POST', Object.assign({ gameSlug: sh.slug }, body || {})); },
      listRooms: function () { return soft(rt('/rooms?gameSlug=' + encodeURIComponent(sh.slug)), []); },
      joinByCode: function (code) { return rt('/rooms/join-by-code', 'POST', { joinCode: String(code) }); },
      /** null (404) when no open room qualifies — create and open your own. */
      quickJoin: function (body) { return rt('/rooms/quick-join', 'POST', Object.assign({ gameSlug: sh.slug, seats: 1 }, body || {})); },
      mine: function () { return soft(rt('/rooms/mine'), null); },
      get: function (roomId) { return rt('/rooms/' + encodeURIComponent(roomId)); },
      update: function (roomId, body) { return rt('/rooms/' + encodeURIComponent(roomId), 'PATCH', body); },
      invite: function (roomId, userId) { return rt('/rooms/' + encodeURIComponent(roomId) + '/invites', 'POST', { toUserId: userId }); },
      invites: function () { return soft(rt('/rooms/invites'), []); },
      acceptInvite: function (inviteId) { return rt('/rooms/invites/' + encodeURIComponent(inviteId) + '/accept', 'POST'); },
      declineInvite: function (inviteId) { return soft(rt('/rooms/invites/' + encodeURIComponent(inviteId) + '/decline', 'POST'), null); },
      open: function (roomId) { return rt('/rooms/' + encodeURIComponent(roomId) + '/open', 'POST'); },
      start: function (roomId) { return rt('/rooms/' + encodeURIComponent(roomId) + '/start', 'POST'); },
      leave: function (roomId) { return soft(rt('/rooms/' + encodeURIComponent(roomId) + '/leave', 'POST'), null); },
      /** Host-routed games only: { teamScores:[..], metadata }. */
      result: function (roomId, body) { return rt('/rooms/' + encodeURIComponent(roomId) + '/result', 'POST', body); },
      ticket: function () { return rt('/connection-tickets', 'POST'); },
      socketUrl: function (roomId) { return wsUrl('/ws/v1/realtime', { roomId: roomId, access_token: sh.token }); },
    };

    sh.create = create;
    return sh;
  }

  return create();
});
