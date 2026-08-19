/**
 * rules.js — Spectrum Orbs pure deterministic rules engine.
 *
 * No rendering, no DOM, no timers. Everything is a plain serializable object.
 * Shared between the browser client and the authoritative Node server script
 * (server.js) so replays validate byte-for-byte.
 *
 * Contract (spec §2):
 *  - legal-action queries:           legalActions(state), canMove(state, from, to)
 *  - deterministic resolution:       applyCommand(state, cmd) -> {state, events, rejected}
 *  - serializable state:             serialize(state) / deserialize(json)
 *  - monotonically increasing tick:  state.tick increments for every processed command
 *  - terminal-state reason:          state.status / state.terminalReason
 *
 * State invariants:
 *  - tubes are arrays of color indices, bottom -> top
 *  - every tube length <= capacity
 *  - total orb count per color == capacity (unless config.partial sets otherwise)
 */
(function (root, factory) {
  const rng = (typeof module === 'object' && module.exports)
    ? require('./rng.js')
    : root.SpectrumRng;
  const api = factory(rng);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpectrumRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rng) {
  'use strict';

  const STATE_VERSION = 2;
  const RULESET_VERSION = 1;

  const INVALID = Object.freeze({
    TERMINAL: 'terminal',
    OUT_OF_BOUNDS: 'out-of-bounds',
    EMPTY_SOURCE: 'empty-source',
    SAME_TUBE: 'same-tube',
    TARGET_FULL: 'target-full',
    COLOR_MISMATCH: 'color-mismatch',
    UNDO_DISABLED: 'undo-disabled',
    NOTHING_TO_UNDO: 'nothing-to-undo',
    BAD_COMMAND: 'bad-command',
  });

  // ---------------------------------------------------------------- state --

  /**
   * Create a fresh state from a content definition.
   * config: {
   *   contentId, seed, capacity, colors, tubeCount, stacks? (authored layout),
   *   shuffleMoves?, limits? {moves, timeMs, undo}, assists? {hints}
   * }
   */
  function createState(config) {
    if (!config || typeof config.seed === 'undefined') throw new Error('config.seed required');
    const capacity = config.capacity || 4;
    const colors = config.colors;
    const tubeCount = config.tubeCount;
    if (!Number.isInteger(colors) || colors < 2) throw new Error('colors must be an integer >= 2');
    if (!Number.isInteger(tubeCount) || tubeCount < colors) throw new Error('tubeCount must be >= colors');

    let tubes;
    if (config.stacks) {
      tubes = config.stacks.map((t) => t.slice());
      const err = validateLayout(tubes, capacity, colors, tubeCount);
      if (err) throw new Error('authored layout invalid: ' + err);
    } else {
      tubes = generateLayout(config.seed, colors, tubeCount, capacity, config.shuffleMoves);
    }

    const state = {
      version: STATE_VERSION,
      rulesetVersion: RULESET_VERSION,
      contentId: config.contentId || 'adhoc',
      sessionId: new Rng.RandomStream(config.seed, 'session').hexId(8),
      seed: config.seed >>> 0,
      tick: 0,
      capacity,
      colors,
      tubes,
      selected: null, // UI echo only; never affects legality
      status: 'active',
      terminalReason: null,
      moves: 0,
      invalids: 0,
      undos: 0,
      hintsUsed: 0,
      elapsedMs: 0,
      limits: {
        moves: config.limits && Number.isInteger(config.limits.moves) ? config.limits.moves : null,
        timeMs: config.limits && Number.isInteger(config.limits.timeMs) ? config.limits.timeMs : null,
        undo: !config.limits || config.limits.undo !== false,
      },
      history: [],   // complete event log including undos (spec: preserve undo history)
      undoStack: [], // snapshots taken before each committed move
    };
    return checkTerminal(state);
  }

  function validateLayout(tubes, capacity, colors, tubeCount) {
    if (tubes.length !== tubeCount) return 'tube count mismatch';
    const counts = new Array(colors).fill(0);
    for (const tube of tubes) {
      if (tube.length > capacity) return 'tube over capacity';
      for (const c of tube) {
        if (!Number.isInteger(c) || c < 0 || c >= colors) return 'color out of range';
        counts[c]++;
      }
    }
    for (let c = 0; c < colors; c++) {
      if (counts[c] !== capacity) return 'color ' + c + ' count ' + counts[c] + ' != capacity';
    }
    return null;
  }

  /**
   * Generate a solvable puzzle by performing random legal moves away from the
   * solved state, then verifying with the solver (bounded). Retries with a
   * derived seed until a verified-solvable, non-trivial layout is found.
   */
  function generateLayout(seed, colors, tubeCount, capacity, shuffleMoves) {
    const scramble = shuffleMoves || Math.max(24, colors * capacity * 4);
    const spare = tubeCount - colors;
    for (let attempt = 0; attempt < 64; attempt++) {
      const rng = new Rng.RandomStream((seed + attempt * 0x9e3779b9) >>> 0, 'gen');
      // Deal all orbs round-robin into `colors` full tubes, each explicitly
      // mixed so no tube is monochrome at rest. Spare tubes start empty.
      const pool = [];
      for (let c = 0; c < colors; c++) for (let i = 0; i < capacity; i++) pool.push(c);
      rng.shuffle(pool);
      const tubes = [];
      for (let t = 0; t < colors; t++) tubes.push(pool.slice(t * capacity, (t + 1) * capacity));
      for (let t = 0; t < spare; t++) tubes.push([]);
      for (const tube of tubes) {
        if (tube.length === capacity && tube.every((c) => c === tube[0])) {
          // Swap one orb with a different-colored orb in another tube.
          for (let t2 = 0; t2 < tubes.length; t2++) {
            const idx = tubes[t2].findIndex((c) => c !== tube[0]);
            if (idx >= 0) {
              const swapIdx = tube.findIndex((c) => c !== tubes[t2][idx]);
              if (swapIdx >= 0) {
                const tmp = tube[swapIdx]; tube[swapIdx] = tubes[t2][idx]; tubes[t2][idx] = tmp;
              }
              break;
            }
          }
        }
      }
      // Extra deterministic legal-move scrambling adds depth beyond the deal.
      let last = null;
      for (let i = 0; i < scramble; i++) {
        const moves = rawLegalMoves(tubes, capacity)
          .filter((m) => !last || !(m.from === last.to && m.to === last.from));
        if (!moves.length) break;
        const m = moves[rng.int(0, moves.length - 1)];
        tubes[m.to].push(tubes[m.from].pop());
        last = m;
      }
      if (isWinLayout(tubes, capacity)) continue; // reject trivial
      // Validator at generation time: proven solvable, no soft lock (spec §2).
      // Clone: the solver leaves its working layout in the solved state.
      // Also enforce a minimum solution depth so boards are never near-solved.
      const sol = solveLayout(cloneTubes(tubes), capacity, { maxNodes: 400000 });
      const minDepth = Math.max(6, Math.round(colors * capacity * 0.8));
      if (sol && sol.length >= minDepth) return tubes;
    }
    // Deterministic fallback: rotating interleave, always solvable with a spare.
    const tubes = [];
    for (let t = 0; t < tubeCount; t++) tubes.push([]);
    for (let layer = 0; layer < capacity; layer++) {
      for (let c = 0; c < colors; c++) tubes[c].push((c + layer) % colors);
    }
    return tubes;
  }

  // ------------------------------------------------------------- queries --

  function topColor(tube) { return tube.length ? tube[tube.length - 1] : null; }

  /** Raw legality on a bare layout (used by generator + solver). */
  function rawLegalMoves(tubes, capacity) {
    const out = [];
    for (let from = 0; from < tubes.length; from++) {
      if (!tubes[from].length) continue;
      const color = tubes[from][tubes[from].length - 1];
      for (let to = 0; to < tubes.length; to++) {
        if (to === from || tubes[to].length >= capacity) continue;
        if (tubes[to].length === 0 || tubes[to][tubes[to].length - 1] === color) out.push({ from, to });
      }
    }
    return out;
  }

  /**
   * Check a specific move. Returns {ok:true} or {ok:false, reason} where
   * reason is one of INVALID — this is the single source of invalid-action
   * explanations used by UI, tutorials, and the server validator.
   */
  function canMove(state, from, to) {
    if (state.status !== 'active') return { ok: false, reason: INVALID.TERMINAL };
    if (!Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to < 0 || from >= state.tubes.length || to >= state.tubes.length) {
      return { ok: false, reason: INVALID.OUT_OF_BOUNDS };
    }
    if (from === to) return { ok: false, reason: INVALID.SAME_TUBE };
    const src = state.tubes[from];
    const dst = state.tubes[to];
    if (!src.length) return { ok: false, reason: INVALID.EMPTY_SOURCE };
    if (dst.length >= state.capacity) return { ok: false, reason: INVALID.TARGET_FULL };
    const dstTop = topColor(dst);
    if (dstTop !== null && dstTop !== topColor(src)) return { ok: false, reason: INVALID.COLOR_MISMATCH };
    return { ok: true };
  }

  /** All currently legal moves — the same API hints and tutorials call. */
  function legalActions(state) {
    if (state.status !== 'active') return [];
    return rawLegalMoves(state.tubes, state.capacity)
      .map((m) => ({ type: 'move', from: m.from, to: m.to }));
  }

  function isWinLayout(tubes, capacity) {
    return tubes.every((t) =>
      t.length === 0 ||
      (t.length === capacity && t.every((c) => c === t[0])));
  }

  function isWin(state) { return isWinLayout(state.tubes, state.capacity); }

  function checkTerminal(state) {
    if (state.status !== 'active') return state;
    if (isWin(state)) {
      state.status = 'won';
      state.terminalReason = 'completed';
    } else if (state.limits.moves !== null && state.moves >= state.limits.moves) {
      state.status = 'lost';
      state.terminalReason = 'move-limit-exceeded';
    } else if (state.limits.timeMs !== null && state.elapsedMs >= state.limits.timeMs) {
      state.status = 'lost';
      state.terminalReason = 'time-expired';
    } else if (rawLegalMoves(state.tubes, state.capacity).length === 0) {
      state.status = 'lost';
      state.terminalReason = 'no-legal-moves';
    }
    return state;
  }

  // ------------------------------------------------------------ commands --

  let cmdCounter = 0;
  function nextCommandId() {
    cmdCounter = (cmdCounter + 1) >>> 0;
    return 'cmd-' + Date.now().toString(36) + '-' + cmdCounter.toString(36);
  }

  function cloneTubes(tubes) { return tubes.map((t) => t.slice()); }

  function snapshotForUndo(state) {
    return {
      tick: state.tick,
      tubes: cloneTubes(state.tubes),
      moves: state.moves,
      invalids: state.invalids,
      elapsedMs: state.elapsedMs,
      status: state.status,
      terminalReason: state.terminalReason,
    };
  }

  /**
   * Apply a validated command. Returns a NEW state; the input is not mutated.
   * cmd: {id?, type:'move'|'undo'|'concede'|'tick-clock', from?, to?, elapsedMs?}
   * Every processed command increments tick (monotonic turn counter) and is
   * appended to history, so replays and tie-breaks are fully determined by the
   * ordered command log.
   */
  function applyCommand(prev, cmd) {
    if (!cmd || typeof cmd.type !== 'string') {
      return { state: prev, events: [], rejected: { reason: INVALID.BAD_COMMAND } };
    }
    const state = Object.assign({}, prev, {
      tubes: cloneTubes(prev.tubes),
      history: prev.history.slice(),
      undoStack: prev.undoStack.slice(),
      limits: Object.assign({}, prev.limits),
    });
    const events = [];
    const entry = { tick: state.tick + 1, type: cmd.type };
    if (cmd.id) entry.id = String(cmd.id).slice(0, 64);
    if (Number.isFinite(cmd.elapsedMs)) state.elapsedMs = Math.max(state.elapsedMs, Math.floor(cmd.elapsedMs));

    switch (cmd.type) {
      case 'move': {
        entry.from = cmd.from; entry.to = cmd.to;
        if (state.status !== 'active') {
          state.tick++;
          state.history.push(entry);
          return { state, events, rejected: { reason: INVALID.TERMINAL } };
        }
        const verdict = canMove(state, cmd.from, cmd.to);
        if (!verdict.ok) {
          state.tick++;
          state.invalids++;
          entry.reason = verdict.reason;
          state.history.push(entry);
          events.push({ type: 'invalid', from: cmd.from, to: cmd.to, reason: verdict.reason });
          checkTerminal(state); // time limit may have elapsed
          return { state, events, rejected: verdict };
        }
        state.undoStack.push(snapshotForUndo(state));
        const orb = state.tubes[cmd.from].pop();
        state.tubes[cmd.to].push(orb);
        state.moves++;
        state.tick++;
        entry.orb = orb;
        state.history.push(entry);
        events.push({ type: 'move', from: cmd.from, to: cmd.to, orb, tick: state.tick });
        checkTerminal(state);
        if (state.status === 'won') events.push({ type: 'won', tick: state.tick });
        if (state.status === 'lost') events.push({ type: 'lost', reason: state.terminalReason });
        return { state, events, rejected: null };
      }
      case 'undo': {
        state.tick++;
        if (!state.limits.undo) {
          state.invalids++;
          entry.reason = INVALID.UNDO_DISABLED;
          state.history.push(entry);
          events.push({ type: 'invalid', reason: INVALID.UNDO_DISABLED });
          return { state, events, rejected: { reason: INVALID.UNDO_DISABLED } };
        }
        if (!state.undoStack.length) {
          state.invalids++;
          entry.reason = INVALID.NOTHING_TO_UNDO;
          state.history.push(entry);
          events.push({ type: 'invalid', reason: INVALID.NOTHING_TO_UNDO });
          return { state, events, rejected: { reason: INVALID.NOTHING_TO_UNDO } };
        }
        const snap = state.undoStack.pop();
        entry.restoredTick = snap.tick;
        state.tubes = snap.tubes;
        state.moves = snap.moves;
        state.invalids = snap.invalids;
        state.elapsedMs = Math.max(state.elapsedMs, snap.elapsedMs);
        state.status = snap.status === 'active' ? 'active' : 'active'; // undo revives terminal boards
        state.terminalReason = null;
        state.undos++;
        state.history.push(entry);
        events.push({ type: 'undo', tick: state.tick });
        return { state, events, rejected: null };
      }
      case 'concede': {
        state.tick++;
        state.history.push(entry);
        if (state.status === 'active') {
          state.status = 'lost';
          state.terminalReason = 'abandoned';
          events.push({ type: 'lost', reason: 'abandoned' });
        }
        return { state, events, rejected: null };
      }
      case 'tick-clock': {
        state.tick++;
        state.history.push(entry);
        checkTerminal(state);
        if (state.status === 'lost' && state.terminalReason === 'time-expired') {
          events.push({ type: 'lost', reason: 'time-expired' });
        }
        return { state, events, rejected: null };
      }
      default:
        return { state: prev, events: [], rejected: { reason: INVALID.BAD_COMMAND } };
    }
  }

  // ------------------------------------------------------------- scoring --

  /**
   * Integer-only score with component breakdown (spec: no unexplained total).
   * par: {gold, silver, bronze} move thresholds; parTimeMs optional.
   */
  function score(state, par) {
    const p = par || { gold: 20, silver: 30, bronze: 45 };
    const won = state.status === 'won';
    const base = won ? 1000 : 0;
    const efficiency = won ? Math.max(0, (p.bronze + p.gold - state.moves)) * 10 : 0;
    const speed = won && p.timeMs ? Math.max(0, Math.floor((p.timeMs - state.elapsedMs) / 1000)) * 5 : 0;
    const invalidPenalty = -25 * state.invalids;
    const undoPenalty = -15 * state.undos;
    let medal = null;
    if (won) {
      if (state.moves <= p.gold) medal = 'gold';
      else if (state.moves <= p.silver) medal = 'silver';
      else if (state.moves <= p.bronze) medal = 'bronze';
      else medal = 'clear';
    }
    const medalBonus = { gold: 500, silver: 250, bronze: 100, clear: 0 }[medal] || 0;
    const total = Math.max(0, base + efficiency + speed + invalidPenalty + undoPenalty + medalBonus);
    return {
      won, base, efficiency, speed, invalidPenalty, undoPenalty, medalBonus,
      medal, moves: state.moves, invalids: state.invalids, undos: state.undos,
      elapsedMs: state.elapsedMs, total,
    };
  }

  /**
   * Tie-break order (spec §2): completion, fewer invalid actions, lower
   * authoritative elapsed time, then stable session identifier.
   * Returns negative if a ranks better than b.
   */
  function compareResults(a, b) {
    if (!!a.won !== !!b.won) return a.won ? -1 : 1;
    if (a.invalids !== b.invalids) return a.invalids - b.invalids;
    if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
    if (a.total !== b.total) return b.total - a.total;
    return String(a.sessionId).localeCompare(String(b.sessionId));
  }

  // ------------------------------------------------------- serialization --

  function serialize(state) {
    return JSON.stringify(state);
  }

  /** Deserialize with forward migration. Throws on corrupt data. */
  function deserialize(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    if (!s || typeof s !== 'object') throw new Error('not a state object');
    if (s.version === 1) {
      // v1 -> v2: invalids/sessionId/limits.undo were introduced in v2.
      s.invalids = s.invalids || 0;
      s.sessionId = s.sessionId || 'legacy';
      s.limits = Object.assign({ moves: null, timeMs: null, undo: true }, s.limits);
      s.version = 2;
    }
    if (s.version !== STATE_VERSION) throw new Error('unsupported state version ' + s.version);
    const err = validateLayout(s.tubes, s.capacity, s.colors, s.tubes.length);
    if (err) throw new Error('corrupt state: ' + err);
    return s;
  }

  /** Stable hash of the meaningful simulation fields (replay envelope). */
  function stateHash(state) {
    const s = JSON.stringify([
      state.tick, state.tubes, state.moves, state.invalids, state.undos,
      state.status, state.terminalReason,
    ]);
    return Rng.hashString(s).toString(16).padStart(8, '0');
  }

  // -------------------------------------------------------------- solver --

  function layoutKey(tubes) {
    // Canonical key: tubes are interchangeable, so sort their string forms.
    return tubes.map((t) => t.join(',')).sort().join('|');
  }

  /**
   * Bounded DFS solver with memoization. Returns an array of {from,to} moves
   * to a win, or null if unsolved within budget. Used by content validators
   * and the hint system (same legal-action rules as play).
   */
  function solveLayout(tubes, capacity, opts) {
    const maxNodes = (opts && opts.maxNodes) || 200000;
    let nodes = 0;
    const seen = new Set();
    const path = [];

    function wonHere() {
      for (const t of tubes) {
        if (t.length === 0) continue;
        if (t.length !== capacity) return false;
        for (let i = 1; i < t.length; i++) if (t[i] !== t[0]) return false;
      }
      return true;
    }

    function dfs(depth) {
      if (wonHere()) return true;
      if (++nodes > maxNodes) return false;
      const key = layoutKey(tubes);
      if (seen.has(key)) return false;
      seen.add(key);
      // Order moves: completing tubes and same-color stacks first.
      const moves = rawLegalMoves(tubes, capacity).filter((m) => {
        const src = tubes[m.from];
        // Never pour a complete monochrome tube into an empty one (pointless).
        if (tubes[m.to].length === 0 &&
            src.length === capacity && src.every((c) => c === src[0])) return false;
        return true;
      }).sort((a, b) => scoreMove(b) - scoreMove(a));
      for (const m of moves) {
        tubes[m.to].push(tubes[m.from].pop());
        path.push(m);
        if (dfs(depth + 1)) return true;
        path.pop();
        tubes[m.from].push(tubes[m.to].pop());
        if (nodes > maxNodes) return false;
      }
      return false;
    }

    function scoreMove(m) {
      const dst = tubes[m.to];
      let s = 0;
      if (dst.length > 0) s += 2; // stacking beats parking
      if (dst.length === capacity - 1) s += 3; // completes a tube
      return s;
    }

    return dfs(0) ? path.slice() : null;
  }

  function solve(state, opts) {
    const tubes = cloneTubes(state.tubes);
    return solveLayout(tubes, state.capacity, opts);
  }

  /**
   * Suggest a move for the hint system. Uses the solver when budget allows,
   * otherwise falls back to a heuristic over legalActions — never a
   * duplicate rule set.
   */
  function hint(state) {
    const actions = legalActions(state);
    if (!actions.length) return null;
    const solution = solve(state, { maxNodes: 50000 });
    if (solution && solution.length) return { from: solution[0].from, to: solution[0].to, certain: true };
    // Heuristic: prefer same-color stacks, avoid immediately reversible parks.
    const last = state.history[state.history.length - 1];
    const scored = actions.map((a) => {
      let s = 0;
      const dst = state.tubes[a.to];
      if (dst.length > 0) s += 2;
      if (dst.length === state.capacity - 1) s += 3;
      if (last && last.type === 'move' && last.from === a.to && last.to === a.from) s -= 4;
      return { a, s };
    }).sort((x, y) => y.s - x.s);
    return { from: scored[0].a.from, to: scored[0].a.to, certain: false };
  }

  return {
    STATE_VERSION, RULESET_VERSION, INVALID,
    createState, validateLayout, generateLayout,
    canMove, legalActions, isWin, checkTerminal,
    applyCommand, nextCommandId,
    score, compareResults,
    serialize, deserialize, stateHash,
    solve, solveLayout, hint, topColor, cloneTubes,
  };
});
