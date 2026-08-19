/**
 * content.js — versioned content: palettes, themes, journey, daily, challenges,
 * tutorial script, achievements, and offline validators.
 *
 * Content record shape (spec §2): identifier, seed, initial state (derived
 * from seed), goals, allowed mechanics, par values, tutorial flags, theme.
 */
(function (root, factory) {
  const rng = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.SpectrumRng;
  const rules = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.SpectrumRules;
  const api = factory(rng, rules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpectrumContent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rng, Rules) {
  'use strict';

  const CONTENT_VERSION = 3;
  const BUILD_VERSION = '1.0.0';

  // ------------------------------------------------------------ palettes --

  /**
   * Gameplay colors. Every color carries a glyph + label so color is always
   * reinforced by shape and text (spec §3 accessibility). `cvd` variants are
   * tuned for common color-vision deficiencies; `contrast` is a high-contrast
   * palette. Values are linear-workflow friendly hexes verified to stay
   * separable after ACES tone mapping.
   */
  const COLOR_DEFS = [
    { key: 'coral',   label: 'Coral',   glyph: '●', default: '#e8533f', cvd: '#d55e00', contrast: '#ff3b30' },
    { key: 'amber',   label: 'Amber',   glyph: '▲', default: '#e8a33f', cvd: '#f0e442', contrast: '#ffd60a' },
    { key: 'lime',    label: 'Lime',    glyph: '■', default: '#7bc950', cvd: '#009e73', contrast: '#30d158' },
    { key: 'teal',    label: 'Teal',    glyph: '◆', default: '#3fb8af', cvd: '#56b4e9', contrast: '#64d2ff' },
    { key: 'azure',   label: 'Azure',   glyph: '★', default: '#4a7de0', cvd: '#0072b2', contrast: '#0a84ff' },
    { key: 'violet',  label: 'Violet',  glyph: '⬟', default: '#8a5fd6', cvd: '#cc79a7', contrast: '#bf5af2' },
    { key: 'magenta', label: 'Magenta', glyph: '✚', default: '#d65f9e', cvd: '#e69f00', contrast: '#ff375f' },
    { key: 'slate',   label: 'Slate',   glyph: '◐', default: '#9aa5b1', cvd: '#999999', contrast: '#e5e5ea' },
  ];

  function palette(name) {
    const field = name === 'cvd' ? 'cvd' : name === 'contrast' ? 'contrast' : 'default';
    return COLOR_DEFS.map((c) => ({
      key: c.key, label: c.label, glyph: c.glyph, hex: c[field],
    }));
  }

  // -------------------------------------------------------------- themes --

  /** Five visual themes (spec §7 launch scope). */
  const THEMES = {
    atrium: {
      key: 'atrium', name: 'Atrium Dawn',
      sky: 0x1a2233, fog: 0x232f45, floor: 0x2c3547, floorAccent: 0x3a4763,
      wall: 0x38445e, pedestal: 0x4a5878, keyLight: 0xffe0b8, keyIntensity: 2.6,
      hemiSky: 0x8fa8d0, hemiGround: 0x2a2438, ambience: 'dawn',
      description: 'A quiet sculpture court at first light.',
    },
    verdant: {
      key: 'verdant', name: 'Verdant Court',
      sky: 0x14251c, fog: 0x1d3328, floor: 0x24382c, floorAccent: 0x31493a,
      wall: 0x2e4636, pedestal: 0x40594a, keyLight: 0xf2ffd9, keyIntensity: 2.4,
      hemiSky: 0xa8d0a0, hemiGround: 0x1c2a20, ambience: 'garden',
      description: 'Overgrown glass and warm stone.',
    },
    midnight: {
      key: 'midnight', name: 'Midnight Wing',
      sky: 0x0b0d1a, fog: 0x12152a, floor: 0x181c33, floorAccent: 0x232848,
      wall: 0x1f2440, pedestal: 0x2c3358, keyLight: 0xb8c8ff, keyIntensity: 2.2,
      hemiSky: 0x5060a0, hemiGround: 0x0e1020, ambience: 'night',
      description: 'Cool moonlight over dark marble.',
    },
    ember: {
      key: 'ember', name: 'Ember Hall',
      sky: 0x241410, fog: 0x331c14, floor: 0x3a231b, floorAccent: 0x4c2f24,
      wall: 0x452a20, pedestal: 0x5c3a2c, keyLight: 0xffc890, keyIntensity: 2.8,
      hemiSky: 0xd0987a, hemiGround: 0x2a140e, ambience: 'hearth',
      description: 'Firelit copper and dark wood.',
    },
    porcelain: {
      key: 'porcelain', name: 'Porcelain Loft',
      sky: 0x30323a, fog: 0x3c3e48, floor: 0x484a55, floorAccent: 0x585b68,
      wall: 0x555864, pedestal: 0x6a6e7c, keyLight: 0xffffff, keyIntensity: 2.5,
      hemiSky: 0xcfd4e4, hemiGround: 0x3a3c46, ambience: 'loft',
      description: 'Bright ceramic minimalism.',
    },
  };

  // ------------------------------------------------------------- journey --

  /**
   * 40 authored journey stages. Difficulty is driven by solution depth,
   * branching (color count), spare tubes (recovery options), tube shape, and
   * time pressure — one new concept at a time, combined with a known concept,
   * then a mastery stage every 8th level (spec §2).
   *
   * Fields: id, seed, colors, spare (empty tubes), capacity, par moves,
   * parTimeMs (optional), theme, mechanics, tutorial flags.
   */
  const JOURNEY = buildJourney();

  function L(n, seed, colors, spare, capacity, parGold, opts) {
    const o = opts || {};
    const tubeCount = colors + spare;
    // Estimated minimal depth ~ colors*capacity*0.9 + n; pars widen with depth.
    const gold = parGold;
    return Object.assign({
      id: 'journey-' + String(n).padStart(2, '0'),
      index: n,
      seed: seed >>> 0,
      colors, spare, capacity, tubeCount,
      par: { gold, silver: Math.round(gold * 1.35), bronze: Math.round(gold * 1.8) },
      parTimeMs: o.parTimeMs || null,
      theme: o.theme || ['atrium', 'verdant', 'midnight', 'ember', 'porcelain'][Math.floor((n - 1) / 8)],
      mechanics: o.mechanics || ['move', 'undo', 'hint'],
      tutorial: o.tutorial || null,
      mastery: n % 8 === 0,
      name: o.name || null,
    }, o.extra || {});
  }

  function buildJourney() {
    const levels = [];
    const themes = ['atrium', 'verdant', 'midnight', 'ember', 'porcelain'];
    // Wing 1 (Atrium Dawn): core move rule in isolation, then undo, then hint.
    levels.push(L(1, 0xa11ce, 3, 2, 4, 12, { tutorial: 'move', name: 'First Light', mechanics: ['move', 'undo', 'hint'] }));
    levels.push(L(2, 0xb22ce, 3, 2, 4, 14, { tutorial: 'invalid', name: 'Matching Colors' }));
    levels.push(L(3, 0xc33ce, 3, 2, 4, 16, { tutorial: 'undo', name: 'Second Thoughts' }));
    levels.push(L(4, 0xd44ce, 4, 2, 4, 20, { name: 'Four Corners' }));
    levels.push(L(5, 0xe55ce, 4, 2, 4, 22, { tutorial: 'hint', name: 'A Quiet Nudge' }));
    levels.push(L(6, 0xf66ce, 4, 2, 4, 24, { name: 'Crosscurrents' }));
    levels.push(L(7, 0xa77ce, 5, 2, 4, 28, { name: 'Five Voices' }));
    levels.push(L(8, 0xb88ce, 5, 2, 4, 30, { mastery: true, name: 'Atrium Mastery' }));
    // Wing 2 (Verdant Court): slim tubes (capacity 3) introduced, then combined.
    levels.push(L(9, 0xc9901, 4, 2, 3, 14, { mechanics: ['move', 'undo', 'hint', 'slim-tubes'], name: 'Shallow Pools' }));
    levels.push(L(10, 0xda902, 5, 2, 3, 18, { mechanics: ['move', 'undo', 'hint', 'slim-tubes'], name: 'Reed Beds' }));
    levels.push(L(11, 0xeb903, 5, 2, 4, 30, { name: 'Deep Green' }));
    levels.push(L(12, 0xfc904, 5, 2, 3, 20, { mechanics: ['move', 'undo', 'hint', 'slim-tubes'], name: 'Narrow Passage' }));
    levels.push(L(13, 0xad905, 6, 2, 4, 34, { name: 'Six Stones' }));
    levels.push(L(14, 0xbe906, 6, 2, 3, 24, { mechanics: ['move', 'undo', 'hint', 'slim-tubes'], name: 'Moss Steps' }));
    levels.push(L(15, 0xcf907, 6, 2, 4, 36, { name: 'Canopy' }));
    levels.push(L(16, 0xd0908, 6, 2, 3, 26, { mechanics: ['move', 'undo', 'hint', 'slim-tubes'], mastery: true, name: 'Verdant Mastery' }));
    // Wing 3 (Midnight Wing): tall tubes (capacity 5).
    levels.push(L(17, 0xe1711, 4, 2, 5, 20, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'High Shelves' }));
    levels.push(L(18, 0xf2712, 5, 2, 5, 26, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'Tall Order' }));
    levels.push(L(19, 0xa3713, 6, 2, 4, 38, { name: 'Night Shift' }));
    levels.push(L(20, 0xb4714, 5, 2, 5, 30, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'Moonrise' }));
    levels.push(L(21, 0xc5715, 6, 2, 5, 34, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'Star Chart' }));
    levels.push(L(22, 0xd6716, 7, 2, 4, 42, { name: 'Seven Sisters' }));
    levels.push(L(23, 0xe7717, 6, 2, 5, 38, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'Deep Field' }));
    levels.push(L(24, 0xf8718, 7, 2, 5, 44, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], mastery: true, name: 'Midnight Mastery' }));
    // Wing 4 (Ember Hall): single spare tube (fewer recovery options).
    levels.push(L(25, 0xa9821, 4, 1, 4, 18, { mechanics: ['move', 'undo', 'hint', 'single-spare'], name: 'One Empty Pedestal' }));
    levels.push(L(26, 0xba822, 5, 1, 4, 26, { mechanics: ['move', 'undo', 'hint', 'single-spare'], name: 'Tight Corners' }));
    levels.push(L(27, 0xcb823, 5, 1, 3, 22, { mechanics: ['move', 'undo', 'hint', 'single-spare', 'slim-tubes'], name: 'Ember Steps' }));
    levels.push(L(28, 0xdc824, 6, 1, 4, 32, { mechanics: ['move', 'undo', 'hint', 'single-spare'], name: 'Narrow Halls' }));
    levels.push(L(29, 0xed825, 6, 2, 4, 40, { name: 'Breathing Room' }));
    levels.push(L(30, 0xfe826, 7, 1, 4, 40, { mechanics: ['move', 'undo', 'hint', 'single-spare'], name: 'Coal Walk' }));
    levels.push(L(31, 0xaf827, 7, 2, 4, 46, { name: 'Furnace' }));
    levels.push(L(32, 0xb0828, 7, 1, 4, 44, { mechanics: ['move', 'undo', 'hint', 'single-spare'], mastery: true, name: 'Ember Mastery' }));
    // Wing 5 (Porcelain Loft): everything combined; mastery finale.
    levels.push(L(33, 0xc1931, 6, 1, 5, 36, { mechanics: ['move', 'undo', 'hint', 'single-spare', 'tall-tubes'], name: 'White Room' }));
    levels.push(L(34, 0xd2932, 7, 2, 5, 46, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'Glaze' }));
    levels.push(L(35, 0xe3933, 8, 2, 4, 52, { name: 'Full Spectrum' }));
    levels.push(L(36, 0xf4934, 8, 2, 3, 40, { mechanics: ['move', 'undo', 'hint', 'slim-tubes'], name: 'Kiln Line' }));
    levels.push(L(37, 0xa5935, 8, 1, 4, 50, { mechanics: ['move', 'undo', 'hint', 'single-spare'], name: 'Hairline' }));
    levels.push(L(38, 0xb6936, 8, 2, 5, 56, { mechanics: ['move', 'undo', 'hint', 'tall-tubes'], name: 'Gallery Night' }));
    levels.push(L(39, 0xc7937, 8, 1, 5, 54, { mechanics: ['move', 'undo', 'hint', 'single-spare', 'tall-tubes'], name: 'Last Pedestal' }));
    levels.push(L(40, 0xd8938, 8, 2, 5, 60, { mechanics: ['move', 'undo', 'hint', 'tall-tubes', 'slim-tubes', 'single-spare'], mastery: true, name: 'Grand Mastery' }));
    // Assign themes per wing.
    levels.forEach((lv) => { lv.theme = themes[Math.floor((lv.index - 1) / 8)]; });
    return levels;
  }

  // --------------------------------------------------------------- daily --

  /** One shared seed + ruleset per UTC day (spec §2). Immutable once published. */
  function dailyForDate(utcDateStr) {
    const seed = Rng.hashString('spectrum-daily:' + utcDateStr);
    const r = new Rng.RandomStream(seed, 'daily-params');
    const colors = r.int(4, 7);
    const capacity = r.pick([4, 4, 4, 5, 3]);
    const spare = r.pick([2, 2, 1]);
    const gold = Math.round(colors * capacity * 1.9);
    return {
      id: 'daily-' + utcDateStr,
      date: utcDateStr,
      seed,
      colors, spare, capacity, tubeCount: colors + spare,
      par: { gold, silver: Math.round(gold * 1.35), bronze: Math.round(gold * 1.8) },
      parTimeMs: null,
      theme: ['atrium', 'verdant', 'midnight', 'ember', 'porcelain'][seed % 5],
      mechanics: ['move', 'undo'],
      tutorial: null,
      mastery: false,
      name: 'Daily — ' + utcDateStr,
      ranked: true,
    };
  }

  // ---------------------------------------------------------- challenges --

  /** Constrained-goal modes (spec §2 Challenge). */
  const CHALLENGES = [
    {
      id: 'challenge-efficiency', name: 'Efficiency Trial', seed: 0xeff1c1,
      colors: 5, spare: 2, capacity: 4, tubeCount: 7,
      par: { gold: 24, silver: 32, bronze: 44 }, parTimeMs: null,
      theme: 'porcelain', mechanics: ['move', 'undo', 'hint'], tutorial: null,
      limits: { moves: 30 },
      blurb: 'Solve it in 30 moves or fewer. Plan every pour.',
    },
    {
      id: 'challenge-speed', name: 'Speedrun Gallery', seed: 0x5eed01,
      colors: 4, spare: 2, capacity: 4, tubeCount: 6,
      par: { gold: 18, silver: 26, bronze: 36 }, parTimeMs: 90000,
      theme: 'midnight', mechanics: ['move', 'undo'], tutorial: null,
      limits: { timeMs: 90000 },
      blurb: 'Ninety seconds on the clock. Trust your hands.',
    },
    {
      id: 'challenge-crowded', name: 'Crowded Wing', seed: 0xc0d3d1,
      colors: 7, spare: 1, capacity: 4, tubeCount: 8,
      par: { gold: 42, silver: 56, bronze: 74 }, parTimeMs: null,
      theme: 'ember', mechanics: ['move', 'undo', 'hint', 'single-spare'], tutorial: null,
      blurb: 'Eight tubes, one empty. There is no room for waste.',
    },
    {
      id: 'challenge-no-undo', name: 'No Second Chances', seed: 0x0bad01,
      colors: 5, spare: 2, capacity: 4, tubeCount: 7,
      par: { gold: 26, silver: 34, bronze: 46 }, parTimeMs: null,
      theme: 'verdant', mechanics: ['move'], tutorial: null,
      limits: { undo: false },
      blurb: 'Undo is disabled. Every drop is permanent.',
    },
    {
      id: 'challenge-monolith', name: 'Monolith', seed: 0x606117,
      colors: 6, spare: 2, capacity: 5, tubeCount: 8,
      par: { gold: 40, silver: 54, bronze: 72 }, parTimeMs: null,
      theme: 'atrium', mechanics: ['move', 'undo', 'hint', 'tall-tubes'], tutorial: null,
      blurb: 'Tall tubes, deep stacks. Think five layers down.',
    },
  ];

  /** Practice difficulties (unranked, undo always allowed). */
  const PRACTICE = {
    relaxed: { key: 'relaxed', name: 'Relaxed', colors: 3, spare: 2, capacity: 4, seedBase: 0x9a1111 },
    standard: { key: 'standard', name: 'Standard', colors: 5, spare: 2, capacity: 4, seedBase: 0x9b2222 },
    expert: { key: 'expert', name: 'Expert', colors: 7, spare: 1, capacity: 4, seedBase: 0x9c3333 },
  };

  function practiceLevel(difficultyKey, round) {
    const d = PRACTICE[difficultyKey] || PRACTICE.standard;
    const seed = (d.seedBase + (round || 0) * 0x101) >>> 0;
    const gold = Math.round(d.colors * d.capacity * 2);
    return {
      id: 'practice-' + d.key + '-' + (round || 0),
      seed, colors: d.colors, spare: d.spare, capacity: d.capacity,
      tubeCount: d.colors + d.spare,
      par: { gold, silver: Math.round(gold * 1.35), bronze: Math.round(gold * 1.8) },
      parTimeMs: null,
      theme: ['atrium', 'verdant', 'midnight', 'ember', 'porcelain'][seed % 5],
      mechanics: ['move', 'undo', 'hint'], tutorial: null, mastery: false,
      name: d.name + ' Practice',
    };
  }

  // ----------------------------------------------------------- tutorial --

  /**
   * Interactive lessons: one rule at a time, and the player must perform the
   * action to advance (spec §2 Learn mode).
   */
  const TUTORIAL = [
    {
      id: 'learn-move', title: 'Lift and pour',
      body: 'Select a tube to lift its top orb, then select another tube to pour it in. Try it now.',
      expect: { type: 'move' },
      hint: 'Tap any tube, then tap a matching or empty tube.',
    },
    {
      id: 'learn-match', title: 'Colors must match',
      body: 'An orb can only land on an empty tube or on an orb of the same color. Watch what happens when you try otherwise.',
      expect: { type: 'invalid', reason: 'color-mismatch' },
      hint: 'Try pouring onto a different color — the gallery will explain.',
    },
    {
      id: 'learn-full', title: 'Tubes have limits',
      body: 'A full tube cannot accept more orbs. Fill a tube and see.',
      expect: { type: 'any' },
      hint: 'Keep playing — notice when a tube cannot take more.',
    },
    {
      id: 'learn-undo', title: 'Second thoughts',
      body: 'Made a move you regret? Use Undo (U key or the Undo action) to take it back.',
      expect: { type: 'undo' },
      hint: 'Make any move, then press Undo.',
    },
    {
      id: 'learn-win', title: 'One color per tube',
      body: 'Win by sorting so every tube holds a single color. Finish this board!',
      expect: { type: 'win' },
      hint: 'Consolidate colors until every tube is pure.',
    },
  ];

  // -------------------------------------------------------- achievements --

  /** Small static set with stable lowercase keys (spec §6). */
  const ACHIEVEMENTS = [
    { key: 'first_completion', name: 'First Light Caught', desc: 'Complete your first board.' },
    { key: 'tube_master', name: 'Tube Master', desc: 'Complete 10 journey stages.' },
    { key: 'daily_streak_3', name: 'Three Dawns Running', desc: 'Complete the daily challenge 3 days in a row.' },
    { key: 'hard_milestone', name: 'Crowded Wing Cleared', desc: 'Complete the Crowded Wing challenge.' },
    { key: 'long_haul', name: 'Gallery Regular', desc: 'Complete 50 boards in total.' },
  ];

  // ---------------------------------------------------------- validators --

  /**
   * Offline validators (spec §2): basic legality, reachable goals, bounded
   * duration, absence of soft locks at generation time.
   * Returns {ok, errors[], stats}.
   */
  function validateLevel(level) {
    const errors = [];
    if (!level.id || typeof level.id !== 'string') errors.push('missing id');
    if (!Number.isInteger(level.seed)) errors.push('missing seed');
    if (!Number.isInteger(level.colors) || level.colors < 2 || level.colors > COLOR_DEFS.length) {
      errors.push('colors out of supported range');
    }
    if (!Number.isInteger(level.capacity) || level.capacity < 3 || level.capacity > 6) {
      errors.push('capacity out of range');
    }
    if (!Number.isInteger(level.spare) || level.spare < 1 || level.spare > 3) {
      errors.push('spare out of range');
    }
    if (!level.par || !(level.par.gold <= level.par.silver && level.par.silver <= level.par.bronze)) {
      errors.push('par thresholds not ordered');
    }
    if (!THEMES[level.theme]) errors.push('unknown theme ' + level.theme);
    if (errors.length) return { ok: false, errors, stats: null };

    let state;
    try {
      state = Rules.createState({
        contentId: level.id, seed: level.seed,
        colors: level.colors, tubeCount: level.tubeCount,
        capacity: level.capacity,
        limits: level.limits || {},
      });
    } catch (e) {
      return { ok: false, errors: ['generation failed: ' + e.message], stats: null };
    }
    if (Rules.isWin(state)) errors.push('generated layout already solved');

    // Reachable goal + absence of soft lock: the solver must find a win.
    const solution = Rules.solve(state, { maxNodes: 400000 });
    if (!solution) errors.push('no solution found within validator budget (possible soft lock)');
    else {
      // Bounded duration: solution depth should stay within par envelope.
      if (solution.length > level.par.bronze * 4) errors.push('solution depth far beyond par (unbounded duration risk)');
    }
    // Par sanity: gold should not be below a plausible minimal depth.
    if (solution && level.par.gold < Math.floor(solution.length * 0.55)) {
      errors.push('par gold implausibly tight (' + level.par.gold + ' <~ ' + solution.length + ')');
    }
    return {
      ok: errors.length === 0, errors,
      stats: solution ? { solutionDepth: solution.length, firstMove: solution[0] } : null,
    };
  }

  /** Validate the whole shipped catalogue. Used by tests and server boot. */
  function validateCatalogue() {
    const report = { ok: true, levels: {}, errors: [] };
    const all = JOURNEY.concat(CHALLENGES);
    for (const lv of all) {
      const r = validateLevel(lv);
      report.levels[lv.id] = r;
      if (!r.ok) {
        report.ok = false;
        report.errors.push(lv.id + ': ' + r.errors.join('; '));
      }
    }
    return report;
  }

  return {
    CONTENT_VERSION, BUILD_VERSION,
    COLOR_DEFS, palette, THEMES,
    JOURNEY, CHALLENGES, PRACTICE, practiceLevel,
    dailyForDate, TUTORIAL, ACHIEVEMENTS,
    validateLevel, validateCatalogue,
  };
});
