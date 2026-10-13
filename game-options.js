/* Shared Sound and maximum-FPS controls. Ship this file before game scripts.
 * Based on the Starhermit audio/graphics tutorials (wiki revision 4f08e2d).
 * Rendering is paced separately from simulation, input, and network callbacks.
 */
(function (root) {
  'use strict';
  const DEFAULTS = { master: .8, music: .7, effects: 1, ui: .8, maxConcurrentSounds: 'auto', muted: false };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function recommend(nav = {}) {
    const cores = finite(nav.hardwareConcurrency) && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null;
    const memory = finite(nav.deviceMemory) && nav.deviceMemory > 0 ? nav.deviceMemory : null;
    return cores !== null && cores <= 2 || memory !== null && memory <= 2 ? 16 : cores !== null && cores >= 4 ? 64 : 32;
  }
  function resolveAudio(saved = {}, nav = {}) {
    const out = { ...DEFAULTS };
    for (const bus of ['master', 'music', 'effects', 'ui']) if (finite(saved?.[bus])) out[bus] = clamp(saved[bus], 0, 1);
    out.muted = saved?.muted === true;
    out.soundLimitMode = ['auto', 'fixed', 'custom'].includes(saved?.soundLimitMode) ? saved.soundLimitMode : 'auto';
    if (Number.isInteger(saved?.maxConcurrentSounds) && saved.maxConcurrentSounds > 0) out.maxConcurrentSounds = clamp(saved.maxConcurrentSounds, 1, 64);
    out.recommendedConcurrentSounds = recommend(nav);
    out.effectiveConcurrentSounds = out.maxConcurrentSounds === 'auto' ? out.recommendedConcurrentSounds : out.maxConcurrentSounds;
    return out;
  }
  function resolveFps(n) { return finite(n) && n > 0 ? clamp(Math.round(n), 1, 1000) : 0; }
  function volumeGain(n) { return finite(n) ? clamp(n, 0, 1) ** 3 : 0; }
  function classify(name) {
    name = String(name || '').toLowerCase();
    if (/music|ambien|soundtrack|^bgm/.test(name)) return 'music';
    if (/(?:^|\/)ui(?:\b|[-_])|click|menu|button|hover|^ack$|^pause$|^undo$|^hint$/.test(name)) return 'ui';
    return 'effects';
  }
  function gpuProfile(name) {
    name = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!name) return null;
    let hash = 0xcbf29ce484222325n;
    for (const char of name) { hash ^= BigInt(char.codePointAt(0)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
    return hash.toString(16).padStart(16, '0');
  }
  // Pure exports let unit tests run without browser globals.
  if (typeof module === 'object' && module.exports) { module.exports = { resolveAudio, recommend, resolveFps, volumeGain, classify, gpuProfile }; return; }
  if (root.GameOptions) return;
  const doc = root.document;
  const game = doc.currentScript?.dataset.game || 'game';
  const audioKey = `${game}.audio-options`;
  // Legacy games already use `audio` for their original mixer preferences.
  const audioSlot = 'audio.options';
  function read(key) { try { const x = JSON.parse(root.localStorage.getItem(key) || 'null'); return x && typeof x === 'object' ? x : null; } catch { return null; } }
  function write(key, value) { if (key) try { root.localStorage.setItem(key, JSON.stringify(value)); } catch { /* session-only storage */ } }
  function detectGpu() {
    try {
      const gl = doc.createElement('canvas').getContext('webgl');
      if (!gl) return '';
      let name = String(gl.getParameter(gl.RENDERER) || '');
      if (/^webkit|^mozilla/i.test(name) && !/firefox/i.test(root.navigator.userAgent)) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || name);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return name;
    } catch { return ''; }
  }
  const profile = gpuProfile(detectGpu());
  const fpsKey = profile ? `${game}.graphics.gpu.${profile}` : null;
  const fpsSlot = profile ? `graphics.gpu.${profile}` : null;
  let audioRecord = read(audioKey) || { saved: {}, at: 0 };
  let fpsRecord = fpsKey && read(fpsKey) || { saved: {}, at: 0 };
  let audio = resolveAudio(audioRecord.saved, root.navigator);
  let maxFps = resolveFps(fpsRecord.saved?.maxFps);
  let frameTime = null;
  let clocks = new WeakMap();
  const primitiveClocks = new Map();
  const nativeRaf = root.requestAnimationFrame.bind(root);
  // Preserve every callback and its timestamp; only drawing uses the ceiling.
  root.requestAnimationFrame = callback => nativeRaf(now => {
    const previous = frameTime; frameTime = now;
    try { callback(now); } finally { frameTime = previous; }
  });
  function shouldRender(key) {
    if (!maxFps || frameTime === null) return true;
    const store = key && (typeof key === 'object' || typeof key === 'function') ? clocks : primitiveClocks;
    let clock = store.get(key);
    if (!clock) { clock = { at: frameTime, frame: frameTime, due: true }; store.set(key, clock); return true; }
    if (clock.frame === frameTime) return clock.due;
    clock.frame = frameTime;
    const interval = 1000 / maxFps;
    const elapsed = frameTime - clock.at;
    clock.due = elapsed >= interval - .001 || elapsed < 0;
    if (clock.due) clock.at = elapsed > interval * 10 || elapsed < 0 ? frameTime : clock.at + Math.floor((elapsed + .001) / interval) * interval;
    return clock.due;
  }
  let drawing = 0;
  const paintStats = new WeakMap();
  let primaryCanvas = null;
  function noteDraw(canvas) {
    if (frameTime === null || !canvas?.isConnected) return;
    const area = node => (node?.clientWidth || 0) * (node?.clientHeight || 0);
    if (!primaryCanvas?.isConnected || area(canvas) >= area(primaryCanvas)) primaryCanvas = canvas;
    let stats = paintStats.get(canvas);
    if (!stats) { paintStats.set(canvas, { frame: frameTime, at: frameTime, count: 0, fps: 0 }); return; }
    if (stats.frame === frameTime) return;
    stats.frame = frameTime; stats.count++;
    if (frameTime - stats.at >= 500) { stats.fps = stats.count * 1000 / (frameTime - stats.at); stats.count = 0; stats.at = frameTime; }
  }
  function displayFps(reported) {
    if (!maxFps) return reported;
    const stats = primaryCanvas && paintStats.get(primaryCanvas);
    if (stats?.fps) {
      if ((root.performance?.now() || stats.frame) - stats.frame > 1000) return 0;
      return Math.min(maxFps, Math.round(stats.fps));
    }
    return Math.min(maxFps, reported);
  }
  function draw(renderer, callback) {
    const key = renderer?.domElement || renderer?.renderer?.domElement || renderer;
    if (!drawing && !shouldRender(key)) return;
    noteDraw(key);
    drawing++;
    try { return callback(); } finally { drawing--; }
  }
  // Canvas games keep updating particles and gameplay on every callback.
  // Detached canvases (texture/cache generation) are always drawn in full.
  for (const Type of [root.CanvasRenderingContext2D, root.OffscreenCanvasRenderingContext2D]) {
    if (!Type) continue;
    for (const name of ['clearRect', 'fillRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData']) {
      const native = Type.prototype[name];
      if (!native) continue;
      Type.prototype[name] = function (...args) {
        if (this.canvas.isConnected && !shouldRender(this.canvas)) return;
        noteDraw(this.canvas);
        return native.apply(this, args);
      };
    }
  }

  // One allocator covers Web Audio sources and HTML media, including scheduled
  // starts, loops and tails. Lowering the cap reclaims slots before new playback.
  const active = new Map();
  const sources = new Map();
  const routedSources = new WeakMap();
  const edges = new WeakMap();
  const buses = new WeakMap();
  const media = new WeakMap();
  let suppressed = 0;
  const priority = bus => bus === 'music' ? 3 : bus === 'ui' ? 2 : 1;
  function release(node) { active.delete(node); }
  function stop(node) {
    const entry = active.get(node);
    if (!entry) return;
    active.delete(node);
    try { entry.stop(); } catch { /* already stopped */ }
  }
  function admit(node, bus, stopPlayback) {
    if (active.has(node)) return true;
    if (audio.muted || audio.master === 0 || audio[bus] === 0) { suppressed++; return false; }
    if (active.size >= audio.effectiveConcurrentSounds) {
      const victim = [...active].find(([, entry]) => priority(entry.bus) < priority(bus));
      if (!victim) { suppressed++; return false; }
      stop(victim[0]);
    }
    active.set(node, { bus, stop: stopPlayback });
    return true;
  }
  function graphBus(node, visited = new Set()) {
    if (!node || visited.has(node)) return null;
    visited.add(node);
    if (buses.has(node)) return buses.get(node);
    for (const target of edges.get(node) || []) { const bus = graphBus(target, visited); if (bus) return bus; }
    return null;
  }
  function sourceBus(node) {
    const info = sources.get(node);
    if (info?.media) return classify(info.media.dataset?.audioBus || info.media.src || info.media.currentSrc);
    return info?.hint || graphBus(node) || 'effects';
  }
  function gainFor(bus) { return audio.muted ? 0 : volumeGain(audio.master) * volumeGain(audio[bus]); }
  function ramp(param, value, ctx) {
    if (ctx.state === 'closed') return;
    try {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(ctx.currentTime);
      else { param.cancelScheduledValues(ctx.currentTime); param.setValueAtTime?.(param.value, ctx.currentTime); }
      if (param.linearRampToValueAtTime) param.linearRampToValueAtTime(value, ctx.currentTime + .02);
      else param.setTargetAtTime(value, ctx.currentTime, .006);
    } catch { param.value = value; }
  }
  function updatePlayback() {
    for (const [node, info] of sources) {
      const bus = sourceBus(node);
      if (info.gain) ramp(info.gain.gain, gainFor(bus), node.context);
      if (active.has(node)) active.get(node).bus = bus;
    }
    for (const node of active.keys()) {
      const info = media.get(node); if (!info) continue;
      const bus = classify(node.dataset?.audioBus || node.currentSrc || node.src);
      info.bus = bus;
      info.nativeVolume.call(node, clamp(info.volume * (info.routed ? 1 : gainFor(bus)), 0, 1));
      if (active.has(node)) active.get(node).bus = bus;
    }
    while (active.size > audio.effectiveConcurrentSounds) {
      const victim = [...active].sort((a, b) => priority(a[1].bus) - priority(b[1].bus))[0];
      stop(victim[0]);
    }
  }
  const nodeProto = root.AudioNode?.prototype;
  const connect = nodeProto?.connect;
  const disconnect = nodeProto?.disconnect;
  if (connect) {
    nodeProto.connect = function (target, ...args) {
      let targets = edges.get(this); if (!targets) { targets = new Set(); edges.set(this, targets); } targets.add(target);
      const info = sources.get(this) || routedSources.get(this);
      if (!info) return connect.call(this, target, ...args);
      if (info.media && !sources.has(this)) {
        sources.set(this, info);
        const state = media.get(info.media); state.routed = true; state.nativeVolume.call(info.media, state.volume);
      }
      if (info.media && !info.media.paused && !admit(info.media, sourceBus(this), () => info.media.pause())) info.media.pause();
      if (!info.gain) {
        info.gain = this.context.createGain();
        info.gain.gain.value = gainFor(sourceBus(this));
        connect.call(this, info.gain);
      }
      const result = connect.call(info.gain, target, ...args);
      info.gain.gain.value = gainFor(sourceBus(this));
      return result;
    };
    nodeProto.disconnect = function (...args) {
      const info = sources.get(this);
      if (info?.gain) {
        if (!args.length) edges.delete(this); else edges.get(this)?.delete(args[0]);
        if (info.media && !args.length) { sources.delete(this); release(info.media); media.get(info.media).routed = false; }
        return disconnect.apply(info.gain, args);
      }
      if (!args.length) edges.delete(this); else edges.get(this)?.delete(args[0]);
      return disconnect.apply(this, args);
    };
  }
  function trackSource(node, hint) {
    if (!node || !node.context) return node;
    let info = sources.get(node);
    if (!info) {
      info = { gain: null, hint: null }; sources.set(node, info);
      const start = node.start.bind(node), stopSource = node.stop.bind(node);
      let started = false, dropped = false;
      node.start = function (...args) {
        if (started) return start(...args); // retain native invalid-state behavior
        started = true;
        const bus = sourceBus(node);
        if (info.gain) info.gain.gain.value = gainFor(bus);
        if (!admit(node, bus, () => { stopSource(); disconnect?.call(node); info.gain?.disconnect(); })) {
          dropped = true; disconnect?.call(node); info.gain?.disconnect(); sources.delete(node);
          // A disconnected, zero-duration source renders no samples, but still
          // produces the native ended event used by existing mixers to release
          // their voice counters and envelopes. Subsequent stop calls are inert.
          start(node.context.currentTime); stopSource(node.context.currentTime); return;
        }
        try { return start(...args); } catch (error) { release(node); sources.delete(node); throw error; }
      };
      node.stop = function (...args) { if (!dropped) return stopSource(...args); };
      node.addEventListener('ended', () => {
        release(node); sources.delete(node); disconnect?.call(node); info.gain?.disconnect();
      }, { once: true });
    }
    if (hint != null) {
      const name = String(hint).toLowerCase();
      if (['music', 'ambience', 'ui', 'effects', 'world', 'voice'].includes(name)) info.hint = name === 'ambience' ? 'music' : name === 'world' || name === 'voice' ? 'effects' : name;
      else if (classify(name) !== 'effects') info.hint = classify(name);
    }
    return node;
  }
  // Factories are intercepted before any game creates its first context.
  const contextProtos = new Set([root.AudioContext?.prototype, root.webkitAudioContext?.prototype]);
  let nextSourceHint = null;
  let routeMedia = null;
  for (const proto of contextProtos) {
    if (!proto) continue;
    for (const method of ['createBufferSource', 'createOscillator', 'createConstantSource']) {
      const native = proto[method]; if (!native) continue;
      proto[method] = function (...args) {
        const hint = nextSourceHint; nextSourceHint = null;
        return trackSource(native.apply(this, args), hint);
      };
    }
    const close = proto.close;
    if (close) proto.close = async function (...args) {
      const result = await close.apply(this, args);
      for (const [node, info] of sources) if (node.context === this) {
        release(node); sources.delete(node); info.gain?.disconnect();
      }
      for (const node of active.keys()) if (media.get(node)?.context === this) stop(node);
      return result;
    };
    const createMediaSource = proto.createMediaElementSource;
    if (createMediaSource) proto.createMediaElementSource = function (...args) {
      const node = createMediaSource.apply(this, args); routeMedia?.(node, args[0]); return node;
    };
  }
  const mediaProto = root.HTMLMediaElement?.prototype;
  if (mediaProto) {
    const play = mediaProto.play, pause = mediaProto.pause;
    const volume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
    function trackMedia(node) {
      if (media.has(node)) return media.get(node);
      const info = { volume: volume.get.call(node), nativeVolume: volume.set, bus: classify(node.src) };
      media.set(node, info);
      for (const event of ['ended', 'pause', 'error', 'emptied']) node.addEventListener(event, () => { release(node); });
      return info;
    }
    routeMedia = (node, element) => {
      const info = trackMedia(element); info.routed = true; info.context = node.context;
      volume.set.call(element, info.volume);
      const routing = { gain: null, hint: classify(element.dataset?.audioBus || element.currentSrc || element.src), media: element };
      sources.set(node, routing); routedSources.set(node, routing);
    };
    Object.defineProperty(mediaProto, 'volume', { ...volume,
      get() { return media.get(this)?.volume ?? volume.get.call(this); },
      set(value) {
        const requested = Number(value);
        if (!finite(requested) || requested < 0 || requested > 1) return volume.set.call(this, value);
        const info = trackMedia(this); info.volume = requested;
        return volume.set.call(this, requested * (info.routed ? 1 : gainFor(info.bus)));
      },
    });
    mediaProto.play = function (...args) {
      const info = trackMedia(this); info.bus = classify(this.dataset?.audioBus || this.currentSrc || this.src);
      volume.set.call(this, info.volume * (info.routed ? 1 : gainFor(info.bus)));
      for (const routing of sources.values()) if (routing.media === this && routing.gain) routing.gain.gain.value = gainFor(info.bus);
      if (active.has(this)) active.get(this).bus = info.bus;
      if (!admit(this, info.bus, () => pause.call(this))) return Promise.resolve();
      try { const result = play.apply(this, args); result?.catch(() => release(this)); return result; }
      catch (error) { release(this); throw error; }
    };
    mediaProto.pause = function (...args) { release(this); return pause.apply(this, args); };
  }

  let sdk = null, user = null, cloudReady = false, loading = null, timer = 0;
  let audioDirty = false, fpsDirty = false;
  let cloudGraphics = {};
  const validRecord = x => x && typeof x === 'object' && x.saved && typeof x.saved === 'object' && finite(x.at) && x.at >= 0;
  async function loadCloud() {
    if (!sdk?.signedIn || !sdk.slug || loading) return loading;
    const account = sdk.userId;
    loading = (async () => {
      try {
        // The SDK's convenience getSettings swallows read failures; use its raw
        // authenticated API so failed reads cannot authorize stale overwrites.
        const result = await sdk.api(`/api/v1/games/${encodeURIComponent(sdk.slug)}/settings`);
        if (!sdk.signedIn || sdk.userId !== account) return;
        const values = result?.settings || {};
        if (validRecord(values[audioSlot])) {
          if (values[audioSlot].at > audioRecord.at) { audioRecord = { saved: resolveAudio(values[audioSlot].saved, root.navigator), at: values[audioSlot].at }; audioDirty = false; write(audioKey, audioRecord); }
          else if (audioRecord.at > values[audioSlot].at) audioDirty = true;
        } else if (audioRecord.at) audioDirty = true;
        if (fpsSlot && validRecord(values[fpsSlot])) {
          cloudGraphics = values[fpsSlot].saved;
          if (values[fpsSlot].at > fpsRecord.at) { fpsRecord = values[fpsSlot]; fpsDirty = false; write(fpsKey, fpsRecord); }
          else if (fpsRecord.at > values[fpsSlot].at) fpsDirty = true;
        } else if (fpsKey && fpsRecord.at) fpsDirty = true;
        audio = resolveAudio(audioRecord.saved, root.navigator); maxFps = resolveFps(fpsRecord.saved?.maxFps); clocks = new WeakMap(); primitiveClocks.clear();
        cloudReady = true; updatePlayback(); refreshPanels(); scheduleCloud();
      } catch { cloudReady = false; } finally { loading = null; }
    })();
    return loading;
  }
  async function flushCloud() {
    if (!sdk?.signedIn) return;
    if (!cloudReady) await loadCloud();
    if (!cloudReady || !sdk.signedIn) return;
    const patch = {};
    if (audioDirty) patch[audioSlot] = audioRecord;
    if (fpsDirty && fpsSlot) patch[fpsSlot] = { saved: { ...cloudGraphics, ...fpsRecord.saved }, at: fpsRecord.at };
    if (!Object.keys(patch).length) return;
    try {
      await sdk.api(`/api/v1/games/${encodeURIComponent(sdk.slug)}/settings`, { method: 'PATCH', body: { settings: patch } });
      if (patch[audioSlot] === audioRecord) audioDirty = false;
      if (patch[fpsSlot]?.at === fpsRecord.at) fpsDirty = false;
    } catch { /* retain local changes for the next retry */ }
  }
  function scheduleCloud() { root.clearTimeout(timer); timer = root.setTimeout(flushCloud, 800); }
  function setAudio(patch) {
    audio = resolveAudio({ ...audio, ...patch }, root.navigator);
    audioRecord = { saved: { master: audio.master, music: audio.music, effects: audio.effects, ui: audio.ui, maxConcurrentSounds: audio.maxConcurrentSounds, soundLimitMode: audio.soundLimitMode, muted: audio.muted }, at: Date.now() };
    audioDirty = true; write(audioKey, audioRecord); updatePlayback(); refreshPanels(); scheduleCloud();
  }
  function setFps(value) {
    maxFps = resolveFps(value); clocks = new WeakMap(); primitiveClocks.clear();
    fpsRecord = { saved: { ...fpsRecord.saved, maxFps: maxFps || null }, at: Date.now() };
    fpsDirty = true; write(fpsKey, fpsRecord); refreshPanels(); scheduleCloud();
  }
  root.GameOptions = {
    draw, shouldRender, displayFps, trackSource, mount, open: openOptions,
    // A synchronous WASM fallback can carry its bus across the JS bridge.
    hintNextSource(hint) { nextSourceHint = hint; Promise.resolve().then(() => { nextSourceHint = null; }); },
    tagBus(node, name) { if (node && typeof node === 'object' && name !== 'master') buses.set(node, classify(name === 'ambience' ? 'music' : name)); return node; },
    setAudio, setFps,
    get audio() { return { ...audio }; }, get maxFps() { return maxFps; },
    get diagnostics() { return { active: active.size, suppressed, limit: audio.effectiveConcurrentSounds }; },
  };
  // Existing module tests run without the browser; generated call sites guard
  // this API accordingly. The browser always loads it before those modules.

  const TEXT = {
    en: ['Sound', 'Master volume', 'Music volume', 'Sound effects volume', 'UI volume', 'Mute', 'Maximum concurrent sounds', 'Auto (detected: {n})', 'Custom', 'Maximum frame rate', 'Auto (refresh rate)', 'Custom FPS', 'Effective limit: {n} (maximum 64)', 'Graphics'],
    es: ['Sonido', 'Volumen general', 'Volumen de música', 'Volumen de efectos', 'Volumen de interfaz', 'Silenciar', 'Máximo de sonidos simultáneos', 'Automático (detectado: {n})', 'Personalizado', 'Frecuencia máxima de fotogramas', 'Automática (frecuencia de pantalla)', 'FPS personalizados', 'Límite efectivo: {n} (máximo 64)', 'Gráficos'],
    de: ['Sound', 'Gesamtlautstärke', 'Musiklautstärke', 'Effektlautstärke', 'Menülautstärke', 'Stummschalten', 'Maximale gleichzeitige Klänge', 'Auto (erkannt: {n})', 'Benutzerdefiniert', 'Maximale Bildrate', 'Auto (Bildschirmfrequenz)', 'Eigene FPS', 'Effektives Limit: {n} (maximal 64)', 'Grafik'],
    fr: ['Son', 'Volume général', 'Volume de la musique', 'Volume des effets', 'Volume de l’interface', 'Couper le son', 'Nombre maximal de sons simultanés', 'Auto (détecté : {n})', 'Personnalisé', 'Fréquence d’images maximale', 'Auto (fréquence de l’écran)', 'FPS personnalisés', 'Limite effective : {n} (maximum 64)', 'Graphismes'],
    pt: ['Som', 'Volume geral', 'Volume da música', 'Volume dos efeitos', 'Volume da interface', 'Silenciar', 'Máximo de sons simultâneos', 'Automático (detectado: {n})', 'Personalizado', 'Taxa máxima de quadros', 'Automática (taxa da tela)', 'FPS personalizados', 'Limite efetivo: {n} (máximo 64)', 'Gráficos'],
    it: ['Audio', 'Volume generale', 'Volume della musica', 'Volume degli effetti', 'Volume dell’interfaccia', 'Silenzia', 'Numero massimo di suoni simultanei', 'Auto (rilevati: {n})', 'Personalizzato', 'Frequenza massima dei fotogrammi', 'Auto (frequenza dello schermo)', 'FPS personalizzati', 'Limite effettivo: {n} (massimo 64)', 'Grafica'],
  };
  let nextId = 0;
  const panels = new Set();
  let localeOverride = null, panelLanguage = null;
  function localeSelect(node) {
    if (node?.tagName !== 'SELECT') return false;
    const values = [...node.options].map(option => option.value.toLowerCase());
    return values.some(value => /^en(?:[-_]|$)/.test(value)) && values.some(value => /^es(?:[-_]|$)/.test(value));
  }
  function language() {
    const choice = [...doc.querySelectorAll('select')].find(node => localeSelect(node) && /^(en|es|de|fr|pt|it)(?:[-_]|$)/i.test(node.value));
    const value = localeOverride || choice?.value || (doc.documentElement.lang && !/^en(?:[-_]|$)/i.test(doc.documentElement.lang) ? doc.documentElement.lang : root.navigator.language || 'en');
    return String(value).toLowerCase().split(/[-_]/)[0];
  }
  function strings() { return TEXT[language()] || TEXT.en; }
  function openOptions() {
    let dialog = doc.querySelector('[data-game-options-dialog]');
    if (!dialog) {
      const t = strings();
      dialog = doc.createElement('dialog'); dialog.dataset.gameOptionsDialog = ''; dialog.className = 'game-options-dialog';
      const title = doc.createElement('h2'); title.textContent = t[13];
      const host = doc.createElement('section'); host.append(title); dialog.append(host);
      const close = doc.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close');
      const lang = language();
      close.setAttribute('aria-label', ({ en: 'Close', es: 'Cerrar', de: 'Schließen', fr: 'Fermer', pt: 'Fechar', it: 'Chiudi' })[lang] || 'Close');
      close.addEventListener('click', () => dialog.close()); dialog.append(close);
      doc.body.append(dialog); mount(host);
    }
    dialog.showModal();
  }
  function row(container, text, control, output) {
    const label = doc.createElement('label'); label.className = 'game-options-row';
    const span = doc.createElement('span'); span.textContent = text;
    control.id = `game-options-${++nextId}`; label.htmlFor = control.id;
    label.append(span, control); if (output) label.append(output); container.append(label); return label;
  }
  function select(values) {
    const el = doc.createElement('select');
    for (const [value, text] of values) { const option = doc.createElement('option'); option.value = value; option.textContent = text; el.append(option); }
    return el;
  }
  function number(min, max, value) { const el = doc.createElement('input'); el.type = 'number'; el.min = min; el.max = max; el.step = '1'; el.required = true; el.value = value; return el; }
  function mount(host) {
    if (host.querySelector('[data-game-options-fps]')) return;
    const t = strings();
    const addRow = (container, index, control, output) => {
      const label = row(container, t[index], control, output); label.dataset.gameOptionsLabel = String(index); return label;
    };
    const fps = doc.createElement('div'); fps.className = 'game-options-controls'; fps.dataset.gameOptionsFps = '';
    const keepControlKeys = event => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation(); };
    fps.addEventListener('keydown', keepControlKeys);
    const mode = select([['auto', t[10]], ['custom', t[8]]]); mode.dataset.gameOption = 'frame-rate-mode';
    const limit = number('1', '1000', maxFps || 60); limit.dataset.gameOption = 'max-fps';
    addRow(fps, 9, mode); const limitRow = addRow(fps, 11, limit);
    mode.addEventListener('change', () => setFps(mode.value === 'auto' ? 0 : Number(limit.value) || 60));
    limit.addEventListener('change', () => { if (limit.checkValidity() && Number.isInteger(Number(limit.value))) setFps(Number(limit.value)); else { limit.reportValidity(); refreshPanels(); } });
    host.append(fps);
    const sound = doc.createElement('section'); sound.className = 'game-options-controls game-options-sound'; sound.dataset.settingsSection = 'sound';
    sound.addEventListener('keydown', keepControlKeys);
    const heading = doc.createElement('h3'); heading.textContent = t[0]; sound.append(heading);
    const sliders = {};
    for (const [i, bus] of ['master', 'music', 'effects', 'ui'].entries()) {
      const slider = doc.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.dataset.gameAudio = bus;
      const output = doc.createElement('output'); addRow(sound, i + 1, slider, output); output.htmlFor = slider.id;
      sliders[bus] = { slider, output }; slider.addEventListener('input', () => setAudio({ [bus]: Number(slider.value) / 100 }));
    }
    const mute = doc.createElement('input'); mute.type = 'checkbox'; mute.dataset.gameAudio = 'muted'; addRow(sound, 5, mute);
    mute.addEventListener('change', () => setAudio({ muted: mute.checked }));
    const sounds = select([['auto', t[7].replace('{n}', audio.recommendedConcurrentSounds)], ['16', '16'], ['32', '32'], ['64', '64'], ['custom', t[8]]]); sounds.dataset.gameAudio = 'maxConcurrentSounds';
    addRow(sound, 6, sounds);
    const count = number('1', '64', audio.effectiveConcurrentSounds); count.dataset.gameAudio = 'customConcurrentSounds';
    const countRow = addRow(sound, 8, count);
    const summary = doc.createElement('p'); summary.className = 'game-options-summary'; summary.setAttribute('aria-live', 'polite'); sound.append(summary);
    sounds.addEventListener('change', () => setAudio({ soundLimitMode: sounds.value === 'custom' ? 'custom' : sounds.value === 'auto' ? 'auto' : 'fixed', maxConcurrentSounds: sounds.value === 'auto' ? 'auto' : sounds.value === 'custom' ? Number(count.value) || 32 : Number(sounds.value) }));
    count.addEventListener('change', () => { if (count.checkValidity() && Number.isInteger(Number(count.value))) setAudio({ maxConcurrentSounds: Number(count.value) }); else { count.reportValidity(); refreshPanels(); } });
    // Keep Sound inside the same scrollable options area and focus trap.
    host.append(sound);
    panels.add({ host, sound, heading, fps, mode, limit, limitRow, sliders, mute, sounds, count, countRow, summary });
    refreshPanels();
  }
  function refreshPanels() {
    const t = strings();
    for (const panel of panels) {
      if (!panel.host.isConnected || !panel.sound.isConnected || !panel.fps.isConnected) { panels.delete(panel); continue; }
      if (panel.text !== t) {
        panel.text = t; panel.heading.textContent = t[0];
        for (const node of [...panel.fps.querySelectorAll('[data-game-options-label]'), ...panel.sound.querySelectorAll('[data-game-options-label]')]) node.firstElementChild.textContent = t[Number(node.dataset.gameOptionsLabel)];
        panel.mode.options[0].textContent = t[10]; panel.mode.options[1].textContent = t[8];
        panel.sounds.options[4].textContent = t[8];
      }
      const detected = t[7].replace('{n}', audio.recommendedConcurrentSounds);
      if (panel.sounds.options[0].textContent !== detected) panel.sounds.options[0].textContent = detected;
      panel.mode.value = maxFps ? 'custom' : 'auto'; panel.limitRow.hidden = !maxFps;
      if (maxFps) panel.limit.value = String(maxFps);
      for (const bus of ['master', 'music', 'effects', 'ui']) { panel.sliders[bus].slider.value = String(Math.round(audio[bus] * 100)); panel.sliders[bus].output.textContent = `${Math.round(audio[bus] * 100)}%`; }
      panel.mute.checked = audio.muted;
      panel.sounds.value = audio.maxConcurrentSounds === 'auto' ? 'auto' : audio.soundLimitMode !== 'custom' && [16, 32, 64].includes(audio.maxConcurrentSounds) ? String(audio.maxConcurrentSounds) : 'custom';
      panel.countRow.hidden = panel.sounds.value !== 'custom'; panel.count.value = String(audio.effectiveConcurrentSounds);
      panel.summary.textContent = t[12].replace('{n}', audio.effectiveConcurrentSounds);
    }
  }
  function scan() {
    const lang = language(); if (panelLanguage !== lang) { panelLanguage = lang; refreshPanels(); }
    if (root.StarHermit && sdk !== root.StarHermit) {
      sdk = root.StarHermit;
      const auth = () => { if (!sdk.signedIn) { user = null; cloudReady = false; } else if (user !== sdk.userId) { user = sdk.userId; cloudReady = false; loadCloud(); } };
      sdk.on('auth', auth); auth();
    }
    for (const preset of doc.querySelectorAll('select')) {
      if (preset.closest('.game-options-controls')) continue;
      const values = [...preset.options].map(option => option.value.toLowerCase());
      if (!values.includes('low') || !values.includes('high') || !(values.includes('balanced') || values.includes('medium')) || !(values.includes('auto') || values.includes('ultra'))) continue;
      let host = preset.closest('[data-options-graphics], fieldset, section, .gfx-panel, .gfx-section, .option-pane');
      if (!host) {
        host = preset.parentElement;
        while (host?.parentElement && host.querySelectorAll('input, select').length < 4) host = host.parentElement;
      }
      if (host && host !== doc.body && host !== doc.documentElement) mount(host);
    }
    if (maxFps) for (const meter of doc.querySelectorAll('[id*="fps"], [class*="fps"], [data-fps], #gfx-summary, .gfx-summary')) {
      if (meter.children.length || meter.closest('.game-options-controls')) continue;
      const text = meter.textContent;
      const paced = text.replace(/(\d+(?:\.\d+)?)\s*(fps)\b/gi, (_, number, unit) => `${displayFps(Number(number))} ${unit}`);
      if (paced !== text) meter.textContent = paced;
    }
  }
  function ready() {
    const style = doc.createElement('style'); style.textContent = `
      .game-options-controls{box-sizing:border-box;grid-column:1/-1;width:100%;min-width:0;margin:12px 0;color:inherit;font:inherit}
      .game-options-controls h3{margin:12px 0 8px;font-size:1.1em}
      .game-options-row{box-sizing:border-box;display:grid!important;grid-template-columns:minmax(0,1fr) minmax(90px,42%) auto;align-items:center;gap:8px;margin:8px 0;width:100%;min-height:44px;white-space:normal!important}
      .game-options-row[hidden]{display:none!important}
      .game-options-row>span{min-width:0;overflow-wrap:anywhere}
      .game-options-row input,.game-options-row select{box-sizing:border-box;min-width:0;max-width:100%;width:100%;min-height:44px;font:inherit;color:inherit;accent-color:var(--accent,#a9cfff)}
      .game-options-row select,.game-options-row input[type=number]{background:var(--panel2,#202735);color:var(--text,#f4f6ff);border:1px solid #687080;border-radius:5px;padding:5px}
      .game-options-row input[type=checkbox]{width:22px;min-height:22px;justify-self:end}
      .game-options-row output{min-width:3em;text-align:right;font-variant-numeric:tabular-nums}
      .game-options-summary{font-size:.85em;white-space:normal;overflow-wrap:anywhere}
      .game-options-dialog{box-sizing:border-box;width:min(580px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:20px;background:var(--panel,#202735);color:var(--text,#f4f6ff);border:1px solid #687080;border-radius:10px}
      .game-options-dialog::backdrop{background:#0009}
      @media(max-width:480px){.game-options-row{grid-template-columns:minmax(0,1fr) minmax(80px,40%) auto;gap:5px;font-size:.9em}}
    `; doc.head.append(style);
    scan();
    let queued = false;
    const observer = new root.MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' && record.attributeName === 'lang')) localeOverride = doc.documentElement.lang;
      if (queued) return; queued = true; root.setTimeout(() => { queued = false; scan(); }, 0);
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
    doc.addEventListener('change', event => { if (localeSelect(event.target)) { localeOverride = /^(en|es|de|fr|pt|it)(?:[-_]|$)/i.test(event.target.value) ? event.target.value : null; refreshPanels(); } });
    root.addEventListener('pagehide', flushCloud);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})(typeof window !== 'undefined' ? window : globalThis);
