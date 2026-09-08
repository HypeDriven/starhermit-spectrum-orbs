/**
 * session.js — game session: validated command dispatch, undo, clock,
 * replay envelope, snapshots, and reconnect/resume support.
 *
 * A session owns exactly one rules state. Nothing mutates rules state except
 * through dispatch(), which assigns command IDs (duplicate submissions are
 * rejected idempotently) and records the ordered log for replay validation.
 */
(function (root, factory) {
  const rng = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.SpectrumRng;
  const rules = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.SpectrumRules;
  const content = (typeof module === 'object' && module.exports) ? require('./content.js') : root.SpectrumContent;
  const api = factory(rng, rules, content);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpectrumSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rng, Rules, Content) {
  'use strict';

  const REPLAY_SCHEMA = 1;
  const HASH_EVERY = 10; // periodic state hashes in the replay envelope

  class GameSession {
    /**
     * level: content record. opts: { mode, now: () => ms (authoritative clock) }
     */
    constructor(level, opts) {
      this.level = level;
      this.mode = (opts && opts.mode) || 'practice';
      this._now = (opts && opts.now) || (() => Date.now());
      this.state = Rules.createState({
        contentId: level.id, seed: level.seed, colors: level.colors,
        tubeCount: level.tubeCount, capacity: level.capacity,
        stacks: level.stacks || null,
        limits: level.limits || {},
      });
      this.commands = [];            // ordered validated command log
      this.seenCommandIds = new Set();
      this.hashes = [{ tick: 0, hash: Rules.stateHash(this.state) }];
      this.startedAt = this._now();
      this._pauseStart = null;       // non-null while paused
      this._pausedTotal = 0;
      this._carriedMs = 0;           // elapsed time baked in by a snapshot restore
      this.finished = false;
      this.terminalResult = null;
      this.listeners = new Set();
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    _emit(events) { for (const fn of this.listeners) fn(this.state, events); }

    /** Authoritative elapsed ms, excluding paused time. */
    elapsedMs() {
      const end = this._pauseStart !== null ? this._pauseStart : this._now();
      return Math.max(0, Math.floor(this._carriedMs + end - this.startedAt - this._pausedTotal));
    }

    pause() {
      if (this._pauseStart === null) this._pauseStart = this._now();
    }
    resume() {
      if (this._pauseStart !== null) {
        this._pausedTotal += this._now() - this._pauseStart;
        this._pauseStart = null;
      }
    }
    get paused() { return this._pauseStart !== null; }

    /**
     * Dispatch a player command. Returns {accepted, rejected, events}.
     * Duplicate command IDs are rejected idempotently (safe retries).
     */
    dispatch(cmd) {
      if (this.finished) return { accepted: false, rejected: { reason: 'terminal' }, events: [] };
      const withId = Object.assign({}, cmd, {
        id: cmd.id || Rules.nextCommandId(),
        elapsedMs: this.elapsedMs(),
      });
      if (this.seenCommandIds.has(withId.id)) {
        return { accepted: false, rejected: { reason: 'duplicate-command' }, events: [], duplicate: true };
      }
      const r = Rules.applyCommand(this.state, withId);
      if (r.state === this.state && r.rejected) return { accepted: false, rejected: r.rejected, events: [] };
      this.state = r.state;
      this.seenCommandIds.add(withId.id);
      this.commands.push({ id: withId.id, type: withId.type, from: withId.from, to: withId.to, elapsedMs: withId.elapsedMs });
      if (this.state.tick % HASH_EVERY === 0 || this.state.status !== 'active') {
        this.hashes.push({ tick: this.state.tick, hash: Rules.stateHash(this.state) });
      }
      if (this.state.status !== 'active') this._finish();
      this._emit(r.events);
      return { accepted: !r.rejected, rejected: r.rejected, events: r.events, command: withId };
    }

    move(from, to) { return this.dispatch({ type: 'move', from, to }); }
    undo() { return this.dispatch({ type: 'undo' }); }
    concede() { return this.dispatch({ type: 'concede' }); }
    /** Heartbeat for time-limited boards; cheap no-op otherwise. */
    tickClock() {
      if (this.state.limits.timeMs === null || this.state.status !== 'active') return null;
      return this.dispatch({ type: 'tick-clock' });
    }

    hint() {
      const h = Rules.hint(this.state);
      if (h) this.state.hintsUsed++;
      return h;
    }

    score() { return Rules.score(this.state, Object.assign({ timeMs: this.level.parTimeMs }, this.level.par)); }

    _finish() {
      this.finished = true;
      this.terminalResult = Object.assign(this.score(), {
        sessionId: this.state.sessionId,
        terminalReason: this.state.terminalReason,
        contentId: this.level.id,
        mode: this.mode,
      });
    }

    /** Replay envelope (spec §5): versioned, hashed, fully ordered. */
    replayEnvelope() {
      return {
        schema: REPLAY_SCHEMA,
        build: Content.BUILD_VERSION,
        contentVersion: Content.CONTENT_VERSION,
        rulesetVersion: Rules.RULESET_VERSION,
        contentId: this.level.id,
        seed: this.state.seed,
        config: {
          colors: this.state.colors, tubeCount: this.state.tubes.length,
          capacity: this.state.capacity, limits: this.state.limits,
        },
        initialHash: this.hashes[0].hash,
        timestampOffset: this.startedAt,
        commands: this.commands.slice(),
        hashes: this.hashes.slice(),
        terminal: this.terminalResult,
      };
    }

    /**
     * Validate a replay envelope by re-executing the command log through the
     * same rules engine. Returns {ok, reason?, finalHash}.
     */
    static validateReplay(envelope) {
      try {
        if (!envelope || envelope.schema !== REPLAY_SCHEMA) return { ok: false, reason: 'schema' };
        // The board must be rebuilt from the content record's own parameters,
        // never from client-supplied geometry (spec §6: untrusted claims).
        // Otherwise a trivially easy forged board could be passed off as a
        // hard journey/daily stage.
        const level = Content.levelById(envelope.contentId);
        if (!level) return { ok: false, reason: 'unknown-content' };
        const cfg = envelope.config || {};
        const normLimits = (l) => ({
          moves: l && Number.isInteger(l.moves) ? l.moves : null,
          timeMs: l && Number.isInteger(l.timeMs) ? l.timeMs : null,
          undo: !l || l.undo !== false,
        });
        const want = normLimits(level.limits);
        const got = normLimits(cfg.limits);
        // The timing-assist accessibility option legitimately widens a time
        // limit by 1.5x (main.js startLevel); it is declared in `assists`.
        const timeOk = got.timeMs === want.timeMs ||
          (want.timeMs !== null && got.timeMs === Math.floor(want.timeMs * 1.5));
        if ((envelope.seed >>> 0) !== (level.seed >>> 0) ||
            cfg.colors !== level.colors || cfg.tubeCount !== level.tubeCount ||
            cfg.capacity !== level.capacity ||
            got.moves !== want.moves || got.undo !== want.undo || !timeOk) {
          return { ok: false, reason: 'config-mismatch' };
        }
        let s = Rules.createState({
          contentId: envelope.contentId, seed: envelope.seed,
          colors: envelope.config.colors, tubeCount: envelope.config.tubeCount,
          capacity: envelope.config.capacity, limits: envelope.config.limits,
        });
        if (Rules.stateHash(s) !== envelope.initialHash) return { ok: false, reason: 'initial-hash' };
        let hi = 1;
        for (const cmd of envelope.commands) {
          const r = Rules.applyCommand(s, cmd);
          if (r.rejected && r.state === s && r.rejected.reason === Rules.INVALID.BAD_COMMAND) {
            return { ok: false, reason: 'bad-command' };
          }
          s = r.state;
          if (hi < envelope.hashes.length && envelope.hashes[hi].tick === s.tick) {
            if (envelope.hashes[hi].hash !== Rules.stateHash(s)) return { ok: false, reason: 'hash-mismatch@' + s.tick };
            hi++;
          }
        }
        if (!envelope.terminal) return { ok: false, reason: 'no-terminal' };
        if (s.status !== (envelope.terminal.won ? 'won' : 'lost')) return { ok: false, reason: 'terminal-mismatch' };
        const sc = Rules.score(s, { gold: 1, silver: 2, bronze: 3 }); // par-independent invariants
        if (sc.moves !== envelope.terminal.moves || sc.invalids !== envelope.terminal.invalids) {
          return { ok: false, reason: 'score-mismatch' };
        }
        // Authoritative metrics derived from the re-executed state and the
        // content record's par — the server stores these, never the client's
        // claimed score/duration (spec §6: "reject impossible… scores").
        const asc = Rules.score(s, Object.assign({ timeMs: level.parTimeMs }, level.par));
        return {
          ok: true, finalHash: Rules.stateHash(s), status: s.status, timingAssist: got.timeMs !== want.timeMs,
          score: asc.total, moves: s.moves, invalids: s.invalids,
          undos: s.undos, elapsedMs: s.elapsedMs, sessionId: s.sessionId,
        };
      } catch (e) {
        return { ok: false, reason: 'exception: ' + e.message };
      }
    }

    /** Serializable snapshot for "last safe local snapshot" / reconnect. */
    snapshot() {
      const state = JSON.parse(Rules.serialize(this.state));
      // Bake the live clock into the state so a restore carries the full
      // authoritative elapsed time forward instead of restarting at zero
      // (time limits and speed scoring must survive a reload).
      state.elapsedMs = this.elapsedMs();
      return JSON.stringify({
        v: 1, level: this.level, mode: this.mode,
        state,
        commands: this.commands, hashes: this.hashes,
        startedAt: this.startedAt, pausedTotal: this._pausedTotal + (this._pauseStart !== null ? this._now() - this._pauseStart : 0),
        finished: this.finished,
      });
    }

    static restore(json, opts) {
      const d = JSON.parse(json);
      if (d.v !== 1) throw new Error('unsupported snapshot version');
      const s = new GameSession(d.level, { mode: d.mode, now: opts && opts.now });
      s.state = Rules.deserialize(JSON.stringify(d.state));
      s.commands = d.commands || [];
      s.seenCommandIds = new Set(s.commands.map((c) => c.id));
      s.hashes = d.hashes || [{ tick: 0, hash: Rules.stateHash(s.state) }];
      // Clock restarts from the baked-in elapsed time; the old paused total
      // is already accounted for inside state.elapsedMs.
      s._carriedMs = s.state.elapsedMs || 0;
      s.startedAt = s._now();
      s._pausedTotal = 0;
      s.finished = !!d.finished;
      if (s.finished) s._finish();
      return s;
    }
  }

  return { GameSession, REPLAY_SCHEMA };
});
