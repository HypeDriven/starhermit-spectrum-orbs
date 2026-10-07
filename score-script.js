// score-script.js — StarHermit platform script that posts a single-player game's
// results to its own leaderboards. Canonical copy: tools/score-script.js; each game
// ships a copy as score-script.js (declared in starhermit.txt as server=score-script.js)
// with only the BOARDS block changed.
//
// Flow (StarHermit.submitScores in starhermit-sdk.js): the client opens a practice
// session (POST /games/{slug}/sessions/ai), sends {type:'result', scores:{key:n}} on
// the gameplay socket, and this script range-checks each score against its board and
// returns it in `scores`, then ends the session. Runs in the platform's Jint sandbox:
// one file, no imports, no Date/Math.random.
'use strict';

// BOARDS:BEGIN — JSON, read by tools/leaderboards.mjs to create the boards.
var BOARDS = {
  "high-score": { "name": "High score", "scoreType": "integer", "sortDirection": "desc", "minScore": 0, "maxScore": 1000000 }
};
// BOARDS:END

function valid(board, v) {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  if (board.scoreType !== 'decimal' && Math.floor(v) !== v) return false;
  if (board.scoreType === 'time-ms' && v < 0) return false;
  if (board.minScore != null && v < board.minScore) return false;
  if (board.maxScore != null && v > board.maxScore) return false;
  return true;
}

globalThis.game = {
  tickRateHz: 0,

  createSession: function (ctx) {
    return { ok: true, sessionState: { startedAt: ctx.now, summary: { status: 'active' } } };
  },

  onPlayerMessage: function (ctx) {
    var data = ctx.message.data || {};
    if (data.type !== 'result' || !data.scores || typeof data.scores !== 'object') {
      return { ok: false, error: 'Unknown command' };
    }
    var from = ctx.message.from;
    var scores = {}, accepted = [], n = 0;
    for (var key in BOARDS) {
      if (!Object.prototype.hasOwnProperty.call(BOARDS, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(data.scores, key) || n >= 16) continue;
      var v = data.scores[key];
      if (!valid(BOARDS[key], v)) continue;
      scores[key] = {}; scores[key][from] = v; accepted.push(key); n++;
    }
    var state = ctx.sessionState || {};
    state.summary = { status: 'finished' };
    return {
      ok: true,
      sessionState: state,
      scores: scores,
      broadcast: [{ to: [from], data: { type: 'result-ack', accepted: accepted } }],
      result: { kind: 'finished', reason: 'result' }
    };
  },

  onTick: function () { return { ok: true }; }
};
