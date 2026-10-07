/**
 * platform.js — StarHermit host integration + local persistence.
 *
 * Platform calls go through window.StarHermit (starhermit-sdk.js, loaded
 * first), which reads the launch token (#game_token / #access_token),
 * renews it and talks to the API. Works in two modes:
 *  - Hosted (SDK signed in): account profile, cloud save on slot
 *    game:<slug>, settings KV, platform key bindings, read-only platform
 *    leaderboard, invite link.
 *  - Standalone (file:// or plain static host): everything degrades to
 *    localStorage with identical interfaces and no platform calls. No
 *    tokens are ever persisted.
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
  const SH = () => (typeof globalThis !== 'undefined' ? globalThis.StarHermit : null) || null;
  // Settings mirrored to the platform settings KV (bindings go through the
  // platform controls API instead).
  const SYNCED_SETTINGS = ['audio', 'graphics', 'palette', 'camera', 'reducedMotion', 'highContrast',
    'largeText', 'leftHanded', 'holdToSelect', 'timingAssist', 'haptics', 'tutorialDone'];

  const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    audio: { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.8, muted: false },
    graphics: { preset: 'auto' },         // gfx.js model: preset + per-category overrides
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

  class Platform {
    constructor() {
      this.isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      this.userId = null;                 // JWT sub (via the SDK)
      this.gameScope = 'spectrum-orbs';   // JWT game_scope (via the SDK)
      this.hosted = false;                // true while the SDK holds a token
      this.profile = null;                // {name} from the platform profile
      this.onSyncChange = null;           // UI hook for the sync badge
      this.onSignedOut = null;            // UI hook when renewal is refused
      this._timeOffset = 0;               // serverNow - clientNow
      this._timeSynced = false;
      this._syncState = 'offline';        // offline | idle | saving | synced
      this._settingsSynced = false;       // platform settings loaded (then local changes mirror up)
      this.storageKey = 'spectrum-orbs:v1';
      const sh = SH();
      if (sh) {
        if (!sh.token) sh.init();
        sh.on('saved', (ok) => this._setSync(ok ? 'synced' : 'idle'));
        sh.on('auth', (a) => {
          const was = this.hosted;
          this._syncFromSdk();
          if (was && !a.signedIn) {
            this.profile = null;
            this._setSync('offline');
            if (typeof this.onSignedOut === 'function') this.onSignedOut();
          }
        });
        this._syncFromSdk();
      }
      if (this.hosted) {
        this._syncState = 'idle';
        if (this.isBrowser) {
          // Flush pending cloud saves when the page is backgrounded or left.
          window.addEventListener('pagehide', () => this.flushCloudSave());
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.flushCloudSave();
          });
        }
      }
    }

    _syncFromSdk() {
      const sh = SH();
      this.hosted = !!(sh && sh.signedIn);
      this.userId = this.hosted && sh.userId ? String(sh.userId) : null;
      if (sh && sh.slug) this.gameScope = String(sh.slug);
      this.storageKey = this.gameScope + ':v1';
    }

    canSignIn() { const sh = SH(); return !!(sh && sh.canSignIn()); }
    signIn() { const sh = SH(); return !!(sh && sh.signIn()); }
    inviteLink() { return this.hosted ? SH().inviteLink() : null; }

    /**
     * One-shot server-time sync (GET /api/v1/time, round-trip adjusted).
     * Signed in only: standalone makes no own-server calls and uses the
     * local clock. Failure also just means the local clock.
     */
    async syncTime() {
      if (!this.isBrowser || !this.hosted) return false;
      if (!window.location.protocol.startsWith('http')) return false;
      try {
        const t0 = Date.now();
        const res = await fetch('/api/v1/time', { headers: { Authorization: 'Bearer ' + SH().token }, cache: 'no-store' });
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

    // ----------------------------------------------------------- profile --

    /** Display name from the platform profile (nickname, "Player "+id fallback). */
    async loadProfile() {
      if (!this.hosted) return null;
      const p = await SH().profile().catch(() => null);
      this.profile = { name: p ? p.displayName : 'Player ' + this.userId.slice(0, 6) };
      return this.profile;
    }

    /** Resolve another player's id to a display nickname (cached by the SDK). */
    async nickname(userId) {
      const id = String(userId);
      const p = this.hosted ? await SH().profile(id).catch(() => null) : null;
      return p ? p.displayName : 'Player ' + id.slice(0, 6);
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
      // Mirror preferences once the platform's values have been applied.
      if (this.hosted && this._settingsSynced) {
        const patch = {};
        for (const k of SYNCED_SETTINGS) if (settings[k] !== undefined) patch[k] = settings[k];
        SH().patchSettings(patch);
      }
    }

    /**
     * Signed in: merge the platform settings KV into `settings` (platform
     * wins) and the platform key bindings into settings.bindings. Resolves
     * true when anything changed. Standalone: false, no network.
     */
    async loadRemoteSettings(settings, defaultBindings) {
      if (!this.hosted) return false;
      const sh = SH();
      const [remote, bindings] = await Promise.all([
        sh.getSettings().catch(() => ({})),
        sh.loadBindings(defaultBindings).catch(() => null),
      ]);
      let changed = false;
      for (const k of SYNCED_SETTINGS) {
        if (remote && remote[k] !== undefined && remote[k] !== null &&
            JSON.stringify(remote[k]) !== JSON.stringify(settings[k])) {
          settings[k] = remote[k];
          changed = true;
        }
      }
      if (bindings && JSON.stringify(bindings) !== JSON.stringify(settings.bindings || defaultBindings)) {
        settings.bindings = bindings;
        changed = true;
      }
      this._settingsSynced = true;
      this.saveSettings(settings);
      return changed;
    }

    /** Persist one rebound action to the platform controls (no-op standalone). */
    setControl(action, codes) {
      if (this.hosted) SH().setControl(action, codes).catch(() => {});
    }
    /** Reset the platform controls to the starhermit.txt defaults. */
    resetControls() {
      if (this.hosted) SH().resetControls();
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
      this._setSync('saving');
      SH().saveJSON(doc);
      return { saved: 'cloud' };
    }

    /** Push the pending doc to the cloud slot now (pagehide/visibilitychange). */
    async flushCloudSave() {
      if (!this.hosted) return { saved: 'local' };
      return { saved: (await SH().flushSave(true)) ? 'cloud' : 'local' };
    }

    /**
     * Load the cloud mirror; the remote copy wins ties and newer snapshots
     * (cookbook: on conflict prefer remote), then becomes the offline cache.
     */
    async syncProgression(local) {
      if (!this.hosted) return { resolved: local, source: 'local' };
      const remote = await SH().loadJSON().catch(() => null);
      this._setSync('synced');
      const sane = remote && typeof remote === 'object' && remote.version === PROGRESSION_VERSION &&
        (!remote.checksum || remote.checksum === checksum(remote));
      if (sane && remote.updatedAt >= (local.updatedAt || 0)) {
        this._localSet('progression', remote);
        return { resolved: remote, source: 'cloud' };
      }
      return { resolved: local, source: 'local' };
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

    saveRoundSnapshot(snapshotStr) { this._localSet('round', snapshotStr); }
    loadRoundSnapshot() { return this._localGet('round'); }
    clearRoundSnapshot() { try { localStorage.removeItem(this.storageKey + ':round'); } catch (e) {} }

    // ------------------------------------------------------- leaderboards --

    /**
     * Personal-best record (spec §6): ruleset, content version, seed,
     * assists, duration, replay envelope. This stays local and
     * cloud-mirrored; the platform high-score board gets the total through
     * postHighScore().
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

    /**
     * Post a won ranked round's total to the platform high-score board
     * (StarHermit.submitScores → score-script.js); resolves { posted, rank }.
     */
    async postHighScore(total) {
      const sh = SH();
      if (!sh || !sh.signedIn || typeof sh.submitScores !== 'function') return { posted: false, rank: null };
      let keys;
      try { keys = await sh.submitScores({ 'high-score': total }); } catch (e) { return { posted: false, rank: null }; }
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await sh.leaderboard('high-score', { pageSize: 100 });
        const me = ((r && r.items) || []).find((i) => i.userId === sh.userId);
        return { posted: true, rank: me ? me.rank : null };
      } catch (e) { return { posted: true, rank: null }; }
    }

    /** The platform's leaderboard id for this game (null if none). */
    async leaderboardInfo() {
      if (!this.hosted) return null;
      const boards = await SH().leaderboards().catch(() => []);
      return boards && boards[0] ? boards[0].id : null;
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
        const data = await SH().leaderboardEntries(leaderboardId, { page: 1, pageSize: 50, scope: friendsOnly ? 'friends' : undefined });
        const raw = (data && data.items) || [];
        const entries = await Promise.all(raw.map(async (e) => ({
          player: e.userId ? await this.nickname(e.userId) : 'Guest',
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

  return { Platform, SYNCED_SETTINGS, DEFAULT_SETTINGS, defaultProgression, checksum, SETTINGS_VERSION, PROGRESSION_VERSION };
});
