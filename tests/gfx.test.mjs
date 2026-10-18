// Unit tests for the pure graphics quality model (js/gfx.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const {
  detectPreset, detectLevel, presetForLevel, budgetFor, sparkCap, resolve, presetTier, withPreset, describe,
  CATEGORIES, PRESETS, LEVELS, BUDGETS, SPARK_MAX, MOTE_MAX,
} = await import('../js/gfx.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M1', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'orbSeg', 'floorTex', 'panels', 'mobiles', 'sparks', 'motes', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  for (const p of PRESETS) assert.equal(BUDGETS[p].panels % 2, 1, `${p}: a panel sits behind the board`);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).sparks > budgetFor('balanced', 4).sparks, 'counts scale up within the preset');
  const top = budgetFor('ultra', 20);
  assert.ok(top.sparks <= SPARK_MAX && top.motes <= MOTE_MAX);
  assert.equal(sparkCap(resolve({ preset: 'high' }, 'low', 10)), 2000);
  assert.equal(sparkCap(resolve({ preset: 'balanced' }, 'low', 4)), 300, 'Balanced: Particles low = 30 %');
  assert.equal(sparkCap(resolve({ preset: 'low' }, 'low', 0)), 0, 'Low: Particles off');
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('graphics summary level label in every locale', async () => {
  const { LOCALES, strings } = await import('../js/gfx-panel.js');
  for (const loc of LOCALES) assert.match(strings(loc).level.replace('{n}', 7), /7$/, loc);
});

test('resolve: auto follows the detected preset, explicit preset wins', () => {
  const a = resolve({ preset: 'auto' }, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'Low renders without post-processing');
  assert.equal(a.shadows, 'off');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
  assert.equal(resolve({}, undefined).preset, 'balanced');
});

test('resolve: per-category overrides apply, invalid values fall back to the preset', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'nonsense', detail: 'detailed' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.post, true, 'an override that needs post enables the chain');
  assert.equal(r.shadows, 'off');
  assert.equal(r.detail, 'detailed');
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').scale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  assert.equal(resolve({ preset: 'high' }, 'low').adaptive, true);
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }, 'low').showFps, true);
});

test('choosing a preset clears overrides but keeps scale / adaptive / fps', () => {
  const saved = { preset: 'high', bloom: 'off', shadows: 'high', render_scale: 1.5, adaptive: false, show_fps: true };
  const next = withPreset(saved, 'low');
  assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(resolve(next, 'high').bloom, presetTier('low', 'bloom'));
  assert.equal(withPreset({}, 'bogus').preset, 'auto');
});

test('describe summarises cost', () => {
  const s = describe(resolve({ preset: 'high' }, 'low'), [800, 600]);
  assert.match(s, /shadows/);
  assert.match(s, /bloom/);
  assert.match(s, /800×600 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows/);
});

test('Graphics panel strings exist in every supported locale', async () => {
  const { LOCALES, strings, pickLocale, migrateGraphics } = await import('../js/gfx-panel.js');
  for (const need of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) assert.ok(LOCALES.includes(need), need);
  const en = strings('en-US');
  for (const loc of LOCALES) {
    const t = strings(loc);
    for (const k of Object.keys(en)) assert.ok(t[k], `${loc}.${k}`);
    for (const c of Object.keys(CATEGORIES)) assert.ok(t.cats[c], `${loc}.cats.${c}`);
    for (const tiers of Object.values(CATEGORIES)) for (const tr of tiers) assert.ok(t.tiers[tr], `${loc}.tiers.${tr}`);
    for (const p of PRESETS) assert.ok(t.presets[p], `${loc}.presets.${p}`);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-ca'), 'fr-CA');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  assert.deepEqual(migrateGraphics({ tier: 'medium' }), { preset: 'balanced' });
  assert.deepEqual(migrateGraphics(undefined), { preset: 'auto' });
});
