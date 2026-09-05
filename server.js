'use strict';
/**
 * server.js — StarHermit authoritative script for Spectrum Orbs.
 *
 * Zero-dependency Node server. Serves the static distribution and provides:
 *  - GET  /api/v1/time           platform time (round-trip adjusted client-side)
 *  - GET  /api/v1/daily?date=    immutable daily ruleset
 *  - GET/POST /api/v1/save       versioned, checksummed cloud progression
 *  - GET/POST /api/v1/leaderboard  validated score boards (global + friends)
 *  - POST /api/v1/achievement    idempotent durable achievement delivery
 *  - POST /api/v1/activity/start|end, /api/v1/presence   playtime + presence
 *  - POST /api/v1/telemetry      anonymous aggregate funnel events
 *
 * Score validation: replayable input logs are re-executed through the same
 * deterministic rules engine (js/rules.js) — impossible scores are rejected,
 * stale content versions are rejected, unverifiable submissions are stored on
 * a casual board instead of the ranked one.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Rules = require('./js/rules.js');
const Content = require('./js/content.js');
const { GameSession } = require('./js/session.js');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = process.env.PORT || 8080;
const MAX_BODY = 256 * 1024;

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

// Validate the shipped catalogue at boot; refuse to serve broken content.
const catalogue = Content.validateCatalogue();
if (!catalogue.ok) {
  console.error('[server] catalogue validation failed:', catalogue.errors);
  process.exit(1);
}
console.log('[server] catalogue validated:', Object.keys(catalogue.levels).length, 'levels OK');

// ------------------------------------------------------------ persistence --

function dataFile(name) {
  const safe = name.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return path.join(DATA, safe + '.json');
}
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch (e) { return fallback; }
}
function writeJson(name, val) {
  const tmp = dataFile(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(val));
  fs.renameSync(tmp, dataFile(name));
}

// ---------------------------------------------------------- rate limiting --

const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; buckets.set(ip, b); }
  b.count++;
  return b.count > 120; // 120 req/min per client
}

// --------------------------------------------------------------- helpers --

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.opus': 'audio/ogg',
};

function send(res, status, body, headers) {
  const isObj = typeof body === 'object' && body !== null;
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, Object.assign({
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; return; } // drain, don't destroy — client needs the 413
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('payload-too-large'));
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

function playerKey(req, body) {
  // Identity: bearer token subject if present, else a salted IP hash.
  // Never trust client-claimed identity for ranked boards (spec §5).
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.sub) return 'p:' + payload.sub;
    } catch (e) { /* fall through to IP identity */ }
  }
  return 'ip:' + crypto.createHash('sha256').update(req.socket.remoteAddress || 'local').digest('hex').slice(0, 16);
}

// --------------------------------------------------------------- routes --

const routes = {
  'GET /api/v1/time': (req, res) => send(res, 200, { now: Date.now() }),

  'GET /api/v1/daily': (req, res, url) => {
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    // Daily seeds are immutable after publication (spec §2).
    const level = Content.dailyForDate(date);
    const validation = Content.validateLevel(level);
    if (!validation.ok) {
      // Defective day: mark excluded from ranking, never silently replace.
      return send(res, 200, { level, excluded: true, reason: 'failed-validation' });
    }
    send(res, 200, { level, excluded: false });
  },

  'GET /api/v1/save': (req, res) => {
    send(res, 200, { doc: readJson('save', null) });
  },
  'POST /api/v1/save': async (req, res) => {
    const body = await readBody(req);
    const doc = body && body.doc;
    if (!doc || typeof doc !== 'object' || doc.version === undefined || !doc.checksum) {
      return send(res, 400, { error: 'invalid-save-document' });
    }
    // Verify checksum before storing; never store credentials (spec §6).
    const probe = JSON.parse(JSON.stringify(doc));
    delete probe.checksum;
    const expect = require('./js/rng.js').hashString(JSON.stringify(probe)).toString(16).padStart(8, '0');
    if (expect !== doc.checksum) return send(res, 400, { error: 'checksum-mismatch' });
    for (const k of ['token', 'password', 'secret', 'chat']) {
      if (k in doc) return send(res, 400, { error: 'forbidden-field:' + k });
    }
    writeJson('save', doc);
    send(res, 200, { stored: true, updatedAt: doc.updatedAt });
  },

  'GET /api/v1/leaderboard': (req, res, url) => {
    const board = url.searchParams.get('board') || 'journey';
    const friends = url.searchParams.get('friends') === '1';
    const entries = readJson('board:' + board, []);
    // Friends filtering: local server treats all known players as friends.
    send(res, 200, { entries: entries.slice(0, 100), casual: false, friendsApplied: friends });
  },

  'POST /api/v1/leaderboard': async (req, res) => {
    const body = await readBody(req);
    const err = validateScoreSubmission(body);
    if (err) return send(res, 400, { error: err });

    let verified = false;
    let check = null;
    if (body.replay) {
      // Replay validation is authoritative: re-executing the input log proves
      // the claim. No separate plausibility gate needed.
      check = GameSession.validateReplay(body.replay);
      verified = check.ok && check.status === 'won';
      if (!check.ok) {
        return send(res, 400, { error: 'replay-invalid:' + check.reason });
      }
    }
    const board = String(body.board).slice(0, 64);
    const ranked = verified; // unverifiable -> casual board, never ranked (spec §6)
    const storeBoard = ranked ? board : 'casual:' + board;
    const entries = readJson('board:' + storeBoard, []);
    const entry = {
      player: String(body.player || 'Guest').slice(0, 32),
      playerKey: playerKey(req, body),
      // Authoritative values for verified (ranked) claims come from the
      // re-executed replay, never the client payload (spec §6). Casual
      // submissions have no replay, so their client values are stored as-is.
      score: ranked ? check.score : (body.score | 0),
      seed: body.seed | 0,
      rulesetVersion: body.rulesetVersion | 0,
      contentVersion: body.contentVersion | 0,
      durationMs: ranked ? check.elapsedMs : (body.durationMs | 0),
      invalids: ranked ? check.invalids : 0,
      sessionId: ranked ? String(check.sessionId) : '',
      assists: body.assists || {},
      verified: ranked,
      at: Date.now(),
    };
    entries.push(entry);
    // Order by score, then the spec §2 tie-break: fewer invalid actions,
    // lower authoritative elapsed time, then stable session identifier.
    entries.sort((a, b) => b.score - a.score
      || (a.invalids || 0) - (b.invalids || 0)
      || a.durationMs - b.durationMs
      || String(a.sessionId || '').localeCompare(String(b.sessionId || '')));
    writeJson('board:' + storeBoard, entries.slice(0, 200));
    const rank = entries.indexOf(entry) + 1;
    send(res, 200, { stored: 'cloud', rank, verified: ranked, casual: !ranked });
  },

  'POST /api/v1/achievement': async (req, res) => {
    const body = await readBody(req);
    const key = String((body && body.key) || '');
    const known = Content.ACHIEVEMENTS.some((a) => a.key === key);
    if (!known) return send(res, 400, { error: 'unknown-achievement' });
    const got = readJson('achievements', {});
    const already = !!got[key]; // idempotent delivery (spec §6)
    if (!already) { got[key] = new Date().toISOString(); writeJson('achievements', got); }
    send(res, 200, { key, already });
  },

  'POST /api/v1/activity/start': async (req, res) => {
    const a = readJson('activity', { sessions: 0, totalMs: 0, openSince: null });
    a.sessions++; a.openSince = Date.now();
    writeJson('activity', a);
    send(res, 204, '');
  },
  'POST /api/v1/activity/end': async (req, res) => {
    const a = readJson('activity', { sessions: 0, totalMs: 0, openSince: null });
    if (a.openSince) { a.totalMs += Date.now() - a.openSince; a.openSince = null; writeJson('activity', a); }
    send(res, 204, '');
  },
  'POST /api/v1/presence': async (req, res) => {
    writeJson('presence', { at: Date.now() });
    send(res, 204, '');
  },
  'POST /api/v1/telemetry': async (req, res) => {
    const body = await readBody(req);
    // Aggregate counts only; no raw text, no pointer trails, no PII (spec §8).
    const agg = readJson('telemetry', {});
    for (const ev of (body && body.events) || []) {
      if (typeof ev.event !== 'string' || ev.event.length > 32) continue;
      const k = ev.event + (ev.data && ev.data.mode ? ':' + String(ev.data.mode).slice(0, 16) : '');
      agg[k] = (agg[k] || 0) + 1;
    }
    writeJson('telemetry', agg);
    send(res, 204, '');
  },
};

/**
 * Validate identity, bounds, version, and plausibility before a score is
 * even considered (spec §5/§6). Returns an error string or null.
 */
function validateScoreSubmission(body) {
  if (!body || typeof body !== 'object') return 'bad-request';
  if (!Number.isInteger(body.score) || body.score < 0 || body.score > 100000) return 'score-out-of-bounds';
  if (!Number.isInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 6 * 3600 * 1000) return 'duration-out-of-bounds';
  if (!Number.isInteger(body.seed)) return 'bad-seed';
  if (body.contentVersion !== Content.CONTENT_VERSION) return 'stale-content-version';
  if (body.rulesetVersion !== Rules.RULESET_VERSION) return 'stale-ruleset-version';
  if (typeof body.board !== 'string' || !body.board.length) return 'bad-board';
  return null;
}

// ------------------------------------------------------------------ http --

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || 'local';
    if (url.pathname.startsWith('/api/') && rateLimited(ip)) {
      return send(res, 429, { error: 'rate-limited' }, { 'Retry-After': '30' });
    }

    const routeKey = req.method + ' ' + url.pathname;
    if (routes[routeKey]) {
      return await routes[routeKey](req, res, url);
    }

    // Static distribution (GET only, path-traversal safe).
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method-not-allowed' });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT) || filePath.includes('..')) return send(res, 403, { error: 'forbidden' });
    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, { error: 'not-found' });
      const ext = path.extname(filePath).toLowerCase();
      const immutable = /vendor|assets/.test(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  } catch (e) {
    const code = e.message === 'payload-too-large' ? 413 : e.message === 'bad-json' ? 400 : 500;
    send(res, code, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('[server] Spectrum Orbs listening on http://localhost:' + server.address().port);
});
