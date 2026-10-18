/**
 * gfx.js — graphics quality model: presets, per-category overrides, StarHermit
 * hardware-level detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js), so the settings panel,
 * the renderer and the unit tests agree on what a setting means.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

/** Category → allowed tiers, cheapest first. */
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // image-based lighting on orbs, glass and metal
  particles: ['off', 'low', 'high'], // move / completion bursts
  background: ['static', 'animated'], // spinning mobiles, drifting dust, light shimmer
  detail: ['plain', 'detailed'],    // gallery walls, light strips, floor texture, mobiles
};

/** Each preset is a row of tiers, a pixel-ratio cap and a render scale. */
const TABLE = {
  low: { cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'off', background: 'static', detail: 'plain' },
  balanced: { cap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'low', background: 'animated', detail: 'detailed' },
  high: { cap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { cap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };
export const PARTICLE_BUDGET = { off: 0, low: 600, high: 2000 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Tubes, orbs, glyphs,
 * pick areas and rules are identical on every preset — only visuals change.
 *   material  orb, pedestal, glass and gallery shading: lambert (Low) / standard (Balanced) / physical —
 *             clear-coated orbs and pedestals, glass with IOR (High, Ultra; Gallery detail detailed)
 *   orbSeg    orb sphere width segments (height: ¾)
 *   floorTex  terrazzo floor texture size in px (Gallery detail detailed)
 *   panels    back-wall panels at Gallery detail detailed (odd: one sits behind the board)
 *   mobiles   kinetic sculpture mobiles at Gallery detail detailed
 *   sparks    burst particle cap at Particles high (low: 30 %), scaled with the level
 *   motes     dust motes (Background animated), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', orbSeg: 16, floorTex: 128, panels: 7, mobiles: 1, sparks: 600, motes: 80, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', orbSeg: 24, floorTex: 256, panels: 9, mobiles: 2, sparks: 1000, motes: 110, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', orbSeg: 32, floorTex: 256, panels: 11, mobiles: 3, sparks: 2000, motes: 140, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', orbSeg: 48, floorTex: 512, panels: 13, mobiles: 5, sparks: 2500, motes: 220, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 5000;
export const MOTE_MAX = 440;

/** A preset's concrete budget for a hardware level (effect counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/** Live burst-particle cap for resolved settings (Particles off: 0, low: 30 % of the budget). */
export function sparkCap(r) {
  return r.particles === 'high' ? r.budget.sparks : r.particles === 'low' ? Math.round(r.budget.sparks * 0.3) : 0;
}

/**
 * Resolve saved settings into concrete tiers.
 * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    cap: row.cap,
    scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2),
  };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override. */
export function withPreset(saved, preset) {
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  for (const k of ['render_scale', 'adaptive', 'show_fps']) if (saved && k in saved) out[k] = saved[k];
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
