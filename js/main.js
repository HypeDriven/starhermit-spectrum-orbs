/**
 * main.js — bootstrap + game controller.
 *
 * State model (spec §2):
 *   boot → title → mode-select → setup → preparing → countdown → active
 *        ↔ paused → resolving → results → progression
 * Every transition goes through setState() with an explicit reason.
 */
import { GalleryRenderer } from './render.js';

const Rules = window.SpectrumRules;
const Content = window.SpectrumContent;
const Rng = window.SpectrumRng;
const { GameSession } = window.SpectrumSession;
const { Platform } = window.SpectrumPlatform;
const { AudioEngine } = window.SpectrumAudio;
const { UI, fmtTime } = window.SpectrumUI;

/** Authored boards for the five interactive lessons. */
const LEARN_BOARDS = [
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 0], [1], [1]], capacity: 2, colors: 2, tubeCount: 3 },
];

class Game {
  constructor() {
    this.platform = new Platform();
    this.ui = new UI(this.platform);
    this.audio = new AudioEngine();
    this.progression = this.platform.loadProgression();
    this.session = null;
    this.mode = null;
    this.pendingLevel = null;
    this.practiceDifficulty = 'standard';
    this.selectedTube = -1;
    this.kbFocus = -1;
    this.inputLocked = false;
    this.fsm = 'boot';
    this.tutorialIndex = -1;
    this._holdSource = -1;
    this._hudTimer = null;
    this._clockTimer = null;
    this._labelTimer = null;
    this._gamepadState = {};
    this._awayAt = null;
    this._fpsSamples = [];
    this._renderScale = 1;

    const container = document.getElementById('gl-container');
    this.renderer = new GalleryRenderer(container, {
      onPick: (i) => this.onTubePick(i),
      onPickDown: (i) => this.onTubePickDown(i),
    });
  }

  // ------------------------------------------------------------ bootstrap --

  async boot() {
    this.setState('title', 'boot-complete');
    this.ui.init(this._handlers());
    this.ui.applyAccessibilityClasses();
    this.ui.bindSettings((s) => this.applySettings(s));
    this.ui.renderHelp();
    this.ui.updateTopbar(this.platform, this.progression);
    this.applySettings(this.ui.settings, true);

    // Renderer availability: clear compatibility message, preserve session.
    if (!this.renderer.webglOk) {
      document.getElementById('compat-message').hidden = false;
    }

    // Platform handshake: time sync + cloud progression reconciliation + profile.
    this.platform.onSyncChange = () => this.ui.updateTopbar(this.platform, this.progression);
    this.platform.syncTime().then((ok) => {
      this.updateClock();
      if (ok) this.ui.toast('Synced with platform time');
    });
    this.platform.syncProgression(this.progression).then((res) => {
      if (res.resolved) this.progression = res.resolved;
      this.ui.updateTopbar(this.platform, this.progression);
    });
    if (this.platform.hosted) {
      this.platform.loadProfile().then(() => this.ui.updateTopbar(this.platform, this.progression));
    }

    // Returning player: offer resume of the last safe snapshot.
    const snap = this.platform.loadRoundSnapshot();
    if (snap && !snap.finished) {
      const note = document.getElementById('resume-note');
      note.hidden = false;
      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      btn.textContent = 'Resume unfinished round (' + (snap.level.name || snap.level.id) + ')';
      btn.addEventListener('click', () => { this.resumeSnapshot(snap); note.hidden = true; });
      note.textContent = '';
      note.appendChild(btn);
    }

    this._bindGlobal();
    this.updateClock();
    setInterval(() => this.updateClock(), 1000); // permanent title/HUD clock
  }

  _handlers() {
    return {
      'home': () => { this.closeToTitle(); },
      'play-journey': () => this.setupJourney(),
      'play-daily': () => this.startDaily(),
      'play-learn': () => this.startLearn(),
      'mode-select': () => this.setState('mode-select', 'user'),
      'scores': () => this.openScores(),
      'profile': () => this.openProfile(),
      'setup-journey': () => this.setupJourney(),
      'setup-daily': () => this.setupDaily(),
      'setup-practice': () => this.setupPractice(),
      'setup-challenge': () => this.setupChallenge(),
      'setup-learn': () => this.startLearn(),
      'begin': () => this.beginPending(),
      'undo': () => this.doUndo(),
      'hint': () => this.doHint(),
      'restart': () => this.restartRound(),
      'pause': () => this.pause(),
      'resume': () => this.resume(),
      'camera-reset': () => this.renderer.resetCamera(),
      'toggle-rail-left': () => {
        const g = document.getElementById('screen-game');
        g.classList.toggle('rail-left-open');
        g.classList.remove('rail-right-open');
      },
      'toggle-rail-right': () => {
        const g = document.getElementById('screen-game');
        g.classList.toggle('rail-right-open');
        g.classList.remove('rail-left-open');
      },
      'leave': () => this.leaveRound(),
      'retry': () => { this.ui.closeAllOverlays(); this.restartRound(); },
      'results-next': () => this.resultsNext(),
      'settings': () => this.ui.openOverlay('settings'),
      'help': () => { this.ui.renderHelp(); this.ui.openOverlay('help'); },
      'close-overlay': () => this.ui.closeOverlay(),
      'tutorial-skip': () => this.advanceTutorial(true),
      'replay-tutorial': () => { this.ui.closeAllOverlays(); this.startLearn(); },
      'dismiss-compat': () => { document.getElementById('compat-message').hidden = true; this.accessibleOnly = true; },
      '_settingsChanged': (s) => this.applySettings(s),
    };
  }

  _bindGlobal() {
    // Audio unlock on first gesture (browser autoplay policy).
    const unlock = () => {
      this.audio.ensureStarted();
      this.audio.setVolumes(this.ui.settings.audio);
      this.audio.setMuted(this.ui.settings.audio.muted);
      // First gesture may arrive mid-round: start ambience then.
      if (this.session && this.level && !this.audio._ambience) {
        this.audio.startAmbience(this.level.theme, Rng.streams(this.level.seed).audio);
      }
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);

    document.addEventListener('keydown', (e) => this.onKey(e));

    // Board-status chips act exactly like tapping the 3D tube (DOM equivalence).
    document.getElementById('board-status').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tube]');
      if (btn) this.onTubePick(parseInt(btn.getAttribute('data-tube'), 10));
    });
    document.getElementById('tube-labels').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tube]');
      if (btn) this.onTubePick(parseInt(btn.getAttribute('data-tube'), 10));
    });

    // Resize / orientation / DPR changes never lose input or restart a round.
    window.addEventListener('resize', () => { this.renderer.resize(); this.layoutTubeLabels(); });
    // Refit when chrome over the playfield changes (tutorial card shown/hidden
    // or resized, board-status strip growing) — the camera frames around it.
    {
      let raf = 0;
      const refit = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { this.renderer.resize(); this.layoutTubeLabels(); }); };
      const card = document.getElementById('tutorial-card');
      const status = document.getElementById('board-status');
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(refit);
        if (card) ro.observe(card);
        if (status) ro.observe(status);
      }
      if (card) new MutationObserver(refit).observe(card, { attributes: true, attributeFilter: ['hidden'] });
    }
    window.addEventListener('orientationchange', () => setTimeout(() => { this.renderer.resize(); this.layoutTubeLabels(); }, 60));

    // Backgrounding pauses the solo simulation and the render loop.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._awayAt = Date.now();
        if (this.session && this.fsm === 'active') this.session.pause();
        this.renderer.stop();
        this.audio.setBackgrounded(true);
      } else {
        if (this.session && this.fsm === 'active') this.session.resume();
        if (this.fsm === 'active' || this.fsm === 'preparing') this.renderer.start();
        this.audio.setBackgrounded(false);
        if (this._awayAt && Date.now() - this._awayAt > 30000 && this.session) {
          this.ui.toast('Welcome back — away ' + fmtTime(Date.now() - this._awayAt) + ', clock was paused.');
        }
        this._awayAt = null;
      }
    });

    window.addEventListener('beforeunload', () => {
      this.persistRound();
      this.platform.flushCloudSave();
    });

    // Gamepad polling (edge-triggered).
    setInterval(() => this.pollGamepad(), 100);
  }

  // -------------------------------------------------------------- FSM --

  setState(next, reason) {
    const prev = this.fsm;
    this.fsm = next;
    // Screen mapping: one owner per state.
    const screen = {
      'title': 'title', 'mode-select': 'modes', 'setup': 'setup',
      'preparing': 'game', 'countdown': 'game', 'active': 'game',
      'paused': 'game', 'resolving': 'game', 'results': 'game', 'progression': 'profile',
    }[next];
    if (screen) this.ui.showScreen(screen);
    if (next === 'paused') this.ui.openOverlay('pause');
    if (prev === 'paused' && next === 'active') this.ui.closeOverlay('pause');
    console.info('[fsm]', prev, '→', next, '(' + reason + ')');
  }

  // -------------------------------------------------------- mode setup --

  setupJourney() {
    const done = this.progression.journey || {};
    const next = Content.JOURNEY.find((l) => !done[l.id]) || Content.JOURNEY[Content.JOURNEY.length - 1];
    this.pendingLevel = next;
    this.mode = 'journey';
    this.renderSetup(next, {
      modeLabel: 'Journey', duration: '2–5 min',
      assists: 'Undo + hints enabled', players: 1,
      extra: 'Stage ' + next.index + ' of ' + Content.JOURNEY.length +
        (next.mastery ? ' · Mastery stage' : '') + ' · Theme: ' + Content.THEMES[next.theme].name,
    });
    this.setState('setup', 'journey-selected');
  }

  setupDaily() {
    this.startDaily();
  }

  setupPractice() {
    this.mode = 'practice';
    this.pendingLevel = null; // chosen at Begin
    const body = document.getElementById('setup-body');
    body.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = 'Practice — unranked';
    body.appendChild(h);
    for (const d of Object.values(Content.PRACTICE)) {
      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';
      card.innerHTML = '<h3></h3><p></p>';
      card.querySelector('h3').textContent = d.name;
      card.querySelector('p').textContent = d.colors + ' colors · capacity ' + d.capacity +
        ' · ' + d.spare + ' spare tube' + (d.spare > 1 ? 's' : '');
      if (d.key === this.practiceDifficulty) card.style.borderColor = 'var(--accent)';
      card.addEventListener('click', () => {
        this.practiceDifficulty = d.key;
        this.setupPractice();
      });
      body.appendChild(card);
    }
    const facts = document.createElement('p');
    facts.className = 'setup-facts';
    facts.textContent = 'Undo and hints enabled · no effect on competitive rating · restart anytime';
    body.appendChild(facts);
    this.setState('setup', 'practice-selected');
  }

  setupChallenge() {
    this.mode = 'challenge';
    this.pendingLevel = Content.CHALLENGES[0];
    const body = document.getElementById('setup-body');
    body.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = 'Challenge trials';
    body.appendChild(h);
    for (const c of Content.CHALLENGES) {
      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';
      card.innerHTML = '<h3></h3><p></p><span class="card-meta"></span>';
      card.querySelector('h3').textContent = c.name;
      card.querySelector('p').textContent = c.blurb;
      const best = (this.progression.challenges || {})[c.id];
      card.querySelector('.card-meta').textContent = best && best.won
        ? 'Best: ' + best.score + ' pts' : 'Not yet cleared';
      card.addEventListener('click', () => { this.pendingLevel = c; this.beginPending(); });
      body.appendChild(card);
    }
    this.setState('setup', 'challenge-selected');
  }

  renderSetup(level, info) {
    const body = document.getElementById('setup-body');
    body.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = (level.name || level.id);
    body.appendChild(h);
    const facts = document.createElement('p');
    facts.className = 'setup-facts';
    facts.innerHTML = '';
    for (const t of [
      info.modeLabel + ' · ' + info.players + ' player',
      'Expected duration: ' + info.duration,
      'Assists: ' + info.assists,
      level.colors + ' colors · capacity ' + level.capacity + ' · ' + level.spare + ' spare',
      'Par: 🥇' + level.par.gold + ' 🥈' + level.par.silver + ' 🥉' + level.par.bronze + ' moves',
      info.extra || '',
    ]) {
      if (!t) continue;
      const s = document.createElement('span');
      s.textContent = t;
      facts.appendChild(s);
    }
    body.appendChild(facts);
    const rules = document.createElement('p');
    rules.className = 'rail-note';
    rules.textContent = 'Rules: pour the top orb onto an empty tube or a matching color. ' +
      (level.limits && level.limits.moves ? 'Move limit: ' + level.limits.moves + '. ' : '') +
      (level.limits && level.limits.timeMs ? 'Time limit: ' + fmtTime(level.limits.timeMs) + '. ' : '') +
      (level.limits && level.limits.undo === false ? 'Undo disabled.' : '');
    body.appendChild(rules);
  }

  beginPending() {
    if (this.mode === 'practice') {
      this.startPractice();
    } else if (this.pendingLevel) {
      this.startLevel(this.pendingLevel, this.mode);
    }
  }

  // ---------------------------------------------------------- sessions --

  startLevel(level, mode, opts) {
    opts = opts || {};
    this.closeTransient();
    const effLevel = Object.assign({}, level);
    // Timing assist: accessibility option, declared with every submission.
    if (this.ui.settings.timingAssist && effLevel.limits && effLevel.limits.timeMs) {
      effLevel.limits = Object.assign({}, effLevel.limits, { timeMs: Math.floor(effLevel.limits.timeMs * 1.5) });
    }
    this.session = new GameSession(effLevel, { mode, now: () => this.platform.now() });
    this.level = effLevel;
    this.mode = mode;
    this.selectedTube = -1;
    this.kbFocus = -1;
    this.inputLocked = false;

    const streams = Rng.streams(effLevel.seed);
    this.audio.setVariantStream(streams.audio);
    const palette = Content.palette(this.ui.settings.palette);
    this.palette = palette;
    if (this.renderer.webglOk) {
      this.renderer.build(this.session.state, Content.THEMES[effLevel.theme], palette, streams.decor);
      this.renderer.setReducedMotion(this.ui.settings.reducedMotion);
      this.renderer.setCameraPreset(this.ui.settings.camera);
      this.renderer.start();
    }

    this.session.onChange((state, events) => this.onStateChange(state, events));

    this.setState('preparing', 'level-ready');
    this.renderer.resize(); // container only has dimensions once the game screen is visible
    this.updateAll();
    this.layoutTubeLabels();

    if (this.audio._started) {
      this.audio.stopAmbience();
      this.audio.startAmbience(effLevel.theme, streams.audio);
    }

    if (opts.skipCountdown) {
      this.setState('active', 'resume');
    } else {
      this.runCountdown();
    }
    this.startTimers();
    this.persistRound();
  }

  runCountdown() {
    this.setState('countdown', 'begin');
    const seq = this.ui.settings.reducedMotion ? ['Go'] : ['3', '2', '1', 'Go'];
    seq.forEach((s, i) => {
      setTimeout(() => {
        if (this.fsm !== 'countdown') return;
        this.ui.announce(s);
        this.ui.toast(s);
        if (i === seq.length - 1) this.setState('active', 'countdown-complete');
      }, i * (this.ui.settings.reducedMotion ? 200 : 650));
    });
  }

  startDaily() {
    const date = this.platform.utcDate();
    const level = Content.dailyForDate(date);
    this.startLevel(level, 'daily');
  }

  startPractice() {
    const round = (this.progression.stats.practiceRounds || 0);
    const level = Content.practiceLevel(this.practiceDifficulty, round);
    this.startLevel(level, 'practice');
  }

  startLearn() {
    this.tutorialIndex = 0;
    this.startLesson();
  }

  startLesson() {
    const board = LEARN_BOARDS[this.tutorialIndex];
    const step = Content.TUTORIAL[this.tutorialIndex];
    const level = {
      id: 'learn-' + this.tutorialIndex, seed: 100 + this.tutorialIndex,
      colors: board.colors, spare: board.tubeCount - board.colors, capacity: board.capacity,
      tubeCount: board.tubeCount, stacks: board.stacks,
      par: { gold: 6, silver: 9, bronze: 14 }, parTimeMs: null,
      theme: 'atrium', mechanics: ['move', 'undo', 'hint'], tutorial: step.id,
      name: step.title,
    };
    this.startLevel(level, 'learn', { skipCountdown: true });
    this.ui.renderTutorial(step, this.tutorialIndex, Content.TUTORIAL.length);
  }

  advanceTutorial(skipped) {
    this.tutorialIndex++;
    if (this.tutorialIndex >= Content.TUTORIAL.length) {
      this.ui.renderTutorial(null);
      this.ui.settings.tutorialDone = true;
      this.platform.saveSettings(this.ui.settings);
      this.persistRoundClear();
      this.closeToTitle();
      this.ui.toast('Lessons complete — welcome to the gallery.');
      return;
    }
    this.startLesson();
  }

  resumeSnapshot(snap) {
    try {
      this.session = GameSession.restore(JSON.stringify(snap), { now: () => this.platform.now() });
      this.level = this.session.level;
      this.mode = this.session.mode;
      this.selectedTube = -1;
      const palette = Content.palette(this.ui.settings.palette);
      this.palette = palette;
      const streams = Rng.streams(this.level.seed);
      this.audio.setVariantStream(streams.audio);
      if (this.renderer.webglOk) {
        this.renderer.build(this.session.state, Content.THEMES[this.level.theme], palette, streams.decor);
        this.renderer.setReducedMotion(this.ui.settings.reducedMotion);
        this.renderer.start();
      }
      this.session.onChange((state, events) => this.onStateChange(state, events));
      this.setState('active', 'reconnect');
      this.updateAll();
      this.layoutTubeLabels();
      this.startTimers();
      this.ui.toast('Session restored from snapshot.');
    } catch (e) {
      this.platform.clearRoundSnapshot();
      this.ui.toast('Saved round was corrupted and has been cleared.', true);
    }
  }

  restartRound() {
    if (!this.level) return;
    const level = this.mode === 'practice'
      ? Content.practiceLevel(this.practiceDifficulty, this.progression.stats.practiceRounds || 0)
      : this.level;
    this.ui.closeAllOverlays();
    if (this.mode === 'learn') { this.startLesson(); return; }
    this.startLevel(level, this.mode);
  }

  leaveRound() {
    if (this.session && this.session.state.status === 'active') {
      this.session.concede();
    }
    this.ui.closeAllOverlays();
    if (this.mode === 'learn') { this.closeToTitle(); return; }
    this.finishRound();
  }

  closeToTitle() {
    this.ui.closeAllOverlays();
    if (this.session && this.session.state.status === 'active') this.persistRound();
    this.session = null;
    this.stopTimers();
    this.renderer.stop();
    this.audio.stopAmbience();
    this.ui.renderTutorial(null);
    this.ui.updateTopbar(this.platform, this.progression);
    this.setState('title', 'user');
  }

  closeTransient() {
    this.ui.closeAllOverlays();
    this.ui.renderTutorial(null);
    this.stopTimers();
  }

  // ------------------------------------------------------------- input --

  onTubePickDown(i) {
    // Hold-versus-toggle: in hold mode, press-and-hold selects the source.
    if (this.ui.settings.holdToSelect && this.canPlay() && i !== null && i >= 0) {
      if (this.session.state.tubes[i].length) {
        this._holdSource = i;
        this.selectTube(i);
      }
    }
  }

  onTubePick(i) {
    if (!this.canPlay()) return;
    if (this.ui.settings.holdToSelect && this._holdSource >= 0) {
      const src = this._holdSource;
      this._holdSource = -1;
      if (i === null || i === src) { this.deselect(); return; }
      this.tryMove(src, i);
      return;
    }
    if (i === null || i < 0) { this.deselect(); return; }
    if (this.selectedTube < 0) {
      const tube = this.session.state.tubes[i];
      if (!tube.length) {
        this.explainInvalid(i, Rules.INVALID.EMPTY_SOURCE);
        return;
      }
      this.selectTube(i);
    } else if (i === this.selectedTube) {
      this.deselect();
    } else {
      this.tryMove(this.selectedTube, i);
    }
  }

  selectTube(i) {
    this.selectedTube = i;
    this.kbFocus = i;
    this.renderer.select(i);
    this.renderer.previewTargets(Rules.legalActions(this.session.state), i);
    const color = this.palette[this.session.state.tubes[i][this.session.state.tubes[i].length - 1]];
    this.ui.announce('Tube ' + (i + 1) + ' selected, top orb ' + (color ? color.label : ''));
    this.audio.event('pick');
    this.updateBoardMirror();
    this.layoutTubeLabels();
  }

  deselect() {
    this.selectedTube = -1;
    this.renderer.select(-1);
    this.renderer.previewTargets(null);
    this.updateBoardMirror();
    this.layoutTubeLabels();
  }

  tryMove(from, to) {
    if (this.inputLocked || !this.canPlay()) return;
    const r = this.session.move(from, to);
    if (!r.accepted) {
      this.explainInvalid(to, r.rejected.reason);
      return;
    }
    this.inputLocked = true; // locked only for the resolution animation
    const evt = r.events.find((e) => e.type === 'move');
    const targetTube = this.session.state.tubes[to];
    const completedTube = targetTube.length === this.session.state.capacity &&
      targetTube.every((c) => c === targetTube[0]);
    this.deselect();
    const anim = this.renderer.webglOk ? this.renderer.animateMove(evt) : Promise.resolve();
    anim.then(() => {
      this.inputLocked = false;
      this.renderer.syncState(this.session.state);
      this.audio.event(completedTube ? 'tube-complete' : 'drop');
      if (completedTube) {
        this.renderer.burst(to, this.palette[targetTube[0]].hex, 60, false);
        this.ui.announce('Tube ' + (to + 1) + ' complete: ' + this.palette[targetTube[0]].label);
      }
      if (this.ui.settings.haptics && navigator.vibrate) navigator.vibrate(12);
      this.audio.setProgress(this.progressFraction());
      this.updateAll();
      this.checkTutorialProgress('move');
      if (this.session.state.status !== 'active') this.finishRound();
    });
  }

  explainInvalid(tube, reason) {
    const text = this.ui.invalidText(reason);
    document.getElementById('invalid-reason').textContent = text;
    this.ui.alert(text);
    this.audio.event('invalid');
    this.renderer.invalidFeedback(tube);
    if (this.ui.settings.haptics && navigator.vibrate) navigator.vibrate([20, 30, 20]);
    clearTimeout(this._invalidTimer);
    this._invalidTimer = setTimeout(() => {
      document.getElementById('invalid-reason').textContent = '';
    }, 3200);
    if (this.mode === 'learn') this.checkTutorialProgress('invalid', reason);
  }

  doUndo() {
    if (!this.canPlay() && this.fsm !== 'results') return;
    const r = this.session.undo();
    if (!r.accepted) { this.explainInvalid(this.selectedTube >= 0 ? this.selectedTube : 0, r.rejected.reason); return; }
    this.deselect();
    this.renderer.syncState(this.session.state);
    this.audio.event('undo');
    this.ui.announce('Move undone. ' + this.session.state.moves + ' moves played.');
    this.updateAll();
    this.checkTutorialProgress('undo');
  }

  doHint() {
    if (!this.canPlay()) return;
    if (!this.level.mechanics.includes('hint')) { this.explainInvalid(0, 'hint-disabled'); return; }
    const h = this.session.hint();
    if (!h) { this.ui.toast('No hint available.'); return; }
    this.renderer.setHint(h);
    this.audio.event('hint');
    this.ui.announce('Hint: try pouring tube ' + (h.from + 1) + ' onto tube ' + (h.to + 1) + (h.certain ? '' : ' (suggestion)'));
    this.ui.toast('Hint: tube ' + (h.from + 1) + ' → tube ' + (h.to + 1));
    setTimeout(() => this.renderer.setHint(null), 5000);
  }

  onKey(e) {
    // Rebind capture, inputs, and overlays handle their own keys.
    if (e.target.matches('input, select, textarea')) return;
    if (this.ui.overlayStack.length) {
      if (e.key === 'Escape') { this.ui.closeOverlay(); if (this.fsm === 'paused') this.resume(); }
      return;
    }
    if (this.fsm !== 'active' && this.fsm !== 'countdown') return;
    const b = this.ui.getBindings();
    const code = e.code;
    const match = (a) => (b[a] || []).includes(code);
    if (match('prev')) { e.preventDefault(); this.moveKbFocus(-1); }
    else if (match('next')) { e.preventDefault(); this.moveKbFocus(1); }
    else if (match('confirm')) { e.preventDefault(); this.onTubePick(this.kbFocus >= 0 ? this.kbFocus : 0); }
    else if (match('cancel')) {
      e.preventDefault();
      if (this.selectedTube >= 0) this.deselect(); else this.pause();
    }
    else if (match('pause')) { e.preventDefault(); this.pause(); }
    else if (match('undo')) { e.preventDefault(); this.doUndo(); }
    else if (match('hint')) { e.preventDefault(); this.doHint(); }
    else if (match('restart')) { e.preventDefault(); this.restartRound(); }
    else if (match('camera')) { e.preventDefault(); this.renderer.resetCamera(); }
  }

  moveKbFocus(dir) {
    const n = this.session ? this.session.state.tubes.length : 0;
    if (!n) return;
    this.kbFocus = ((this.kbFocus < 0 ? (dir > 0 ? -1 : n) : this.kbFocus) + dir + n) % n;
    this.audio.event('focus');
    this.layoutTubeLabels();
    this.ui.announce('Tube ' + (this.kbFocus + 1) + ' focused');
  }

  pollGamepad() {
    if (this.fsm !== 'active') return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && Array.from(pads).find((p) => p && p.connected);
    if (!pad) return;
    const map = this.ui.getGamepadBindings();
    const pressed = (idx) => pad.buttons[idx] && pad.buttons[idx].pressed;
    const edge = (name, down) => {
      const was = this._gamepadState[name];
      this._gamepadState[name] = down;
      return down && !was;
    };
    if (edge('confirm', pressed(map.confirm))) this.onTubePick(this.kbFocus >= 0 ? this.kbFocus : 0);
    if (edge('cancel', pressed(map.cancel))) { if (this.selectedTube >= 0) this.deselect(); else this.pause(); }
    if (edge('undo', pressed(map.undo))) this.doUndo();
    if (edge('hint', pressed(map.hint))) this.doHint();
    if (edge('pause', pressed(map.pause))) this.pause();
    const ax = pad.axes[0] || 0;
    const dpadL = pad.buttons[14] && pad.buttons[14].pressed;
    const dpadR = pad.buttons[15] && pad.buttons[15].pressed;
    if (edge('left', dpadL || ax < -0.6)) this.moveKbFocus(-1);
    if (edge('right', dpadR || ax > 0.6)) this.moveKbFocus(1);
  }

  canPlay() {
    return this.session && this.fsm === 'active' && this.session.state.status === 'active';
  }

  pause() {
    if (this.fsm !== 'active') return;
    this.session.pause();
    this.setState('paused', 'user');
    this.persistRound();
  }

  resume() {
    if (this.fsm !== 'paused') return;
    this.session.resume();
    this.setState('active', 'user');
  }

  // ---------------------------------------------------------- lifecycle --

  startTimers() {
    this.stopTimers();
    this._hudTimer = setInterval(() => {
      if (!this.session) return;
      if (this.session.state.limits.timeMs !== null) {
        this.session.tickClock();
        if (this.session.state.status !== 'active') { this.finishRound(); return; }
      }
      this.updateHud();
    }, 250);
    this._labelTimer = setInterval(() => this.layoutTubeLabels(), 400);
    this._fpsTimer = setInterval(() => this.checkPerf(), 3000);
  }

  stopTimers() {
    for (const k of ['_hudTimer', '_labelTimer', '_fpsTimer']) {
      if (this[k]) { clearInterval(this[k]); this[k] = null; }
    }
  }

  updateClock() {
    const el = document.getElementById('clock-status');
    if (el) el.textContent = new Date(this.platform.now()).toUTCString().slice(17, 25) + ' UTC';
    const dl = document.getElementById('daily-label');
    if (dl) {
      const now = this.platform.now();
      const next = new Date(this.platform.utcDate() + 'T00:00:00Z').getTime() + 86400000;
      dl.textContent = 'next board in ' + fmtTime(next - now);
    }
  }

  /** Dynamic quality: lower render scale before ever touching the sim. */
  checkPerf() {
    if (!this.renderer.renderer) return;
    // Cheap frame pacing probe over the last interval.
    const t0 = performance.now();
    requestAnimationFrame(() => {
      const dt = performance.now() - t0;
      this._fpsSamples.push(dt);
      if (this._fpsSamples.length > 10) {
        const avg = this._fpsSamples.reduce((a, b) => a + b, 0) / this._fpsSamples.length;
        this._fpsSamples = [];
        if (avg > 24 && this._renderScale > 0.6) {
          this._renderScale = Math.max(0.6, this._renderScale - 0.15);
          this.renderer.setRenderScale(this._renderScale);
        } else if (avg < 12 && this._renderScale < 1) {
          this._renderScale = Math.min(1, this._renderScale + 0.15);
          this.renderer.setRenderScale(this._renderScale);
        }
      }
    });
  }

  onStateChange(state, events) {
    this.updateAll();
    this.persistRound();
  }

  updateAll() {
    if (!this.session) return;
    this.updateHud();
    this.updateBoardMirror();
  }

  updateHud() {
    if (!this.session) return;
    const note = {
      journey: 'Journey', daily: 'Daily · seed ' + this.level.seed.toString(16),
      practice: 'Practice · unranked', challenge: 'Challenge', learn: 'Lesson',
    }[this.mode] || '';
    this.ui.updateHud(this.session.state, this.level, this.session.score(), note);
  }

  updateBoardMirror() {
    if (!this.session) return;
    this.ui.updateBoardStatus(this.session.state, this.palette, this.selectedTube, this.kbFocus);
  }

  layoutTubeLabels() {
    if (!this.renderer.webglOk || !this.session || this.fsm === 'title') return;
    const pos = this.renderer.tubeScreenPositions();
    this.ui.layoutTubeLabels(pos, this.session.state.tubes.length, this.selectedTube, this.kbFocus);
  }

  progressFraction() {
    if (!this.session) return 0;
    const st = this.session.state;
    let done = 0;
    for (const t of st.tubes) {
      if (t.length === st.capacity && t.every((c) => c === t[0])) done++;
    }
    return done / st.colors;
  }

  checkTutorialProgress(actionType, reason) {
    if (this.mode !== 'learn' || this.tutorialIndex < 0) return;
    const step = Content.TUTORIAL[this.tutorialIndex];
    const ex = step.expect;
    let pass = false;
    if (ex.type === 'any' && actionType === 'move') pass = true;
    else if (ex.type === actionType && (!ex.reason || ex.reason === reason)) pass = true;
    else if (ex.type === 'win' && this.session.state.status === 'won') pass = true;
    if (pass) {
      this.ui.toast('✓ ' + step.title);
      setTimeout(() => this.advanceTutorial(false), 700);
    }
  }

  // ---------------------------------------------------------- finishing --

  finishRound() {
    if (!this.session || !this.session.finished) {
      if (this.session && this.session.state.status === 'active') return;
    }
    // Lessons advance through the tutorial engine, not the results screen.
    if (this.mode === 'learn') {
      if (this.session.state.status === 'lost') {
        this.ui.toast('That board locked up — let’s try the lesson again.', true);
        this.startLesson();
      }
      return;
    }
    this.setState('resolving', 'terminal');
    const result = this.session.terminalResult || this.session.score();
    const won = result.won;

    if (won && this.renderer.webglOk) {
      this.renderer.celebrate();
      this.audio.event('win');
    } else if (!won) {
      this.audio.event('lose');
    }

    // Progression + achievements.
    const prog = this.progression;
    const newAch = [];
    const unlock = async (key) => {
      const r = await this.platform.unlockAchievement(key);
      if (r.unlocked) {
        const def = Content.ACHIEVEMENTS.find((a) => a.key === key);
        if (def) newAch.push(def);
      }
    };

    const after = async () => {
      if (won) {
        prog.stats.totalCompletions++;
        prog.stats.totalMoves += result.moves;
        if (this.mode === 'journey') {
          const prev = prog.journey[this.level.id];
          if (!prev || result.total > prev.score) {
            prog.journey[this.level.id] = { medal: result.medal, moves: result.moves, score: result.total, at: Date.now() };
          }
          if (Object.keys(prog.journey).length >= 10) await unlock('tube_master');
        }
        if (this.mode === 'daily') {
          const date = this.platform.utcDate();
          prog.dailies[date] = { score: result.total, won: true };
          const yesterday = new Date(this.platform.now() - 86400000).toISOString().slice(0, 10);
          prog.streak.count = prog.streak.lastDate === date ? prog.streak.count
            : (prog.streak.lastDate === yesterday ? prog.streak.count + 1 : 1);
          prog.streak.lastDate = date;
          if (prog.streak.count >= 3) await unlock('daily_streak_3');
        }
        if (this.mode === 'challenge') {
          const prev = prog.challenges[this.level.id];
          if (!prev || result.total > prev.score) prog.challenges[this.level.id] = { score: result.total, won: true, at: Date.now() };
          if (this.level.id === 'challenge-crowded') await unlock('hard_milestone');
        }
        await unlock('first_completion');
        if (prog.stats.totalCompletions >= 50) await unlock('long_haul');
      }
      if (this.mode === 'practice' && !won) { /* practice abandonment stays unrated */ }
      await this.platform.saveProgression(prog);
      this.progression = this.platform.loadProgression();

      // Personal-best record with replay provenance (spec §6). Platform
      // leaderboards are read-only; this stays local + cloud-mirrored.
      let boardText = '';
      if (won && ['daily', 'challenge', 'journey'].includes(this.mode)) {
        const board = this.mode === 'daily' ? 'daily:' + this.platform.utcDate()
          : this.mode === 'challenge' ? this.level.id : 'journey';
        const envelope = this.session.replayEnvelope();
        const check = GameSession.validateReplay(envelope);
        const sub = await this.platform.submitScore({
          board, score: result.total,
          rulesetVersion: Rules.RULESET_VERSION, contentVersion: Content.CONTENT_VERSION,
          seed: this.session.state.seed,
          assists: { hints: this.session.state.hintsUsed, undos: result.undos, timingAssist: this.ui.settings.timingAssist },
          durationMs: result.elapsedMs, sessionId: result.sessionId,
          replay: check.ok ? envelope : null,
        });
        console.info('[score-record]', JSON.stringify({ board, check: check.ok, stored: sub.stored, casual: sub.casual }));
        boardText = this.platform.hosted
          ? 'Personal best recorded on this device and synced to your account.'
          : 'Saved to the local board (offline).';
      }

      this.persistRoundClear();

      const nextInfo = this.nextRecommendation();
      this.ui.showResults(result, this.level, {
        progressText: this.mode === 'journey'
          ? 'Journey: ' + Object.keys(this.progression.journey).length + ' / ' + Content.JOURNEY.length + ' stages complete.'
          : this.mode === 'daily' ? 'Daily streak: ' + this.progression.streak.count + ' day(s).' : '',
        boardText,
        newAchievements: newAch,
        nextLabel: nextInfo.label,
      });
      this._nextAction = nextInfo.fn;
      this.setState('results', 'round-end');
      this.ui.updateTopbar(this.platform, this.progression);
      this.ui.announce((won ? 'Round complete. ' : 'Round over. ') + 'Score ' + result.total + '.');
    };
    // Let the win animation land before the overlay (resolving phase).
    setTimeout(after, won && !this.ui.settings.reducedMotion ? 900 : 150);
  }

  nextRecommendation() {
    if (this.mode === 'journey') {
      const next = Content.JOURNEY.find((l) => !this.progression.journey[l.id]);
      if (next) return { label: 'Next stage', fn: () => this.startLevel(next, 'journey') };
    }
    if (this.mode === 'learn') return { label: 'Play Journey', fn: () => this.setupJourney() };
    if (this.mode === 'practice') return {
      label: 'New practice board',
      fn: () => {
        this.progression.stats.practiceRounds = (this.progression.stats.practiceRounds || 0) + 1;
        this.platform.saveProgression(this.progression);
        this.startPractice();
      },
    };
    if (this.mode === 'daily') return { label: 'Practice a board', fn: () => this.setupPractice() };
    if (this.mode === 'challenge') {
      const next = Content.CHALLENGES.find((c) => !(this.progression.challenges[c.id] && this.progression.challenges[c.id].won));
      if (next && next.id !== this.level.id) return { label: 'Next trial', fn: () => this.startLevel(next, 'challenge') };
    }
    return { label: 'Back to title', fn: () => this.closeToTitle() };
  }

  resultsNext() {
    this.ui.closeAllOverlays();
    const fn = this._nextAction;
    this._nextAction = null;
    if (fn) fn(); else this.closeToTitle();
  }

  // -------------------------------------------------------- persistence --

  persistRound() {
    if (!this.session) return;
    try { this.platform.saveRoundSnapshot(JSON.parse(this.session.snapshot())); }
    catch (e) { /* storage full: play continues without resume */ }
  }
  persistRoundClear() { this.platform.clearRoundSnapshot(); }

  // --------------------------------------------------------- scoreboard --

  async openScores() {
    this.setState('mode-select', 'scores'); // base screen swap
    this.ui.showScreen('scores');
    const sel = document.getElementById('scores-board-select');
    sel.innerHTML = '';
    const boards = [
      ['daily:' + this.platform.utcDate(), 'Daily (today)'],
      ['journey', 'Journey (all stages)'],
      ...Content.CHALLENGES.map((c) => [c.id, c.name]),
    ];
    if (this.platform.hosted) boards.unshift(['platform', 'Global (platform)']);
    for (const [val, label] of boards) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      sel.appendChild(o);
    }
    const load = async () => {
      const data = await this.platform.leaderboard(sel.value, document.getElementById('scores-friends').checked);
      this.ui.renderScores(data, sel.value);
    };
    sel.onchange = load;
    document.getElementById('scores-friends').onchange = load;
    load();
  }

  openProfile() {
    this.ui.renderProfile(this.progression, this.platform);
    this.ui.renderJourneyGrid(this.progression, (lv) => this.startLevel(lv, 'journey'));
    this.ui.showScreen('profile');
    this.setState('progression', 'profile');
  }

  // ----------------------------------------------------------- settings --

  applySettings(s, initial) {
    this.platform.saveSettings(s);
    this.ui.applyAccessibilityClasses();
    this.audio.setVolumes(s.audio);
    this.audio.setMuted(s.audio.muted);
    this.renderer.setReducedMotion(s.reducedMotion);
    if (this.renderer.webglOk) {
      const tier = s.graphics.tier === 'auto' ? this.autoTier() : s.graphics.tier;
      if (tier !== this.renderer.tierName) this.renderer.setQuality(tier);
      this.renderer.setCameraPreset(s.camera);
      // Palette change rebuilds orb materials on the current board.
      const pal = Content.palette(s.palette);
      if (this.session && JSON.stringify(pal) !== JSON.stringify(this.palette)) {
        this.palette = pal;
        this.renderer.build(this.session.state, Content.THEMES[this.level.theme], pal, this.renderer._decorRng);
        this.updateBoardMirror();
      }
    }
  }

  autoTier() {
    const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const cores = navigator.hardwareConcurrency || 4;
    if (mobile || cores <= 4) return 'medium';
    return 'high';
  }
}

// ------------------------------------------------------------------ boot --

const game = new Game();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => game.boot());
} else {
  game.boot();
}
window.SpectrumGame = game; // debug/testing handle
