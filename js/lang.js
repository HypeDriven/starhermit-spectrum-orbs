/* Spectrum Orbs — the string lookup over js/strings.js (SO_STRINGS), without
 * the browser build's DOM re-labelling (js/i18n.js): English source strings
 * are the keys; en-GB, es-ES and fr-CA fall back to en-US, es-419 and fr-FR.
 * The locale is set by native/i18n.ts from the runtime's interface language.
 * Classic script: globalThis.SOI18N (loadClassic) / Node (require).
 */
(function (root) {
  'use strict';
  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var hasOwn = Object.prototype.hasOwnProperty;
  var lang = 'en-US';
  function tables() { return root.SO_STRINGS || {}; }
  function lookup(key) {
    var all = tables();
    for (var l = lang; l; l = PARENT[l]) {
      var t = all[l];
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
  function setLocale(next) { lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US'; }
  var api = { LOCALES: LOCALES, T: T, setLocale: setLocale, getLang: function () { return lang; } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SOI18N = api;
})(globalThis);
