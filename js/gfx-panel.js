/**
 * gfx-panel.js — the Graphics section of the Settings overlay.
 *
 * Builds the quality controls from the pure model in gfx.js, localizes its own
 * strings (the rest of the game is English-only), writes changes into
 * settings.graphics and asks the caller to apply + persist them.
 */
import { PRESETS, CATEGORIES, SHADOW_MAP, presetTier, resolve, withPreset } from './gfx.js';

const EN = {
  quality: 'Quality', auto: 'Auto (detected: {tier})',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  fromPreset: 'From preset ({tier})', effects: 'Effects',
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles',
    background: 'Background', detail: 'Gallery detail',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA',
    msaa: 'MSAA', static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
  },
  noShadows: 'no shadows', noAA: 'no anti-aliasing',
  postNote: 'Post-processing is unavailable on this device; rendering without it.',
  noWebgl: '3D view unavailable — graphics settings apply when WebGL is available.',
};

const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cats: { ...EN.cats, grade: 'Colour grade' } },
  'es-419': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', showFps: 'Mostrar cuadros por segundo',
    fromPreset: 'Según calidad ({tier})', effects: 'Efectos',
    cats: {
      shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
      antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas',
      background: 'Fondo', detail: 'Detalle de la galería',
    },
    tiers: {
      off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simple', detailed: 'Detallado',
    },
    noShadows: 'sin sombras', noAA: 'sin antialiasing',
    postNote: 'El posprocesamiento no está disponible en este dispositivo; se renderiza sin él.',
    noWebgl: 'Vista 3D no disponible: los ajustes gráficos se aplican cuando WebGL esté disponible.',
  },
  'de-DE': {
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    renderScale: 'Renderskalierung', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    fromPreset: 'Aus Voreinstellung ({tier})', effects: 'Effekte',
    cats: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Partikel',
      background: 'Hintergrund', detail: 'Galeriedetails',
    },
    tiers: {
      off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert',
    },
    noShadows: 'keine Schatten', noAA: 'keine Kantenglättung',
    postNote: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne sie gerendert.',
    noWebgl: '3D-Ansicht nicht verfügbar – Grafikeinstellungen gelten, sobald WebGL verfügbar ist.',
  },
  'fr-FR': {
    quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    fromPreset: 'Selon le préréglage ({tier})', effects: 'Effets',
    cats: {
      shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Flou lumineux', grade: 'Étalonnage',
      antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules',
      background: 'Arrière-plan', detail: 'Détails de la galerie',
    },
    tiers: {
      off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
    },
    noShadows: 'sans ombres', noAA: 'sans anticrénelage',
    postNote: 'Le post-traitement est indisponible sur cet appareil ; rendu sans post-traitement.',
    noWebgl: 'Vue 3D indisponible : les réglages graphiques s’appliqueront quand WebGL sera disponible.',
  },
  'pt-BR': {
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderização', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    fromPreset: 'Da predefinição ({tier})', effects: 'Efeitos',
    cats: {
      shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho (bloom)', grade: 'Correção de cor',
      antialias: 'Suavização de serrilhado', reflections: 'Reflexos', particles: 'Partículas',
      background: 'Fundo', detail: 'Detalhes da galeria',
    },
    tiers: {
      off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
    },
    noShadows: 'sem sombras', noAA: 'sem suavização',
    postNote: 'O pós-processamento não está disponível neste dispositivo; renderizando sem ele.',
    noWebgl: 'Visão 3D indisponível — as configurações gráficas valem quando o WebGL estiver disponível.',
  },
  'it-IT': {
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Scala di rendering', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame rate',
    fromPreset: 'Da preimpostazione ({tier})', effects: 'Effetti',
    cats: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
      antialias: 'Anti-aliasing', reflections: 'Riflessi', particles: 'Particelle',
      background: 'Sfondo', detail: 'Dettagli della galleria',
    },
    tiers: {
      off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
    },
    noShadows: 'senza ombre', noAA: 'senza anti-aliasing',
    postNote: 'La post-elaborazione non è disponibile su questo dispositivo; rendering senza.',
    noWebgl: 'Vista 3D non disponibile: le impostazioni grafiche si applicano quando WebGL è disponibile.',
  },
};
STRINGS['es-ES'] = {
  ...STRINGS['es-419'],
  renderScale: 'Escala de renderizado', showFps: 'Mostrar fotogramas por segundo',
  noWebgl: 'Vista 3D no disponible: los ajustes gráficos se aplicarán cuando WebGL esté disponible.',
};
STRINGS['fr-CA'] = {
  ...STRINGS['fr-FR'],
  showFps: 'Afficher la fréquence d’images',
  cats: { ...STRINGS['fr-FR'].cats, bloom: 'Halo lumineux' },
};

const FALLBACK = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick the panel locale from a BCP-47 tag (exact, then by language). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(STRINGS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  return FALLBACK[t.slice(0, 2).toLowerCase()] || 'en-US';
}

export function strings(locale) { return STRINGS[pickLocale(locale)]; }
export const LOCALES = Object.keys(STRINGS);

/**
 * Mount the panel into `root` (the Graphics fieldset).
 * opts: { settings (object with .graphics), onChange(), renderer (may be null) }
 */
export function mountGraphicsPanel(root, opts) {
  const locale = pickLocale(document.documentElement.getAttribute('data-locale') || navigator.language);
  const T = STRINGS[locale];
  const fill = (s, tier) => s.replace('{tier}', tier);
  const g = () => opts.settings.graphics;
  const r = opts.renderer && opts.renderer.renderer ? opts.renderer : null;
  const detected = r ? r.detected : 'low';

  const wrap = document.createElement('div');
  wrap.className = 'gfx-panel';
  wrap.lang = locale;
  wrap.innerHTML = `
    <label>${T.quality}
      <select id="set-tier" data-gfx="preset"></select>
    </label>
    <label class="gfx-scale-row">${T.renderScale}
      <span class="gfx-scale"><input type="range" id="gfx-scale" data-gfx="render_scale" min="50" max="200" step="5">
      <output id="gfx-scale-value" for="gfx-scale"></output></span>
    </label>
    <label class="check"><input type="checkbox" id="gfx-adaptive" data-gfx="adaptive"> ${T.adaptive}</label>
    <label class="check"><input type="checkbox" id="gfx-show-fps" data-gfx="show_fps"> ${T.showFps}</label>
    <div class="gfx-cats" role="group" aria-label="${T.effects}"></div>
    <p class="rail-note gfx-summary" id="gfx-summary" aria-live="polite"></p>
    <p class="rail-note gfx-note" id="gfx-post-note" hidden></p>`;
  root.appendChild(wrap);

  const presetSel = wrap.querySelector('#set-tier');
  const scale = wrap.querySelector('#gfx-scale');
  const scaleOut = wrap.querySelector('#gfx-scale-value');
  const adaptive = wrap.querySelector('#gfx-adaptive');
  const showFps = wrap.querySelector('#gfx-show-fps');
  const cats = wrap.querySelector('.gfx-cats');
  const summary = wrap.querySelector('#gfx-summary');
  const note = wrap.querySelector('#gfx-post-note');

  const catSelects = {};
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const label = document.createElement('label');
    label.textContent = T.cats[cat] + ' ';
    const sel = document.createElement('select');
    sel.id = 'gfx-cat-' + cat;
    sel.dataset.gfx = cat;
    sel.innerHTML = `<option value="preset"></option>` + tiers.map((t) => `<option value="${t}">${T.tiers[t]}</option>`).join('');
    sel.addEventListener('change', () => {
      if (sel.value === 'preset') delete g()[cat]; else g()[cat] = sel.value;
      commit();
    });
    label.appendChild(sel);
    cats.appendChild(label);
    catSelects[cat] = sel;
  }

  presetSel.addEventListener('change', () => {
    opts.settings.graphics = withPreset(g(), presetSel.value); // clears overrides
    commit();
  });
  scale.addEventListener('input', () => { scaleOut.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => { g().render_scale = Number(scale.value) / 100; commit(); });
  adaptive.addEventListener('change', () => { g().adaptive = adaptive.checked; commit(); });
  showFps.addEventListener('change', () => { g().show_fps = showFps.checked; commit(); });

  function commit() {
    opts.onChange();
    refresh();
  }

  function describeLocal(q, info) {
    const parts = [
      q.shadows === 'off' ? T.noShadows : `${SHADOW_MAP[q.shadows]}² ${T.cats.shadows.toLowerCase()}`,
      q.ao === 'off' ? null : T.cats.ao,
      q.bloom === 'on' ? T.cats.bloom : null,
      q.reflections === 'on' ? T.cats.reflections : null,
      q.antialias === 'off' ? T.noAA : q.antialias.toUpperCase(),
    ].filter(Boolean);
    const px = info && info.resolved ? info.summary.match(/(\d+)×(\d+) px/) : null;
    return [info ? info.gpu : null, parts.join(', '), px ? px[0] : null].filter(Boolean).join(' · ');
  }

  function refresh() {
    const saved = g();
    const q = resolve(saved, detected);
    const autoTier = T.presets[detected];
    presetSel.innerHTML = `<option value="auto">${fill(T.auto, autoTier)}</option>` +
      PRESETS.map((p) => `<option value="${p}">${T.presets[p]}</option>`).join('');
    presetSel.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    scale.value = String(Math.max(50, Math.min(200, pct)));
    scaleOut.textContent = scale.value + '%';
    adaptive.checked = saved.adaptive !== false;
    showFps.checked = !!saved.show_fps;
    for (const [cat, sel] of Object.entries(catSelects)) {
      sel.options[0].textContent = fill(T.fromPreset, T.tiers[presetTier(q.preset, cat)]);
      sel.value = CATEGORIES[cat].includes(saved[cat]) ? saved[cat] : 'preset';
    }
    refreshSummary();
  }

  function refreshSummary() {
    const q = resolve(g(), detected);
    const info = r ? r.graphicsInfo() : null;
    summary.textContent = info ? describeLocal(info.resolved, info) : describeLocal(q, null);
    summary.dataset.preset = q.preset;
    note.hidden = !(info && info.postFailed) && !!r;
    note.textContent = r ? T.postNote : T.noWebgl;
  }

  refresh();
  // Keep the summary live (pixel size / post status) while the panel is open.
  setInterval(() => { if (root.offsetParent) refreshSummary(); }, 1500);
  return { refresh };
}

/** Bring a saved graphics object (including the legacy { tier }) into the current shape. */
export function migrateGraphics(gfx) {
  const g = Object.assign({}, gfx || {});
  if (g.tier !== undefined && g.preset === undefined) {
    g.preset = { low: 'low', medium: 'balanced', high: 'high' }[g.tier] || 'auto';
  }
  delete g.tier;
  if (!g.preset) g.preset = 'auto';
  return g;
}
