/**
 * ui.js — responsive DOM shell: screens, overlays, HUD, settings, help,
 * accessibility mirror, focus management, live regions.
 *
 * UI state is strictly separate from simulation state; closing a drawer or
 * opening an overlay never touches the rules engine.
 */
(function (root) {
  'use strict';

  const Content = root.SpectrumContent;

  const INVALID_TEXT = {
    'terminal': 'This round has ended.',
    'out-of-bounds': 'That tube does not exist.',
    'empty-source': 'That tube is empty — nothing to lift.',
    'same-tube': 'Selection cleared.',
    'target-full': 'That tube is full.',
    'color-mismatch': 'Colors must match — pour onto the same color or an empty tube.',
    'undo-disabled': 'Undo is disabled in this mode.',
    'hint-disabled': 'Hints are not available in this mode.',
    'nothing-to-undo': 'Nothing to undo.',
    'duplicate-command': 'Already applied.',
  };

  const DEFAULT_BINDINGS = {
    confirm: ['Enter', 'Space'], cancel: ['Escape'], pause: ['KeyP'],
    undo: ['KeyU'], hint: ['KeyH'], restart: ['KeyR'], camera: ['KeyC'],
    prev: ['ArrowLeft', 'ArrowUp'], next: ['ArrowRight', 'ArrowDown'],
  };
  const DEFAULT_GAMEPAD = { confirm: 0, cancel: 1, undo: 2, hint: 3, pause: 9 };

  class UI {
    constructor(platform) {
      this.platform = platform;
      this.handlers = {};
      this.currentScreen = 'title';
      this.overlayStack = [];
      this._lastFocus = new Map();
      this.kbTubeFocus = -1;
      this.settings = platform.loadSettings();
      this.$ = (sel) => document.querySelector(sel);
      this.$$ = (sel) => Array.from(document.querySelectorAll(sel));
    }

    init(handlers) {
      this.handlers = handlers;
      document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (this.handlers[action]) {
          this.handlers[action](el);
        }
      });
      // Focus trap for modal overlays.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || !this.overlayStack.length) return;
        const overlay = this.$('#screen-' + this.overlayStack[this.overlayStack.length - 1]);
        if (!overlay) return;
        const focusables = overlay.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    }

    // --------------------------------------------------------- screens --

    showScreen(name) {
      for (const s of this.$$('.screen')) {
        if (!s.classList.contains('overlay')) s.hidden = s.id !== 'screen-' + name;
      }
      this.currentScreen = name;
      const el = this.$('#screen-' + name);
      if (el) {
        const h = el.querySelector('h1, h2, [tabindex]');
        if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
      }
    }

    openOverlay(name) {
      const el = this.$('#screen-' + name);
      if (!el) return;
      this._lastFocus.set(name, document.activeElement);
      el.hidden = false;
      this.overlayStack.push(name);
      const target = el.querySelector('.primary, button, input, select');
      if (target) target.focus();
    }

    closeOverlay(name) {
      const top = name || this.overlayStack[this.overlayStack.length - 1];
      if (!top) return;
      const el = this.$('#screen-' + top);
      if (el) el.hidden = true;
      this.overlayStack = this.overlayStack.filter((n) => n !== top);
      // Focus restoration after every modal (spec §9).
      const prev = this._lastFocus.get(top);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    }

    closeAllOverlays() {
      while (this.overlayStack.length) this.closeOverlay(this.overlayStack[this.overlayStack.length - 1]);
    }

    // ------------------------------------------------------ announcements --

    announce(msg) { this.$('#live-region').textContent = msg; }
    alert(msg) { this.$('#alert-region').textContent = msg; }

    toast(msg, warn) {
      const t = document.createElement('div');
      t.className = 'toast' + (warn ? ' warn' : '');
      t.textContent = msg;
      this.$('#toast-root').appendChild(t);
      setTimeout(() => t.remove(), 3600);
    }

    invalidText(reason) { return INVALID_TEXT[reason] || 'That move is not legal.'; }

    // -------------------------------------------------------------- HUD --

    updateHud(state, level, score, modeNote) {
      this.$('#hud-level').textContent = level.name || level.id;
      this.$('#hud-moves').textContent = String(state.moves);
      const limitRow = this.$('#hud-limit-row');
      if (state.limits.moves !== null) {
        limitRow.hidden = false;
        this.$('#hud-limit').textContent = (state.limits.moves - state.moves) + ' moves left';
      } else if (state.limits.timeMs !== null) {
        limitRow.hidden = false;
        const left = Math.max(0, state.limits.timeMs - state.elapsedMs);
        this.$('#hud-limit').textContent = fmtTime(left) + ' left';
      } else {
        limitRow.hidden = true;
      }
      this.$('#hud-time').textContent = fmtTime(state.elapsedMs);
      const medal = paceMedal(state.moves, level.par);
      this.$('#hud-medal').textContent = medal;
      const pct = Math.min(100, (state.moves / level.par.bronze) * 100);
      this.$('#par-fill').style.width = pct + '%';
      this.$('#hud-mode-note').textContent = modeNote || '';
      const undoBtn = this.$('#btn-undo');
      if (undoBtn) undoBtn.disabled = !state.limits.undo || !state.undoStack.length || state.status !== 'active';
    }

    /** Navigable DOM mirror of the board (screen-reader + keyboard path). */
    updateBoardStatus(state, palette, selected, kbFocus) {
      const root = this.$('#board-status');
      root.textContent = '';
      state.tubes.forEach((tube, i) => {
        const chip = document.createElement('span');
        chip.className = 'tube-chip';
        const btn = document.createElement('button');
        btn.type = 'button';
        const names = tube.map((c) => palette[c] ? palette[c].label : '?');
        btn.setAttribute('aria-label',
          'Tube ' + (i + 1) + ': ' + (names.length ? names.join(', ') : 'empty') +
          ', ' + tube.length + ' of ' + state.capacity +
          (i === selected ? ', selected' : ''));
        btn.setAttribute('data-tube', String(i));
        btn.title = 'Tube ' + (i + 1);
        const num = document.createElement('span');
        num.textContent = (i + 1) + ' ';
        btn.appendChild(num);
        for (const c of tube) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.textContent = palette[c] ? palette[c].glyph : '?';
          dot.style.color = palette[c] ? palette[c].hex : '#fff';
          btn.appendChild(dot);
        }
        if (!tube.length) {
          const e = document.createElement('span');
          e.textContent = '∅'; e.style.opacity = '0.5';
          btn.appendChild(e);
        }
        chip.appendChild(btn);
        root.appendChild(chip);
      });
    }

    /** Position DOM tube buttons over their 3D anchors (shared layout model). */
    layoutTubeLabels(positions, count, selected, kbFocus) {
      const root = this.$('#tube-labels');
      if (root.childElementCount !== count) {
        root.textContent = '';
        for (let i = 0; i < count; i++) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tube-label';
          b.textContent = String(i + 1);
          b.setAttribute('data-tube', String(i));
          b.tabIndex = -1; // keyboard uses arrow navigation; chips in #board-status are tabbable
          root.appendChild(b);
        }
      }
      const kids = root.children;
      positions.forEach((p, i) => {
        const el = kids[i];
        if (!el) return;
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.classList.toggle('selected', i === selected);
        el.classList.toggle('kb-focus', i === kbFocus);
      });
    }

    // ----------------------------------------------------------- results --

    showResults(result, level, opts) {
      const o = opts || {};
      this.$('#results-headline').textContent = result.won
        ? (result.medal === 'gold' ? 'A flawless arrangement.'
          : result.medal === 'silver' ? 'Beautifully sorted.'
          : result.medal === 'bronze' ? 'The gallery settles.'
          : 'Sorted — with room to refine.')
        : ({ 'move-limit-exceeded': 'Out of moves.', 'time-expired': 'Time ran out.',
             'no-legal-moves': 'No legal moves remain.', 'abandoned': 'Round left unfinished.' }[result.terminalReason] || 'Round over.');

      const medalRow = this.$('#results-medal');
      medalRow.innerHTML = '';
      for (const m of ['gold', 'silver', 'bronze']) {
        const s = document.createElement('span');
        s.className = 'medal ' + m + (result.won && medalRank(result.medal) <= medalRank(m) ? ' earned' : '');
        s.textContent = m === 'gold' ? '🥇' : m === 'silver' ? '🥈' : '🥉';
        s.title = m + ' (≤ ' + level.par[m] + ' moves)';
        medalRow.appendChild(s);
      }

      const rows = this.$('#score-rows');
      rows.innerHTML = '';
      const add = (label, val) => {
        const tr = document.createElement('tr');
        const th = document.createElement('th'); th.scope = 'row'; th.textContent = label;
        const td = document.createElement('td'); td.textContent = val;
        tr.append(th, td); rows.appendChild(tr);
      };
      add('Completion', result.won ? '+' + result.base : '0');
      add('Move efficiency (' + result.moves + ' moves, par ' + level.par.gold + ')', signed(result.efficiency));
      if (result.speed) add('Speed bonus', signed(result.speed));
      add('Medal bonus', signed(result.medalBonus));
      if (result.invalids) add('Invalid actions × ' + result.invalids, signed(result.invalidPenalty));
      if (result.undos) add('Undos × ' + result.undos, signed(result.undoPenalty));
      add('Time', fmtTime(result.elapsedMs));
      this.$('#score-total').textContent = String(result.total);

      this.$('#results-progress').textContent = o.progressText || '';
      this.$('#results-board-status').textContent = o.boardText || '';
      const ach = this.$('#results-achievements');
      ach.innerHTML = '';
      for (const a of (o.newAchievements || [])) {
        const d = document.createElement('div');
        d.className = 'achievement-toast';
        d.textContent = '🏆 Achievement unlocked: ' + a.name;
        ach.appendChild(d);
      }
      this.$('#btn-results-next').textContent = o.nextLabel || 'Next';
      this.openOverlay('results');
    }

    // ---------------------------------------------------------- settings --

    bindSettings(onChange) {
      const s = this.settings;
      const set = (id, val) => { const el = this.$(id); if (el) el.type === 'checkbox' ? el.checked = !!val : el.value = val; };
      set('#set-music', s.audio.music); set('#set-effects', s.audio.effects);
      set('#set-ambience', s.audio.ambience); set('#set-voice', s.audio.voice);
      set('#set-muted', s.audio.muted);
      set('#set-tier', s.graphics.tier); set('#set-camera', s.camera);
      set('#set-palette', s.palette);
      set('#set-reduced-motion', s.reducedMotion); set('#set-high-contrast', s.highContrast);
      set('#set-large-text', s.largeText); set('#set-left-handed', s.leftHanded);
      set('#set-hold-select', s.holdToSelect); set('#set-timing-assist', s.timingAssist);
      set('#set-haptics', s.haptics);

      const wire = (id, fn) => {
        const el = this.$(id);
        if (el) el.addEventListener('change', () => {
          fn(el.type === 'checkbox' ? el.checked : el.value);
          onChange(this.settings);
        });
      };
      wire('#set-music', (v) => s.audio.music = +v);
      wire('#set-effects', (v) => s.audio.effects = +v);
      wire('#set-ambience', (v) => s.audio.ambience = +v);
      wire('#set-voice', (v) => s.audio.voice = +v);
      wire('#set-muted', (v) => s.audio.muted = v);
      wire('#set-tier', (v) => s.graphics.tier = v);
      wire('#set-camera', (v) => s.camera = v);
      wire('#set-palette', (v) => s.palette = v);
      wire('#set-reduced-motion', (v) => s.reducedMotion = v);
      wire('#set-high-contrast', (v) => s.highContrast = v);
      wire('#set-large-text', (v) => s.largeText = v);
      wire('#set-left-handed', (v) => s.leftHanded = v);
      wire('#set-hold-select', (v) => s.holdToSelect = v);
      wire('#set-timing-assist', (v) => s.timingAssist = v);
      wire('#set-haptics', (v) => s.haptics = v);

      this.renderBindings();
    }

    renderBindings(onRebind) {
      const list = this.$('#bindings-list');
      list.innerHTML = '';
      const bindings = this.getBindings();
      for (const [action, keys] of Object.entries(bindings)) {
        const row = document.createElement('div');
        row.className = 'binding-row';
        const label = document.createElement('span');
        label.textContent = action;
        const btn = document.createElement('button');
        btn.type = 'button';
        const gp = DEFAULT_GAMEPAD[action] !== undefined ? ' · 🎮' + DEFAULT_GAMEPAD[action] : '';
        btn.textContent = (keys[0] || '—').replace('Key', '').replace('Arrow', '') + gp;
        btn.setAttribute('aria-label', 'Rebind ' + action);
        btn.addEventListener('click', () => {
          btn.textContent = 'press key…';
          const cap = (e) => {
            e.preventDefault();
            bindings[action] = [e.code];
            this.settings.bindings = bindings;
            document.removeEventListener('keydown', cap, true);
            this.renderBindings();
            if (this.handlers._settingsChanged) this.handlers._settingsChanged(this.settings);
          };
          document.addEventListener('keydown', cap, true);
        });
        row.append(label, btn);
        list.appendChild(row);
      }
    }

    getBindings() {
      return this.settings.bindings || JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    }
    getGamepadBindings() { return DEFAULT_GAMEPAD; }

    applyAccessibilityClasses() {
      const s = this.settings;
      document.body.classList.toggle('reduced-motion', s.reducedMotion);
      document.body.classList.toggle('high-contrast', s.highContrast);
      document.body.classList.toggle('large-text', s.largeText);
      document.body.classList.toggle('left-handed', s.leftHanded);
    }

    // -------------------------------------------------------------- help --

    /** Rule cards generated from current bindings + representative states. */
    renderHelp() {
      const b = this.getBindings();
      const key = (a) => (b[a] && b[a][0] ? b[a][0].replace('Key', '').replace('Arrow', 'Arrow ') : '—');
      const cards = [
        { title: 'Goal', body: 'Move the top orb between tubes until every tube holds a single color (or is empty). A tube is complete when it is full of one color.', demo: [['●', '●', '●', '●'], '← complete'] },
        { title: 'Lift & pour', body: 'Select a tube to lift its top orb, then select a target tube. Keyboard: ' + key('prev') + '/' + key('next') + ' to choose, ' + key('confirm') + ' to confirm.', demo: [['▲'], '→', ['▲', '▲']] },
        { title: 'Matching rule', body: 'An orb may only land on an empty tube or on an orb of the same color. Full tubes accept nothing. Invalid attempts explain why.', demo: [['●'], '✗→', ['▲']] },
        { title: 'Undo & hints', body: 'Undo (' + key('undo') + ') takes back your last move where the mode allows. Hint (' + key('hint') + ') suggests a legal move using the same rules engine.', demo: null },
        { title: 'Medals', body: 'Finish within par for bronze, silver, or gold. Score = completion + efficiency + speed − penalties. Every component is itemized on the results screen.', demo: null },
        { title: 'Controls', body: 'Pause: ' + key('pause') + ' · Restart: ' + key('restart') + ' · Camera: ' + key('camera') + ' · Gamepad: D-pad moves focus, bottom button confirms.', demo: null },
      ];
      const root = this.$('#help-cards');
      root.innerHTML = '';
      for (const c of cards) {
        const el = document.createElement('div');
        el.className = 'card';
        const h = document.createElement('h3'); h.textContent = c.title;
        const p = document.createElement('p'); p.textContent = c.body;
        el.append(h, p);
        if (c.demo) {
          const d = document.createElement('p');
          d.setAttribute('aria-hidden', 'true');
          d.style.fontSize = '1.2rem';
          d.textContent = c.demo.map((x) => Array.isArray(x) ? '[' + x.join(' ') + ']' : x).join(' ');
          el.appendChild(d);
        }
        root.appendChild(el);
      }
    }

    // --------------------------------------------------- journey/profile --

    renderJourneyGrid(progression, onPick) {
      const grid = this.$('#journey-grid');
      grid.innerHTML = '';
      const done = progression.journey || {};
      const unlockedCount = Content.JOURNEY.filter((l) => done[l.id]).length + 1;
      Content.JOURNEY.forEach((lv, i) => {
        const cell = document.createElement('button');
        cell.type = 'button';
        const rec = done[lv.id];
        const locked = i >= unlockedCount;
        cell.className = 'journey-cell' + (locked ? ' locked' : '') + (lv.mastery ? ' mastery' : '');
        cell.disabled = locked;
        cell.setAttribute('role', 'listitem');
        cell.setAttribute('aria-label', 'Stage ' + lv.index + (lv.name ? ' ' + lv.name : '') +
          (locked ? ', locked' : rec ? ', completed, medal ' + (rec.medal || 'clear') : ', available'));
        const num = document.createElement('span'); num.textContent = String(lv.index);
        const medal = document.createElement('span'); medal.className = 'cell-medal';
        medal.textContent = rec ? ({ gold: '🥇', silver: '🥈', bronze: '🥉', clear: '✓' }[rec.medal] || '✓') : (lv.mastery ? '◆' : '');
        cell.append(num, medal);
        if (!locked) cell.addEventListener('click', () => onPick(lv));
        grid.appendChild(cell);
      });
    }

    renderProfile(progression, platform) {
      const body = this.$('#profile-body');
      const completed = Object.keys(progression.journey || {}).length;
      const total = Content.JOURNEY.length;
      const name = (platform.profile && platform.profile.name) || 'Guest';
      body.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = name + ' — ' + completed + ' of ' + total + ' journey stages complete. ' +
        progression.stats.totalCompletions + ' total boards finished. Daily streak: ' + progression.streak.count + '.';
      body.appendChild(p);
      if (!platform.hosted) {
        const note = document.createElement('p');
        note.className = 'rail-note';
        note.textContent = 'Playing as guest — progress is stored on this device. Sign in through the host for cloud sync.';
        body.appendChild(note);
      }
      const list = this.$('#achievement-list');
      list.innerHTML = '';
      for (const a of Content.ACHIEVEMENTS) {
        const li = document.createElement('li');
        const got = progression.achievements[a.key];
        li.className = got ? '' : 'locked';
        const n = document.createElement('div'); n.className = 'ach-name';
        n.textContent = (got ? '🏆 ' : '○ ') + a.name;
        const d = document.createElement('div'); d.className = 'ach-desc'; d.textContent = a.desc;
        li.append(n, d);
        list.appendChild(li);
      }
    }

    renderScores(data, boardLabel) {
      const rows = this.$('#scores-rows');
      rows.innerHTML = '';
      const entries = (data && data.entries) || [];
      const note = this.$('#scores-casual-note');
      if (data && data.note) {
        note.hidden = false;
        note.textContent = data.note;
      } else {
        note.hidden = !(data && data.casual);
        note.textContent = 'Casual board — authoritative validation unavailable offline.';
      }
      if (!entries.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5; td.textContent = 'No scores yet — be the first.';
        tr.appendChild(td); rows.appendChild(tr);
        return;
      }
      entries.slice(0, 50).forEach((e, i) => {
        const tr = document.createElement('tr');
        for (const v of [i + 1, e.player || 'Guest', e.score,
             e.seed === null || e.seed === undefined ? '—' : String(e.seed).slice(0, 8),
             fmtTime(e.durationMs || 0)]) {
          const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
        }
        rows.appendChild(tr);
      });
    }

    renderTutorial(step, idx, total) {
      const card = this.$('#tutorial-card');
      if (!step) { card.hidden = true; return; }
      card.hidden = false;
      this.$('#tutorial-title').textContent = 'Lesson ' + (idx + 1) + ' of ' + total + ' — ' + step.title;
      this.$('#tutorial-body').textContent = step.body;
      this.$('#tutorial-hint').textContent = step.hint || '';
    }

    updateTopbar(platform, progression) {
      const conn = this.$('#conn-status');
      conn.textContent = platform.hosted ? 'Online' : 'Offline';
      conn.classList.toggle('online', platform.hosted);
      const sync = this.$('#sync-status');
      if (sync) {
        const st = platform.syncStatus();
        sync.hidden = st === 'offline' || st === 'idle';
        sync.textContent = st === 'synced' ? 'Synced' : st === 'saving' ? 'Saving…' : '';
        sync.classList.toggle('saving', st === 'saving');
      }
      const chip = this.$('#profile-chip');
      chip.textContent = (platform.profile && platform.profile.name) || 'Guest';
      const done = Object.keys((progression && progression.journey) || {}).length;
      this.$('#journey-progress-label').textContent = done + ' / ' + Content.JOURNEY.length + ' stages';
    }
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function signed(n) { return (n >= 0 ? '+' : '') + n; }
  function medalRank(m) { return { gold: 0, silver: 1, bronze: 2, clear: 3 }[m] ?? 4; }
  function paceMedal(moves, par) {
    if (!par) return '—';
    if (moves <= par.gold) return '🥇 gold pace';
    if (moves <= par.silver) return '🥈 silver pace';
    if (moves <= par.bronze) return '🥉 bronze pace';
    return 'clear pace';
  }

  root.SpectrumUI = { UI, fmtTime, DEFAULT_BINDINGS, DEFAULT_GAMEPAD };
})(typeof globalThis !== 'undefined' ? globalThis : this);
