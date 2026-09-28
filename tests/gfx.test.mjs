// Unit tests for the pure graphics quality model (js/gfx.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, withPreset, describe, CATEGORIES, PRESETS } from '../js/gfx.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('AMD Radeon RX 6800'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('detectPreset caps touch/mobile devices at balanced', () => {
  assert.equal(detectPreset('Apple M1', true), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 740', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
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
