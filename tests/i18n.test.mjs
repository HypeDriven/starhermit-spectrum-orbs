// Spectrum Orbs — localization coverage: every English key the markup, code
// and content show to players is translated in every locale (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders survive, the language
// follows sh-language.js and switches live, and the Graphics / account
// strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function contentKeys() {
  const C = createRequire(import.meta.url)('../js/content.js');
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
  const keys = new Set([...htmlKeys(read('index.html')), ...contentKeys()]);
  for (const f of ['js/ui.js', 'js/main.js', 'js/platform.js']) {
    const src = read(f);
    codeKeys(src).forEach((k) => keys.add(k));
    // English keys kept in data tables and translated where shown.
    for (const re of [/\blabel: '((?:[^'\\]|\\.)*)'/g, /\bnote: '((?:[^'\\]|\\.)*)'/g, /\bT\([^;\n]*?\|\| '((?:[^'\\]|\\.)*)'/g]) for (const m of src.matchAll(re)) keys.add(m[1]);
    for (const name of ['INVALID_TEXT', 'ACTION_NAMES', 'MEDAL_TITLE', 'TERMINAL_TEXT']) {
      const block = src.match(new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\};'));
      if (block) for (const m of block[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
    }
    for (const m of src.matchAll(/T\(\{([^}]*)\}\[/g)) for (const v of m[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(v[1]);
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'SO_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'SOI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Undo & hints'), 'Rückgängig & Tipps');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Tube {n}', { n: 3 }), 'Tube 3');
  I18N.language.setChoice('it-IT');
  assert.equal(I18N.T('Daily — {date}', { date: '2026-10-17' }), 'Sfida del giorno — 2026-10-17');
});

test('Graphics panel and account strings cover all nine locales and follow the game language', async () => {
  const gfx = read('js/gfx-panel.js');
  for (const l of LOCALES) assert.ok(gfx.includes(`'${l}'`), `gfx-panel ${l}`);
  assert.match(gfx, /window\.SOI18N && window\.SOI18N\.lang/);
  assert.match(gfx, /addEventListener\('so-language'/);
  const sh = read('js/sh-strings.js');
  for (const l of LOCALES) assert.ok(sh.includes(`'${l}'`), `sh-strings ${l}`);
  assert.match(read('js/main.js'), /shStrings\(gameLang\(\)\)/);
});

test('index.html loads sh-language.js, strings.js and i18n.js before the game scripts', () => {
  const html = read('index.html');
  const at = (s) => html.indexOf(`src="${s}"`);
  assert.ok(at('sh-language.js') > 0 && at('sh-language.js') < at('js/i18n.js') && at('js/strings.js') < at('js/i18n.js') && at('js/i18n.js') < at('js/ui.js'));
});
