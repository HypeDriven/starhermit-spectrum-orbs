// Spectrum Orbs — localization coverage: every English key the native client
// (native/*.ts) and the content show to players is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders
// survive and no table row is unused. The account strings are the engine's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { codeKeys, audit } from './i18n-common.mjs';

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
  const { 'en-US': _identity, ...tables } = JSON.parse(read('assets/strings.json'));
  assert.deepEqual(audit(tables, usedKeys()), []);
});
