/**
 * audio.js — original synthesized audio plus authored one-shot samples.
 *
 * Buses: music / effects / ambience / voice -> master. Independent sliders,
 * captions are surfaced by the UI (no audio-only gameplay). Event sounds are
 * short synthesized transients tied to logical events; pitch variants come
 * from the session's seeded audio stream for replay consistency. Where an
 * authored sample exists (sfx/<name>.opus, see sfx/manifest.json) it is
 * lazy-fetched after the user-gesture unlock and played through the effects
 * bus; synthesis remains the fallback while loading or on failure.
 *
 * Hierarchy (spec §4): acknowledgment < legal move < goal < round completion.
 */
(function (root) {
  'use strict';

  /** Logical event -> authored one-shot basename in sfx/ (manifest.json). */
  const EVENT_SAMPLES = {
    ui: 'ui-click',
    focus: 'ui-focus',
    pick: 'orb-pick',
    drop: 'orb-drop',
    stack: 'orb-stack',
    invalid: 'invalid-buzz',
    'tube-complete': 'tube-complete',
    win: 'round-win',
    lose: 'round-lose',
    undo: 'undo-swoosh',
    hint: 'hint-chime',
    tick: 'timer-tick',
  };

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buses = {};
      this.volumes = { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.8 };
      this.muted = false;
      this.variantRng = null;   // seeded stream for pitch variants
      this._ambience = null;
      this._music = null;
      this._started = false;
      this._sampleCache = new Map(); // basename -> { buffer: AudioBuffer|null }
    }

    /** Must be called from a user gesture. Safe to call repeatedly. */
    ensureStarted() {
      if (this._started) { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); return; }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const mk = () => { const g = this.ctx.createGain(); g.connect(this.master); return g; };
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        for (const name of ['music', 'effects', 'ambience', 'voice']) this.buses[name] = mk();
        this._applyVolumes();
        this._started = true;
      } catch (e) { /* audio unavailable: game stays fully playable */ }
    }

    setVariantStream(rng) { this.variantRng = rng; }
    _variant() { return this.variantRng ? 0.94 + this.variantRng.float() * 0.12 : 1; }

    setVolumes(v) { Object.assign(this.volumes, v || {}); this._applyVolumes(); }
    setMuted(m) { this.muted = m; this._applyVolumes(); }
    _applyVolumes() {
      if (!this._started) return;
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.05);
      for (const [name, bus] of Object.entries(this.buses)) {
        bus.gain.setTargetAtTime(this.volumes[name] ?? 0.7, t, 0.05);
      }
    }

    /** Short synthesized blip. All original transients. */
    _blip(bus, freq, dur, type, gain, slideTo) {
      if (!this._started) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq * this._variant(), t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(this.buses[bus]);
      osc.start(t); osc.stop(t + dur + 0.05);
    }

    _noise(bus, dur, gain, filterFreq) {
      if (!this._started) return;
      const t = this.ctx.currentTime;
      const len = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = filterFreq || 2000; f.Q.value = 0.8;
      const g = this.ctx.createGain(); g.gain.value = gain;
      src.connect(f); f.connect(g); g.connect(this.buses[bus]);
      src.start(t);
    }

    /**
     * Lazy-fetch and decode an authored sample into the cache. Only ever
     * called after the user-gesture unlock; failures keep synthesis live.
     */
    _loadSample(name) {
      if (!this._started || this._sampleCache.has(name)) return; // no duplicate fetches
      const entry = { buffer: null };
      this._sampleCache.set(name, entry);
      fetch('sfx/' + name + '.opus')
        .then((r) => { if (!r.ok) throw new Error('http-' + r.status); return r.arrayBuffer(); })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { entry.buffer = buf; })
        .catch(() => { /* keep entry cached as failed: synthesis stays the fallback */ });
    }

    /** Play a cached sample through the given bus. False while loading/failed. */
    _playSample(name, bus) {
      const entry = this._sampleCache.get(name);
      if (entry && entry.buffer) {
        const src = this.ctx.createBufferSource();
        src.buffer = entry.buffer;
        src.connect(this.buses[bus] || this.buses.effects);
        src.start();
        return true;
      }
      this._loadSample(name);
      return false;
    }

    /** Map logical game events to sound (tiered per spec §4). */
    event(name, opts) {
      if (!this._started) return;
      const sample = EVENT_SAMPLES[name];
      if (sample && this._playSample(sample, name === 'hint' ? 'voice' : 'effects')) return;
      switch (name) {
        case 'ui': this._blip('effects', 660, 0.07, 'triangle', 0.15); break;
        case 'focus': this._blip('effects', 440, 0.04, 'sine', 0.06); break;
        case 'pick': this._blip('effects', 520, 0.12, 'sine', 0.2, 760); break;          // acknowledgment
        case 'drop': this._blip('effects', 340, 0.14, 'sine', 0.22, 240);
          this._noise('effects', 0.08, 0.08, 3200); break;                                // legal move
        case 'stack': this._blip('effects', 392, 0.1, 'triangle', 0.18, 523);
          this._noise('effects', 0.06, 0.1, 2600); break;                                 // matching stack
        case 'invalid': this._blip('effects', 180, 0.18, 'square', 0.08, 120); break;     // soft error
        case 'tube-complete':                                                               // goal tier
          [523, 659, 784].forEach((f, i) => setTimeout(() => this._blip('effects', f, 0.2, 'sine', 0.18), i * 70));
          break;
        case 'win':                                                                         // round completion
          [392, 523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this._blip('effects', f, 0.4, 'sine', 0.2), i * 110));
          this._noise('effects', 0.6, 0.05, 5200);
          break;
        case 'lose': [330, 262, 196].forEach((f, i) => setTimeout(() => this._blip('effects', f, 0.35, 'sine', 0.15), i * 160)); break;
        case 'undo': this._blip('effects', 500, 0.1, 'sine', 0.14, 380); break;
        case 'hint': this._blip('voice', 880, 0.25, 'sine', 0.1, 990); break;
        case 'tick': this._blip('effects', 980, 0.03, 'sine', 0.05); break;
      }
    }

    /** Quiet looped ambience per theme; adaptive two-stem music. */
    startAmbience(themeKey, seedRng) {
      if (!this._started || this._ambience) return;
      const baseFreqs = { dawn: 196, garden: 174, night: 146, hearth: 130, loft: 220 };
      const theme = { atrium: 'dawn', verdant: 'garden', midnight: 'night', ember: 'hearth', porcelain: 'loft' }[themeKey] || 'dawn';
      const base = baseFreqs[theme];
      const mkPad = (freq, detune, gain) => {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine'; osc.frequency.value = freq; osc.detune.value = detune;
        const g = this.ctx.createGain(); g.gain.value = gain;
        const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07 + detune * 0.001;
        const lfoG = this.ctx.createGain(); lfoG.gain.value = gain * 0.5;
        lfo.connect(lfoG); lfoG.connect(g.gain);
        osc.connect(g); g.connect(this.buses.ambience);
        osc.start(); lfo.start();
        return { osc, g, lfo };
      };
      this._ambience = [mkPad(base, 0, 0.05), mkPad(base * 1.5, 6, 0.03), mkPad(base * 2.02, -4, 0.015)];

      // Adaptive music: sparse pentatonic plucks; intensity follows progress.
      const scale = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
      const rng = seedRng || { float: Math.random };
      let step = 0;
      this._musicIntensity = 0.3;
      this._music = setInterval(() => {
        if (!this._started || this.muted) return;
        step++;
        if (rng.float() > this._musicIntensity) return; // density follows progress
        const f = base * 2 * scale[Math.floor(rng.float() * scale.length) % scale.length];
        this._blip('music', f, 1.2, 'sine', 0.05);
        if (step % 16 === 0) this._blip('music', base, 2.4, 'triangle', 0.05);
      }, 600);
    }

    /** progress 0..1 raises musical density (adaptive stem). */
    setProgress(p) { this._musicIntensity = 0.2 + Math.min(1, Math.max(0, p)) * 0.5; }

    stopAmbience() {
      if (this._ambience) {
        for (const p of this._ambience) {
          try { p.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3); p.osc.stop(this.ctx.currentTime + 1.2); p.lfo.stop(this.ctx.currentTime + 1.2); } catch (e) {}
        }
        this._ambience = null;
      }
      if (this._music) { clearInterval(this._music); this._music = null; }
    }

    /** Background tabs: silence but keep context alive for instant resume. */
    setBackgrounded(bg) {
      if (!this._started) return;
      this.master.gain.setTargetAtTime(bg || this.muted ? 0 : 1, this.ctx.currentTime, 0.1);
    }
  }

  root.SpectrumAudio = { AudioEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
