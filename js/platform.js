/**
 * platform.js — StarHermit host integration + local persistence.
 *
 * Works in two modes:
 *  - Hosted: launch token in the URL, same-origin /api routes, presence
 *    heartbeats, cloud saves, leaderboard submission, server-time sync.
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
    telemetryConsent: null,               // null = not asked, true/false
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

  class Platform {
    constructor() {
      this.isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      this.launchToken = null;
      this.gameScope = 'spectrum-orbs';
      this.hosted = false;
      this.profile = null;                // {name, avatar, privacy} from host
      this._timeOffset = 0;               // serverNow - clientNow
      this._timeSynced = false;
      this._heartbeatTimer = null;
      this._activityStarted = false;
      this._telemetryQueue = [];
      this.storageKey = 'spectrum-orbs:v1';
      if (this.isBrowser) this._parseLaunch();
    }

    // -------------------------------------------------------- bootstrap --

    _parseLaunch() {
      try {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('launch') || params.get('token');
        if (token) {
          this.launchToken = token; // memory only — never persisted (spec §6)
          const payload = token.split('.')[1];
          if (payload) {
            const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
            if (data.game) this.gameScope = data.game;
            if (data.profile) this.profile = data.profile;
          }
        }
        this.hosted = window.location.protocol.startsWith('http');
        this.storageKey = this.gameScope + ':v1';
      } catch (e) { /* malformed token: stay standalone */ }
    }

    /** Synchronize with platform time (round-trip adjusted). */
    async syncTime() {
      if (!this.isBrowser || !this.hosted) return false;
      try {
        const t0 = Date.now();
        const res = await fetch('/api/v1/time', { headers: this._headers() });
        const t1 = Date.now();
        if (!res.ok) return false;
        const data = await res.json();
        const rttMid = t0 + (t1 - t0) / 2;
        this._timeOffset = data.now - rttMid;
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
      if (!this.hosted) throw Object.assign(new Error('offline'), { code: 'offline' });
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
      this.track('settings_change', { keys: Object.keys(settings) });
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

    async saveProgression(doc) {
      doc.updatedAt = this.now();
      doc.checksum = checksum(doc);
      this._localSet('progression', doc);
      if (!this.hosted) return { saved: 'local' };
      // Cloud save: versioned + checksummed. Conflicts return both snapshots.
      try {
        const res = await this.api('/api/v1/save', { method: 'POST', body: JSON.stringify({ game: this.gameScope, doc }) });
        return { saved: 'cloud', server: res };
      } catch (e) {
        return { saved: 'local', warning: e.code };
      }
    }

    /** Pull cloud progression; 'conflict' when neither doc descends from the other. */
    async syncProgression(local) {
      if (!this.hosted) return { resolved: local, source: 'local' };
      try {
        const res = await this.api('/api/v1/save?game=' + encodeURIComponent(this.gameScope));
        const remote = res && res.doc;
        if (!remote) return { resolved: local, source: 'local' };
        if (remote.updatedAt > (local.updatedAt || 0)) return { resolved: remote, source: 'cloud' };
        if (remote.updatedAt === (local.updatedAt || 0)) return { resolved: local, source: 'local' };
        // Neither is a strict descendant: keep both and ask the player.
        return { conflict: true, local, remote };
      } catch (e) {
        return { resolved: local, source: 'local', warning: e.code };
      }
    }

    saveRoundSnapshot(snapshotStr) { this._localSet('round', snapshotStr); }
    loadRoundSnapshot() { return this._localGet('round'); }
    clearRoundSnapshot() { try { localStorage.removeItem(this.storageKey + ':round'); } catch (e) {} }

    // ------------------------------------------------------- leaderboards --

    /**
     * Submit a result with full provenance (spec §6): ruleset, content
     * version, seed, assists, duration, replay envelope. Falls back to a
     * local casual board when not hosted.
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
        player: (this.profile && this.profile.privacy !== 'hidden') ? (this.profile.name || 'Guest') : 'Guest',
        at: this.now(),
      };
      if (!this.hosted) {
        const board = this._localGet('board:' + record.board) || [];
        board.push(record);
        board.sort((a, b) => b.score - a.score);
        this._localSet('board:' + record.board, board.slice(0, 50));
        return { stored: 'local', casual: true, rank: board.indexOf(record) + 1 };
      }
      try {
        const res = await this.api('/api/v1/leaderboard', { method: 'POST', body: JSON.stringify(record) });
        return Object.assign({ stored: 'cloud' }, res);
      } catch (e) {
        const board = this._localGet('board:' + record.board) || [];
        board.push(record);
        board.sort((a, b) => b.score - a.score);
        this._localSet('board:' + record.board, board.slice(0, 50));
        return { stored: 'local', casual: true, warning: e.code };
      }
    }

    async leaderboard(board, friendsOnly) {
      if (!this.hosted) {
        return { entries: this._localGet('board:' + board) || [], casual: true };
      }
      try {
        return await this.api('/api/v1/leaderboard?board=' + encodeURIComponent(board) + (friendsOnly ? '&friends=1' : ''));
      } catch (e) {
        return { entries: this._localGet('board:' + board) || [], casual: true, warning: e.code };
      }
    }

    // -------------------------------------------------------- achievements --

    /** Idempotent unlock; durable delivery via host when available. */
    async unlockAchievement(key) {
      const prog = this.loadProgression();
      if (prog.achievements[key]) return { unlocked: false, already: true };
      prog.achievements[key] = new Date(this.now()).toISOString();
      await this.saveProgression(prog);
      if (this.hosted) {
        try { await this.api('/api/v1/achievement', { method: 'POST', body: JSON.stringify({ game: this.gameScope, key }) }); }
        catch (e) { /* local record stands; retried on next sync */ }
      }
      return { unlocked: true };
    }

    // ---------------------------------------------------- presence/activity --

    activityStart() {
      if (this._activityStarted || !this.hosted) return;
      this._activityStarted = true;
      this.api('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ game: this.gameScope }) }).catch(() => {});
    }
    activityEnd() {
      if (!this._activityStarted || !this.hosted) return;
      this._activityStarted = false;
      const body = JSON.stringify({ game: this.gameScope });
      try {
        if (navigator.sendBeacon) { navigator.sendBeacon('/api/v1/activity/end', body); return; }
      } catch (e) {}
      this.api('/api/v1/activity/end', { method: 'POST', body }).catch(() => {});
    }
    heartbeatStart() {
      if (!this.hosted || this._heartbeatTimer) return;
      this._heartbeatTimer = setInterval(() => {
        this.api('/api/v1/presence', { method: 'POST', body: JSON.stringify({ game: this.gameScope }) }).catch(() => {});
      }, 30000);
    }
    heartbeatStop() {
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    }

    // ------------------------------------------------------------ telemetry --

    /** Anonymous funnel events only (spec §6): no text, no pointers, no PII. */
    track(event, data) {
      const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
      if (!allowed.includes(event)) return;
      const settings = this.isBrowser ? this.loadSettings() : { telemetryConsent: true };
      if (settings.telemetryConsent === false) return;
      const clean = {};
      if (data) for (const k of ['mode', 'keys', 'step', 'won', 'tier', 'category']) {
        if (data[k] !== undefined) clean[k] = data[k];
      }
      this._telemetryQueue.push({ event, data: clean, at: Date.now() });
      if (this._telemetryQueue.length >= 10) this.flushTelemetry();
    }
    flushTelemetry() {
      if (!this._telemetryQueue.length) return;
      const batch = this._telemetryQueue.splice(0);
      if (!this.hosted) return;
      this.api('/api/v1/telemetry', { method: 'POST', body: JSON.stringify({ game: this.gameScope, events: batch }) })
        .catch(() => { /* dropped: analytics must never break play */ });
    }
  }

  return { Platform, DEFAULT_SETTINGS, defaultProgression, checksum, SETTINGS_VERSION, PROGRESSION_VERSION };
});
