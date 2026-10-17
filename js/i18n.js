/* i18n.js — localization.
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; strings.js holds the tables
 * (en-GB, es-ES and fr-CA carry only their differences from en-US, es-419
 * and fr-FR). The locale comes from the game's Language setting through
 * sh-language.js (explicit choice → StarHermit account preference →
 * navigator.languages → en-US); ?lang= forces one for the page load (QA).
 *
 * Static markup in index.html is translated in place: every text node and
 * aria-label/title/placeholder/alt under <body> whose English text is a key,
 * and the innerHTML of elements marked data-i18n-html (rich text). Subtrees
 * marked data-i18n-skip and <kbd> keys are left alone. Code that writes text
 * later uses T() and re-renders on the `so-language` event.
 * Browser global: window.SOI18N (T is also window.SOI18N.T).
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var TABLES = root.SO_STRINGS || {};
  var ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
  var lang = 'en-US';
  var hasOwn = Object.prototype.hasOwnProperty;

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders filled from vars. */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? String(vars[k]) : m; });
    return s;
  }

  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  // ---- static markup -------------------------------------------------------
  var texts = [], attrs = [], htmls = [], scanned = false;
  function skipped(el) {
    for (var n = el; n && n !== document.body; n = n.parentNode) {
      if (n.nodeType === 1 && (n.hasAttribute('data-i18n-skip') || n.hasAttribute('data-i18n-html') || n.tagName === 'KBD' ||
        n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.tagName === 'NOSCRIPT')) return true;
    }
    return false;
  }
  function scan() {
    if (scanned || !document.body) return;
    scanned = true;
    var html = document.body.querySelectorAll('[data-i18n-html]');
    for (var i = 0; i < html.length; i++) htmls.push({ el: html[i], key: norm(html[i].innerHTML), last: null });
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var key = norm(node.nodeValue);
      if (!/[A-Za-z]/.test(key) || skipped(node.parentNode)) continue;
      var m = /^(\s*)[\s\S]*?(\s*)$/.exec(node.nodeValue);
      texts.push({ node: node, key: key, pre: m[1], post: m[2], last: node.nodeValue });
    }
    var els = document.body.querySelectorAll('[' + ATTRS.join('],[') + ']');
    for (var j = 0; j < els.length; j++) {
      if (skipped(els[j]) && !els[j].hasAttribute('data-i18n-html')) continue;
      ATTRS.forEach(function (a) {
        var v = els[j].getAttribute(a);
        if (v && /[A-Za-z]/.test(v)) attrs.push({ el: els[j], attr: a, key: norm(v), last: v });
      });
    }
  }
  /** Re-apply the current language to the static markup (skips text the game has since replaced). */
  function applyStatic() {
    scan();
    texts.forEach(function (t) {
      if (!t.node.parentNode || t.node.nodeValue !== t.last) return;
      t.last = t.node.nodeValue = t.pre + T(t.key) + t.post;
    });
    attrs.forEach(function (a) {
      if (a.el.getAttribute(a.attr) !== a.last) return;
      a.last = T(a.key);
      a.el.setAttribute(a.attr, a.last);
    });
    htmls.forEach(function (h) {
      if (h.last !== null && h.el.innerHTML !== h.last) return;
      var next = T(h.key);
      if (h.last === null && next === h.key) { h.last = h.el.innerHTML; return; }
      h.el.innerHTML = next;
      h.last = h.el.innerHTML;
    });
  }

  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    document.documentElement.lang = lang;
    if (document.body) applyStatic();
    document.dispatchEvent(new CustomEvent('so-language', { detail: { lang: lang } }));
  }

  var forced = null;
  try { forced = new URLSearchParams(root.location.search).get('lang'); } catch (e) { /* opaque origin */ }
  var SL = root.StarHermitLanguage;
  var forcedLocale = forced && SL ? SL.match(forced, LOCALES) : null;
  var language = SL ? SL.create({
    game: 'spectrum-orbs', supported: LOCALES, panel: !forcedLocale,
    apply: function (locale) { setLocale(forcedLocale || locale); }
  }) : null;
  if (!language) setLocale('en-US');
  if (!document.body) document.addEventListener('DOMContentLoaded', applyStatic);

  root.SOI18N = {
    T: T,
    get lang() { return lang; },
    locales: LOCALES,
    language: language,
    tables: TABLES,
    applyStatic: applyStatic
  };
})(typeof self !== 'undefined' ? self : this);
