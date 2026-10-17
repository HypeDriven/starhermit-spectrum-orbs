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
  const T = (key, vars) => (typeof globalThis !== 'undefined' && globalThis.SOI18N ? globalThis.SOI18N.T(key, vars)
    : String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)));
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

  /**
   * Merge two progression docs without dropping either side: per-stage,
   * per-challenge and per-day records keep the higher score, achievements keep
   * the earliest unlock, stats keep the larger counts, the streak with the
   * later day (then the longer run) wins. Either side may be null.
   */
  function mergeProgression(a, b) {
    const base = defaultProgression();
    const A = Object.assign(defaultProgression(), a || {}), B = Object.assign(defaultProgression(), b || {});
    const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
    const better = (x, y) => {
      const out = Object.assign({}, obj(x));
      for (const [k, v] of Object.entries(obj(y))) {
        const cur = out[k];
        if (!cur || (v && ((v.won && !cur.won) || (!!v.won === !!cur.won && (Number(v.score) || 0) > (Number(cur.score) || 0))))) out[k] = v;
      }
      return out;
    };
    const achievements = Object.assign({}, obj(A.achievements));
    for (const [k, v] of Object.entries(obj(B.achievements))) {
      if (!achievements[k] || (v && String(v) < String(achievements[k]))) achievements[k] = v;
    }
    const stats = {};
    for (const k of new Set([...Object.keys(base.stats), ...Object.keys(obj(A.stats)), ...Object.keys(obj(B.stats))])) {
      stats[k] = Math.max(Number(obj(A.stats)[k]) || 0, Number(obj(B.stats)[k]) || 0);
    }
    const sa = obj(A.streak), sb = obj(B.streak);
    const streak = String(sa.lastDate || '') > String(sb.lastDate || '') ? sa
      : String(sb.lastDate || '') > String(sa.lastDate || '') ? sb
      : ((sa.count || 0) >= (sb.count || 0) ? sa : sb);
    const out = Object.assign({}, A, B, {
      version: PROGRESSION_VERSION,
      journey: better(A.journey, B.journey),
      challenges: better(A.challenges, B.challenges),
      dailies: better(A.dailies, B.dailies),
      streak: { count: streak.count || 0, lastDate: streak.lastDate || null },
      achievements, stats,
      updatedAt: Math.max(Number(A.updatedAt) || 0, Number(B.updatedAt) || 0),
    });
    delete out.checksum;
    return out;
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
      this.onProgressionMerged = null;    // UI hook after a save conflict was merged
      this._timeOffset = 0;               // serverNow - clientNow
      this._timeSynced = false;
      this._syncState = 'offline';        // offline | idle | saving | synced
      this._settingsSynced = false;       // platform settings loaded (then local changes mirror up)
      this.storageKey = 'spectrum-orbs:v1';
      const sh = SH();
      if (sh) {
        if (!sh.token) sh.init();
        sh.on('saved', (ok) => this._setSync(ok ? 'synced' : 'idle'));
        // Another device saved since our last load: reload, merge, save the merge.
        sh.on('saveconflict', () => { this.resolveConflict(); });
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
      this.profile = { name: p ? p.displayName : T('Player {id}', { id: this.userId.slice(0, 6) }) };
      return this.profile;
    }

    /** Resolve another player's id to a display nickname (cached by the SDK). */
    async nickname(userId) {
      const id = String(userId);
      const p = this.hosted ? await SH().profile(id).catch(() => null) : null;
      return p ? p.displayName : T('Player {id}', { id: id.slice(0, 6) });
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
     * Load the cloud mirror and merge it with the local doc (mergeProgression);
     * the merge becomes the offline cache and is uploaded when the cloud
     * lacked anything this device has.
     */
    async syncProgression(local) {
      if (!this.hosted) return { resolved: local, source: 'local' };
      const remote = await SH().loadJSON().catch(() => null);
      this._setSync('synced');
      const sane = remote && typeof remote === 'object' && remote.version === PROGRESSION_VERSION &&
        (!remote.checksum || remote.checksum === checksum(remote));
      if (!sane) return { resolved: local, source: 'local' };
      const merged = mergeProgression(remote, local);
      const cloudBehind = JSON.stringify(mergeProgression(remote, null)) !== JSON.stringify(merged);
      if (cloudBehind) await this.saveProgression(merged);
      else { merged.checksum = checksum(merged); this._localSet('progression', merged); }
      return { resolved: this.loadProgression(), source: cloudBehind ? 'merged' : 'cloud' };
    }

    /** saveconflict: reload the cloud doc, merge with the local one, save the merge. */
    async resolveConflict() {
      const sh = SH();
      if (!this.hosted || !sh) return;
      const remote = await sh.loadJSON().catch(() => null);
      if (sh.saveConflicted() || sh.saveLoadFailed()) { this._setSync('idle'); return; }
      const sane = remote && typeof remote === 'object' && remote.version === PROGRESSION_VERSION &&
        (!remote.checksum || remote.checksum === checksum(remote));
      const merged = mergeProgression(sane ? remote : null, this.loadProgression());
      await this.saveProgression(merged);
      if (typeof this.onProgressionMerged === 'function') this.onProgressionMerged(this.loadProgression());
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
        player: (this.profile && this.profile.name) || null,
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
          player: e.userId ? await this.nickname(e.userId) : null,
          score: e.score,
          seed: e.seed !== undefined ? e.seed : null,
          durationMs: e.durationMs !== undefined ? e.durationMs : null,
        })));
        return {
          entries,
          casual: false,
          note: 'Platform leaderboard — read-only. Your personal bests are stored with your account.', // English key; ui.js translates
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

  return { Platform, SYNCED_SETTINGS, DEFAULT_SETTINGS, defaultProgression, mergeProgression, checksum, SETTINGS_VERSION, PROGRESSION_VERSION };
});
