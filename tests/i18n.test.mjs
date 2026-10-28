// Spectrum Orbs — localization coverage: every English key the native client
// (native/*.ts) and the content show to players is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders
// survive, no table row is unused, js/lang.js falls back by locale, and the
// account strings (js/sh-strings.js) cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, audit, LOCALES } from './i18n-common.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const require = createRequire(import.meta.url);

function contentKeys() {
  const C = require('../js/content.js');
  const keys = [];
  C.palette('default').forEach((c) => keys.push(c.label));
  Object.values(C.THEMES).forEach((t) => keys.push(t.name));
  C.JOURNEY.forEach((l) => l.name && keys.push(l.name));
  C.CHALLENGES.forEach((c) => keys.push(c.name, c.blurb));
  Object.values(C.PRACTICE).forEach((d) => keys.push(d.name));
  C.TUTORIAL.forEach((t) => keys.push(t.title, t.body, t.hint));
  C.ACHIEVEMENTS.forEach((a) => keys.push(a.name, a.desc));
  return keys.filter(Boolean);
}
export function usedKeys() {
  const keys = new Set(contentKeys());
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    const src = read(`native/${f}`);
    codeKeys(src).forEach((k) => keys.add(k));
  }
  // English keys kept in data and translated where shown (medal names, the results' terminal and medal titles)
  ['gold', 'silver', 'bronze', 'clear', 'Round over.', 'Next'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact; no unused rows', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'SO_STRINGS'), usedKeys()), []);
});

test('js/lang.js: locale fallbacks and placeholders', () => {
  const sandbox = {}; sandbox.globalThis = sandbox;
  const vm = require('node:vm');
  vm.runInNewContext(read('js/strings.js'), sandbox);
  vm.runInNewContext(read('js/lang.js'), sandbox);
  const I = sandbox.SOI18N;
  I.setLocale('de-DE');
  assert.equal(I.T('Undo & hints'), 'Rückgängig & Tipps');
  I.setLocale('fr-CA');
  assert.equal(I.T('Score'), 'Pointage');
  assert.equal(I.T('Tube {n}', { n: 3 }), 'Tube 3');
  I.setLocale('it-IT');
  assert.equal(I.T('Daily — {date}', { date: '2026-10-17' }), 'Sfida del giorno — 2026-10-17');
  I.setLocale('en-GB');
  assert.equal(I.T('Color palette'), 'Colour palette');
  I.setLocale('xx');
  assert.equal(I.getLang(), 'en-US');
});

test('account strings cover all nine locales', () => {
  const S = require('../js/sh-strings.js');
  for (const l of LOCALES) for (const k of ['signIn', 'invite', 'copied', 'copyFailed', 'signedOut', 'lbPosting', 'lbRank', 'lbPosted', 'lbNotPosted']) assert.ok(S[l] && S[l][k], `${l} ${k}`);
});
