/**
 * platform.js — StarHermit host integration + local persistence.
 *
 * Works in two modes:
 *  - Hosted: launch token in the URL fragment (#game_token=<jwt>), decoded
 *    sub/game_scope, Bearer auth on every call, account profile from the
 *    platform profile endpoint, cloud saves on the platform slot, read-only
 *    platform leaderboard, launch-token refresh every 45 min.
 *  - Standalone (file:// or plain static host): everything degrades to
 *    localStorage with identical interfaces. No tokens are ever persisted.
 */
(function (root, factory) {
  const rng = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.SpectrumRng;
  const api = factory(rng);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpectrumPlatform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rng) {
  'use strict';

  const SETTINGS_VERSION = 2;
  const PROGRESSION_VERSION = 1;
  const CLOUD_DEBOUNCE_MS = 2000;
  const TOKEN_REFRESH_MS = 45 * 60 * 1000;
  const TOKEN_REFRESH_RETRY_MS = 60000;

  const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    audio: { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.8, muted: false },
    graphics: { tier: 'auto' },           // auto | low | medium | high
    palette: 'default',                   // default | cvd | contrast
    camera: 'default',                    // default | close | wide
    reducedMotion: false,
    highContrast: false,
    largeText: false,
    leftHanded: false,
    holdToSelect: false,                  // hold-versus-toggle
    timingAssist: false,                  // +50% on time limits
    haptics: true,
    tutorialDone: false,
    bindings: null,                       // keyboard/gamepad overrides
  };

  function defaultProgression() {
    return {
      version: PROGRESSION_VERSION,
      journey: {},                        // levelId -> {medal, moves, score, at}
      challenges: {},                     // challengeId -> best {score, won, at}
      dailies: {},                        // date -> {score, won}
      streak: { count: 0, lastDate: null },
      achievements: {},                   // key -> iso timestamp
      stats: { totalCompletions: 0, totalMoves: 0, practiceRounds: 0 },
      updatedAt: 0,
    };
  }

  function checksum(doc) {
    const clone = JSON.parse(JSON.stringify(doc));
    delete clone.checksum;
    return Rng.hashString(JSON.stringify(clone)).toString(16).padStart(8, '0');
  }

  // ------------------------------------------------------------- jwt --

  /** base64url-decode a JWT payload (no signature verification). */
  function decodeJwtPayload(token) {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    try {
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    } catch (e) { return null; }
  }

  // ------------------------------------------------------ stored zip --

  // Minimal ZIP writer/reader (stored entries only, no compression).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name);
    const crc = crc32(dataBytes);
    const out = [];
    const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
    const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    const head = new Uint8Array(out);
    const cd = [];
    const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
    const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
    const cdHead = new Uint8Array(cd);
    const cdOff = head.length + nameB.length + dataBytes.length;
    const parts = [head, nameB, dataBytes, cdHead, nameB];
    const eocd = [];
    const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    // Stored single-entry reader: scan local headers for compression 0.
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      const method = dv.getUint16(off + 8, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  class Platform {
    constructor() {
      this.isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      this.launchToken = null;            // memory only — never persisted (spec §6)
      this.userId = null;                 // JWT sub
      this.gameScope = 'spectrum-orbs';   // JWT game_scope
      this.hosted = false;                // true iff a launch token was read
      this.profile = null;                // {name} from GET /api/v1/users/{sub}/profile
      this.onSyncChange = null;           // UI hook for the sync badge
      this._timeOffset = 0;               // serverNow - clientNow
      this._timeSynced = false;
      this._syncState = 'offline';        // offline | idle | saving | synced
      this._cloudTimer = null;
      this._cloudRetryTimer = null;
      this._pendingCloudDoc = null;
      this._refreshTimer = null;
      this._leaderboardId = undefined;    // lazily fetched; null = unavailable
      this._nicknameCache = new Map();
      this.storageKey = 'spectrum-orbs:v1';
      if (this.isBrowser) {
        this._parseLaunch();
        if (this.hosted) {
          this._syncState = 'idle';
          this._scheduleTokenRefresh();
          // Flush pending cloud saves when the page is backgrounded or left.
          window.addEventListener('pagehide', () => this.flushCloudSave());
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.flushCloudSave();
          });
        }
      }
    }

    // -------------------------------------------------------- bootstrap --

    _parseLaunch() {
      try {
        let token = null;
        // Real platform delivery: URL fragment, read once then stripped.
        if (window.location.hash.length > 1) {
          const frag = new URLSearchParams(window.location.hash.slice(1));
          token = frag.get('game_token');
          if (token) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
          }
        }
        // Local-dev fallback only: query params.
        if (!token) {
          const params = new URLSearchParams(window.location.search);
          token = params.get('launch') || params.get('token');
        }
        if (token) {
          this.launchToken = token;
          const data = decodeJwtPayload(token) || {};
          if (data.sub) this.userId = String(data.sub);
          if (data.game_scope) this.gameScope = String(data.game_scope);
          this.hosted = true;
        }
        this.storageKey = this.gameScope + ':v1';
      } catch (e) { /* malformed token: stay standalone */ }
    }

    /**
     * One-shot server-time sync (GET /api/v1/time, round-trip adjusted).
     * Opportunistic in both modes: failure just means the local clock.
     */
    async syncTime() {
      if (!this.isBrowser) return false;
      if (!window.location.protocol.startsWith('http')) return false;
      try {
        const t0 = Date.now();
        const res = await fetch('/api/v1/time', { headers: this._headers(), cache: 'no-store' });
        const t1 = Date.now();
        if (!res.ok) return false;
        const data = await res.json();
        const serverMs = Number(data.now !== undefined ? data.now : (data.serverTime !== undefined ? data.serverTime : data.epochMs));
        if (!Number.isFinite(serverMs)) return false;
        this._timeOffset = serverMs - (t0 + (t1 - t0) / 2);
        this._timeSynced = true;
        return true;
      } catch (e) { return false; }
    }

    /** Authoritative now (platform-adjusted when available). */
    now() { return Date.now() + (this._timeSynced ? this._timeOffset : 0); }

    /** UTC date string for daily content, on platform time. */
    utcDate() { return new Date(this.now()).toISOString().slice(0, 10); }

    _headers(extra) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
      if (this.launchToken) h.Authorization = 'Bearer ' + this.launchToken;
      return h;
    }

    /** Fetch wrapper: structured errors and rate limits become recoverable UI states. */
    async api(path, opts) {
      if (!this.hosted) {
        throw Object.assign(new Error('offline'), { code: 'offline' });
      }
      const res = await fetch(path, Object.assign({ headers: this._headers() }, opts || {}));
      if (res.status === 429) {
        const retry = parseInt(res.headers.get('Retry-After') || '5', 10);
        throw Object.assign(new Error('rate-limited'), { code: 'rate-limited', retryAfter: retry });
      }
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) {
        throw Object.assign(new Error((body && body.error) || ('http-' + res.status)), {
          code: (body && body.error) || ('http-' + res.status), status: res.status,
        });
      }
      return body;
    }

    // ------------------------------------------------------------ auth --

    /** Swap in a re-minted launch token before the current one expires. */
    _scheduleTokenRefresh() {
      if (!this.hosted) return;
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this._refreshToken(), TOKEN_REFRESH_MS);
    }
    async _refreshToken() {
      if (!this.hosted) return;
      try {
        const res = await fetch('/api/v1/games/' + encodeURIComponent(this.gameScope) + '/launch-token', {
          method: 'POST', headers: this._headers(),
        });
        if (!res.ok) throw Object.assign(new Error('http-' + res.status), { code: 'http-' + res.status });
        const data = await res.json().catch(() => ({}));
        if (data && typeof data.token === 'string' && data.token) this.launchToken = data.token;
        this._scheduleTokenRefresh();
      } catch (e) {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._refreshToken(), TOKEN_REFRESH_RETRY_MS);
      }
    }

    // ----------------------------------------------------------- profile --

    /**
     * Display name from the platform profile endpoint (never /api/v1/me,
     * never usernames). Falls back to "Player " + id8.
     */
    async loadProfile() {
      if (!this.hosted || !this.userId) return null;
      try {
        const p = await this.api('/api/v1/users/' + encodeURIComponent(this.userId) + '/profile');
        this.profile = { name: cleanNickname(p) || ('Player ' + this.userId.slice(0, 8)) };
      } catch (e) {
        this.profile = { name: 'Player ' + this.userId.slice(0, 8) };
      }
      return this.profile;
    }

    /** Resolve another player's id to a display nickname (cached). */
    async nickname(userId) {
      const id = String(userId);
      if (this._nicknameCache.has(id)) return this._nicknameCache.get(id);
      let name = 'Player ' + id.slice(0, 8);
      try {
        const p = await this.api('/api/v1/users/' + encodeURIComponent(id) + '/profile');
        name = cleanNickname(p) || name;
      } catch (e) { /* fallback name stands */ }
      this._nicknameCache.set(id, name);
      return name;
    }

    // ------------------------------------------------------- persistence --

    _localGet(key) {
      try { const s = localStorage.getItem(this.storageKey + ':' + key); return s ? JSON.parse(s) : null; }
      catch (e) { return null; }
    }
    _localSet(key, val) {
      try { localStorage.setItem(this.storageKey + ':' + key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    }

    loadSettings() {
      const s = this._localGet('settings');
      if (!s || s.version !== SETTINGS_VERSION) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      return Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s);
    }
    saveSettings(settings) {
      settings.version = SETTINGS_VERSION;
      this._localSet('settings', settings);
    }

    /** Load progression; verifies checksum; migrates versions. */
    loadProgression() {
      let doc = this._localGet('progression');
      if (!doc) return defaultProgression();
      if (doc.version === 0) { // hypothetical legacy: kept only totals
        const next = defaultProgression();
        next.stats.totalCompletions = (doc.completions | 0);
        doc = next;
      }
      if (doc.version !== PROGRESSION_VERSION) return defaultProgression();
      if (doc.checksum && doc.checksum !== checksum(doc)) return defaultProgression(); // corrupt: reset safely
      return Object.assign(defaultProgression(), doc);
    }

    /**
     * Save progression: localStorage is the offline cache (written
     * immediately); when hosted the same doc is mirrored to the platform
     * cloud-save slot, debounced and flushed on pagehide/visibilitychange.
     */
    async saveProgression(doc) {
      doc.updatedAt = this.now();
      doc.checksum = checksum(doc);
      this._localSet('progression', doc);
      if (!this.hosted) return { saved: 'local' };
      this._pendingCloudDoc = JSON.parse(JSON.stringify(doc));
      this._setSync('saving');
      clearTimeout(this._cloudTimer);
      this._cloudTimer = setTimeout(() => this.flushCloudSave(), CLOUD_DEBOUNCE_MS);
      return { saved: 'cloud' };
    }

    /** Push the pending doc to the cloud slot now (pagehide/visibilitychange). */
    async flushCloudSave() {
      if (!this.hosted) return { saved: 'local' };
      clearTimeout(this._cloudTimer);
      this._cloudTimer = null;
      const doc = this._pendingCloudDoc;
      if (!doc) return { saved: 'local' };
      try {
        const body = JSON.stringify({
          dataBase64: bytesToBase64(zipStore('progression.json', new TextEncoder().encode(JSON.stringify(doc)))),
        });
        const res = await fetch(this._cloudSaveUrl(), { method: 'PUT', headers: this._headers(), body });
        if (!res.ok) throw Object.assign(new Error('http-' + res.status), { code: 'http-' + res.status });
        this._pendingCloudDoc = null;
        this._setSync('synced');
        return { saved: 'cloud' };
      } catch (e) {
        // Doc stays queued; retry quietly so a flaky network cannot lose it.
        if (!this._cloudRetryTimer) {
          this._cloudRetryTimer = setTimeout(() => {
            this._cloudRetryTimer = null;
            this.flushCloudSave();
          }, TOKEN_REFRESH_RETRY_MS);
        }
        return { saved: 'local', warning: e.code || 'cloud-unavailable' };
      }
    }

    /**
     * Load the cloud mirror; the remote copy wins ties and newer snapshots
     * (cookbook: on conflict prefer remote), then becomes the offline cache.
     */
    async syncProgression(local) {
      if (!this.hosted) return { resolved: local, source: 'local' };
      try {
        const res = await fetch(this._cloudSaveUrl(), { headers: this._headers(), cache: 'no-store' });
        if (res.status === 404) { this._setSync('synced'); return { resolved: local, source: 'local' }; }
        if (!res.ok) throw Object.assign(new Error('http-' + res.status), { code: 'http-' + res.status });
        const remote = JSON.parse(new TextDecoder().decode(unzipFirstEntry(new Uint8Array(await res.arrayBuffer()))));
        const sane = remote && typeof remote === 'object' && remote.version === PROGRESSION_VERSION &&
          (!remote.checksum || remote.checksum === checksum(remote));
        if (sane && remote.updatedAt >= (local.updatedAt || 0)) {
          this._localSet('progression', remote);
          this._setSync('synced');
          return { resolved: remote, source: 'cloud' };
        }
        this._setSync('synced');
        return { resolved: local, source: 'local' };
      } catch (e) {
        return { resolved: local, source: 'local', warning: e.code || 'cloud-unavailable' };
      }
    }

    /** Small sync badge state: offline | idle | saving | synced. */
    syncStatus() {
      return this.hosted ? this._syncState : 'offline';
    }
    _setSync(state) {
      const changed = this._syncState !== state;
      this._syncState = state;
      if (changed && typeof this.onSyncChange === 'function') this.onSyncChange(state);
    }

    _cloudSaveUrl() {
      return '/api/v1/me/cloud-saves/' + encodeURIComponent(this.gameScope);
    }

    saveRoundSnapshot(snapshotStr) { this._localSet('round', snapshotStr); }
    loadRoundSnapshot() { return this._localGet('round'); }
    clearRoundSnapshot() { try { localStorage.removeItem(this.storageKey + ':round'); } catch (e) {} }

    // ------------------------------------------------------- leaderboards --

    /**
     * Personal-best record (spec §6): ruleset, content version, seed,
     * assists, duration, replay envelope. Clients can never submit to a
     * platform leaderboard — this stays local and cloud-mirrored; the
     * platform board is read-only via leaderboard().
     */
    async submitScore(entry) {
      const record = {
        game: this.gameScope,
        board: entry.board,               // 'daily:<date>' | 'journey' | 'challenge:<id>'
        score: entry.score,
        rulesetVersion: entry.rulesetVersion,
        contentVersion: entry.contentVersion,
        seed: entry.seed,
        assists: entry.assists,           // {hints, undos}
        durationMs: entry.durationMs,
        sessionId: entry.sessionId,
        replay: entry.replay || null,
        player: (this.profile && this.profile.name) || 'Guest',
        at: this.now(),
      };
      const board = this._localGet('board:' + record.board) || [];
      board.push(record);
      board.sort((a, b) => b.score - a.score);
      this._localSet('board:' + record.board, board.slice(0, 50));
      return { stored: 'local', casual: true, rank: board.indexOf(record) + 1 };
    }

    /** The platform's single leaderboard id for this game (null if none). */
    async leaderboardInfo() {
      if (!this.hosted) return null;
      if (this._leaderboardId !== undefined) return this._leaderboardId;
      try {
        const g = await this.api('/api/v1/games/' + encodeURIComponent(this.gameScope));
        this._leaderboardId = (g && g.leaderboardId) || null;
      } catch (e) { this._leaderboardId = null; }
      return this._leaderboardId;
    }

    /**
     * Read-only platform board when hosted; otherwise (or when the game has
     * no platform leaderboard) the local personal-best records.
     */
    async leaderboard(board, friendsOnly) {
      if (!this.hosted) {
        return { entries: this._localGet('board:' + board) || [], casual: true };
      }
      const leaderboardId = await this.leaderboardInfo();
      if (!leaderboardId) {
        return { entries: this._localGet('board:' + board) || [], casual: true };
      }
      try {
        const q = new URLSearchParams({ friendsOnly: friendsOnly ? '1' : '', page: '1', pageSize: '50' });
        const data = await this.api('/api/v1/leaderboards/' + encodeURIComponent(leaderboardId) + '/entries?' + q.toString());
        const raw = (data && data.entries) || [];
        const entries = await Promise.all(raw.map(async (e) => ({
          player: e.player || e.nickname || (e.userId ? await this.nickname(e.userId) : 'Guest'),
          score: e.score,
          seed: e.seed !== undefined ? e.seed : null,
          durationMs: e.durationMs !== undefined ? e.durationMs : null,
        })));
        return {
          entries,
          casual: false,
          note: 'Platform leaderboard — read-only. Your personal bests are stored with your account.',
        };
      } catch (e) {
        return { entries: this._localGet('board:' + board) || [], casual: true, warning: e.code };
      }
    }

    // -------------------------------------------------------- achievements --

    /** Idempotent local unlock; durable via the cloud-saved progression doc. */
    async unlockAchievement(key) {
      const prog = this.loadProgression();
      if (prog.achievements[key]) return { unlocked: false, already: true };
      prog.achievements[key] = new Date(this.now()).toISOString();
      await this.saveProgression(prog);
      return { unlocked: true };
    }
  }

  function cleanNickname(p) {
    const n = p && typeof p.nickname === 'string' ? p.nickname.trim() : '';
    return n || null;
  }

  return { Platform, DEFAULT_SETTINGS, defaultProgression, checksum, SETTINGS_VERSION, PROGRESSION_VERSION };
});
