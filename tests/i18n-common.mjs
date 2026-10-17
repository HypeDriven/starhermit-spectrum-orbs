// Localization coverage helpers (shared shape across this game's tests).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
export const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', larr: '←', rarr: '→' };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');

/** Load the translation tables from a classic-script strings file. */
export function loadTables(root, file, globalName) {
  const sandbox = { self: {} };
  vm.runInNewContext(readFileSync(new URL(file, root), 'utf8'), sandbox);
  return sandbox.self[globalName];
}

/** English keys used in code: T('…'), N('…') (deferred), and T(c ? '…' : '…'). */
export function codeKeys(src, extraFns = [], baseFns = ['T', 'N']) {
  const keys = new Set();
  const fns = [...baseFns, ...extraFns].join('|');
  const lit = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${fns})\(\s*(?:${lit})`, 'g'))) keys.add(unq(m[1] ?? m[2]));
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${fns})\((?:[^()'"?]|'[^'\n]*'|\([^()]*\))*\?\s*(?:${lit})\s*:\s*(?:${lit})`, 'g'))) {
    keys.add(unq(m[1] ?? m[2])); keys.add(unq(m[3] ?? m[4]));
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/** English keys in the static <body> markup, as js/i18n.js collects them at runtime. */
export function htmlKeys(html) {
  const keys = new Set();
  let body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/g, '');
  // Rich-text elements: the whole innerHTML is the key.
  body = body.replace(/<(\w+)([^>]*\bdata-i18n-html\b[^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    keys.add(norm(inner));
    return `<${tag}${attrs}></${tag}>`;
  });
  // Skipped subtrees: drop the element with its attributes and contents (same-tag nesting counted).
  body = dropSkipped(body);
  body = body.replace(/<kbd\b[^>]*>[\s\S]*?<\/kbd>/g, '<kbd></kbd>');
  for (const m of body.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) {
    const v = norm(decode(m[2]));
    if (/[A-Za-z]/.test(v)) keys.add(v);
  }
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const v = norm(decode(m[1]));
    if (/[A-Za-z]/.test(v)) keys.add(v);
  }
  return [...keys];
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'col', 'embed', 'wbr']);
function dropSkipped(html) {
  for (;;) {
    const m = /<(\w+)[^>]*\bdata-i18n-skip\b[^>]*>/.exec(html);
    if (!m) return html;
    const tag = m[1].toLowerCase();
    let end = m.index + m[0].length;
    if (!VOID.has(tag)) {
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      re.lastIndex = end;
      let depth = 1, t;
      while (depth && (t = re.exec(html))) depth += t[1] ? -1 : 1;
      end = t ? re.lastIndex : html.length;
    }
    html = html.slice(0, m.index) + html.slice(end);
  }
}

/** Problems: missing translations in full locales, placeholder drift, stale or unknown keys. */
export function audit(tables, used) {
  const usedSet = new Set(used);
  const problems = [];
  for (const loc of FULL) {
    const t = tables[loc] || {};
    for (const k of usedSet) if (!Object.prototype.hasOwnProperty.call(t, k)) problems.push(`${loc} missing: ${k}`);
  }
  for (const [loc, table] of Object.entries(tables)) {
    if (!LOCALES.includes(loc)) problems.push(`unknown locale ${loc}`);
    for (const [k, v] of Object.entries(table)) {
      if (!usedSet.has(k)) { problems.push(`${loc} unused: ${k}`); continue; }
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      if (want !== got) problems.push(`${loc} placeholders: ${k}`);
      const tagsK = (k.match(/<\/?\w+/g) || []).sort().join();
      const tagsV = (String(v).match(/<\/?\w+/g) || []).sort().join();
      if (tagsK !== tagsV) problems.push(`${loc} markup: ${k}`);
    }
  }
  for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!tables[loc]) problems.push(`no ${loc} table`);
  return problems;
}

/** Build a sandbox with sh-language.js + strings + i18n loaded; returns the game's I18N global. */
export function bootI18n(root, { strings, i18n, global, languages = ['de-DE'] }) {
  const events = [];
  const doc = {
    documentElement: { lang: 'en' }, body: null,
    dispatchEvent: (e) => events.push(e.detail.lang),
    addEventListener() {},
  };
  const sandbox = {
    document: doc, location: { search: '' },
    navigator: { languages, language: languages[0] },
    localStorage: { getItem: () => null, setItem: () => {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o.detail; } },
    URLSearchParams,
  };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  const read = (p) => readFileSync(new URL(p, root), 'utf8');
  vm.runInContext(read('sh-language.js'), sandbox);
  vm.runInContext(read(strings), sandbox);
  vm.runInContext(read(i18n), sandbox);
  return { I18N: sandbox[global], events, doc };
}
