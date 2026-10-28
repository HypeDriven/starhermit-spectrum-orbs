/* Spectrum Orbs — the save model, pure (no storage, no platform):
 *  - the progression document (journey, challenges, dailies, streak,
 *    achievements, stats) and its two-device merge, exactly as the browser
 *    build's js/platform.js kept them (defaultProgression, mergeProgression,
 *    checksum);
 *  - the engine save ({ v, progression, settings }): the progression plus the
 *    game's own preferences (palette, camera, left-handed rails, hold to
 *    select, timing assist, haptics, lessons done); mergeDocs keeps the best
 *    of both progressions and this device's preferences;
 *  - what the browser build left in the player's account: the cloud slot
 *    game:<slug> held the progression document as JSON (the JS SDK's
 *    saveJSON; a broken checksum is refused, as syncProgression did), and the
 *    per-player settings KV held SYNCED_SETTINGS. The game's preferences carry
 *    over (legacyPreferences); volumes, mute, graphics, reduced motion,
 *    contrast, larger text and the language are the runtime's Options now,
 *    and every old key is removed once read (isBrowserKey).
 * UMD: globalThis.SOProgress (loadClassic) / Node (require).
 */
(function (root, factory) {
  var Rng = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.SpectrumRng;
  var api = factory(Rng);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SOProgress = api;
})(globalThis, function (Rng) {
  'use strict';

  var PROGRESSION_VERSION = 1;
  var SAVE_VERSION = 1;

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

  /** platform.js mergeProgression: nothing from either side is dropped. */
  function mergeProgression(a, b) {
    var base = defaultProgression();
    var A = Object.assign(defaultProgression(), a || {}), B = Object.assign(defaultProgression(), b || {});
    var obj = function (o) { return (o && typeof o === 'object' && !Array.isArray(o) ? o : {}); };
    var better = function (x, y) {
      var out = Object.assign({}, obj(x));
      Object.keys(obj(y)).forEach(function (k) {
        var v = obj(y)[k], cur = out[k];
        if (!cur || (v && ((v.won && !cur.won) || (!!v.won === !!cur.won && (Number(v.score) || 0) > (Number(cur.score) || 0))))) out[k] = v;
      });
      return out;
    };
    var achievements = Object.assign({}, obj(A.achievements));
    Object.keys(obj(B.achievements)).forEach(function (k) {
      var v = obj(B.achievements)[k];
      if (!achievements[k] || (v && String(v) < String(achievements[k]))) achievements[k] = v;
    });
    var stats = {};
    var keys = {};
    [base.stats, obj(A.stats), obj(B.stats)].forEach(function (s) { Object.keys(s).forEach(function (k) { keys[k] = true; }); });
    Object.keys(keys).forEach(function (k) { stats[k] = Math.max(Number(obj(A.stats)[k]) || 0, Number(obj(B.stats)[k]) || 0); });
    var sa = obj(A.streak), sb = obj(B.streak);
    var streak = String(sa.lastDate || '') > String(sb.lastDate || '') ? sa
      : String(sb.lastDate || '') > String(sa.lastDate || '') ? sb
      : ((sa.count || 0) >= (sb.count || 0) ? sa : sb);
    var out = Object.assign({}, A, B, {
      version: PROGRESSION_VERSION,
      journey: better(A.journey, B.journey),
      challenges: better(A.challenges, B.challenges),
      dailies: better(A.dailies, B.dailies),
      streak: { count: streak.count || 0, lastDate: streak.lastDate || null },
      achievements: achievements, stats: stats,
      updatedAt: Math.max(Number(A.updatedAt) || 0, Number(B.updatedAt) || 0),
    });
    delete out.checksum;
    return out;
  }

  function checksum(doc) {
    var clone = JSON.parse(JSON.stringify(doc));
    delete clone.checksum;
    return Rng.hashString(JSON.stringify(clone)).toString(16).padStart(8, '0');
  }

  // -- the game's own preferences -----------------------------------------------------------
  var GAME_KEYS = {
    palette: function (v) { return v === 'default' || v === 'cvd' || v === 'contrast'; },
    camera: function (v) { return v === 'default' || v === 'close' || v === 'wide'; },
    leftHanded: function (v) { return typeof v === 'boolean'; },
    holdToSelect: function (v) { return typeof v === 'boolean'; },
    timingAssist: function (v) { return typeof v === 'boolean'; },
    haptics: function (v) { return typeof v === 'boolean'; },
    tutorialDone: function (v) { return typeof v === 'boolean'; },
  };
  function defaultSettings() {
    return { palette: 'default', camera: 'default', leftHanded: false, holdToSelect: false, timingAssist: false, haptics: true, tutorialDone: false };
  }
  /** platform.js SYNCED_SETTINGS: every key the browser build mirrored to the account's settings. */
  var BROWSER_KEYS = ['audio', 'graphics', 'palette', 'camera', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded',
    'holdToSelect', 'timingAssist', 'haptics', 'tutorialDone'];

  /** The account's old settings (key → value) → the game's preferences. */
  function legacyPreferences(kv) {
    var out = {};
    var k = kv && typeof kv === 'object' ? kv : {};
    Object.keys(GAME_KEYS).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(k, key) && GAME_KEYS[key](k[key])) out[key] = k[key];
    });
    return out;
  }
  /** Whether an account settings key is the browser build's (removed once migrated; ui.* is sh-language.js's). */
  function isBrowserKey(key) { return BROWSER_KEYS.indexOf(key) >= 0 || String(key).indexOf('ui.') === 0; }

  function cleanSettings(s) {
    var out = defaultSettings();
    var src = s && typeof s === 'object' ? s : {};
    Object.keys(GAME_KEYS).forEach(function (key) { if (GAME_KEYS[key](src[key])) out[key] = src[key]; });
    return out;
  }
  function cleanProgression(p) {
    if (!p || typeof p !== 'object' || p.version !== PROGRESSION_VERSION) return defaultProgression();
    var out = Object.assign(defaultProgression(), p);
    delete out.checksum;
    return out;
  }

  // -- the engine save ----------------------------------------------------------------------
  function fresh() { return { v: SAVE_VERSION, progression: defaultProgression(), settings: defaultSettings() }; }
  /** A stored save → a clean document (null when it is not one). */
  function migrate(doc) {
    if (!doc || typeof doc !== 'object' || doc.v !== SAVE_VERSION) return null;
    return { v: SAVE_VERSION, progression: cleanProgression(doc.progression), settings: cleanSettings(doc.settings) };
  }
  /** Best of both progressions; this device's (`local`) preferences. */
  function mergeDocs(remote, local) {
    var r = migrate(remote), l = migrate(local);
    if (!r && !l) return fresh();
    return {
      v: SAVE_VERSION,
      progression: mergeProgression(r ? r.progression : null, l ? l.progression : null),
      settings: (l || r).settings,
    };
  }

  /** The browser build's cloud save text: its progression, or null (unparsable, another version or a broken checksum). */
  function fromBrowserSave(text) {
    if (typeof text !== 'string' || !text) return null;
    var doc;
    try { doc = JSON.parse(text); } catch (e) { return null; }
    if (!doc || typeof doc !== 'object' || doc.version !== PROGRESSION_VERSION) return null;
    if (doc.checksum && doc.checksum !== checksum(doc)) return null;
    return cleanProgression(doc);
  }

  return {
    PROGRESSION_VERSION: PROGRESSION_VERSION, SAVE_VERSION: SAVE_VERSION, GAME_KEYS: GAME_KEYS, BROWSER_KEYS: BROWSER_KEYS,
    defaultProgression: defaultProgression, mergeProgression: mergeProgression, checksum: checksum,
    defaultSettings: defaultSettings, legacyPreferences: legacyPreferences, isBrowserKey: isBrowserKey,
    fresh: fresh, migrate: migrate, mergeDocs: mergeDocs, fromBrowserSave: fromBrowserSave,
  };
});
