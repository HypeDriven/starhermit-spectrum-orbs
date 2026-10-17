/* sh-language.js — canonical game-language preference for StarHermit games.
 * Canonical copy lives in tools/sh-language.js; each game ships a copy. Do not
 * edit a game's copy by hand — update the canonical file and re-copy.
 *
 * Follows the wiki's "localize your game" tutorial (wiki rev df2cd38):
 *   1. an explicit choice from this game's settings (`ui.language`) wins;
 *   2. for `auto`, the player's StarHermit preferredLanguage (GET /api/v1/me/language);
 *   3. then the device's language preferences (also for unsigned play);
 *   4. then the game's fallback (US English).
 * The choice (`auto` or a locale) is stored per game and player in localStorage
 * and, when signed in, in the per-player settings key `ui.language` as
 * { choice }. A failed read never overwrites account data, and the platform
 * preference is never written by a game.
 *
 * Usage:
 *   const lang = StarHermitLanguage.create({
 *     game: 'hollow-feast',                 // localStorage namespace
 *     supported: ['en-US','en-GB','es-419','es-ES','de-DE','fr-FR','fr-CA','pt-BR','it-IT'],
 *     legacyKey: 'hf.lang',                 // optional: migrate an older stored choice
 *     apply: locale => setLocale(locale),   // re-render; called on every change
 *   });
 *   lang.bindSelect(selectEl, statusEl);    // optional: fills Automatic + native names
 *   lang.setChoice('fr-CA' | 'auto');
 */
(function (root) {
  'use strict';
  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var NATIVE = {
    'en-US': 'English (US)', 'en-GB': 'English (UK)', 'es-419': 'Español (Latinoamérica)',
    'es-ES': 'Español (España)', 'de-DE': 'Deutsch', 'fr-FR': 'Français (France)',
    'fr-CA': 'Français (Canada)', 'pt-BR': 'Português (Brasil)', 'it-IT': 'Italiano'
  };
  // [Automatic (account or device language) — {lang}, Saved to account, Saved on this device,
  //  Account sync unavailable, Saving…, Language, Game language]
  var TEXT = {
    en: ['Automatic — {lang}', 'Saved to account', 'Saved on this device', 'Account sync unavailable', 'Saving…', 'Language', 'Game language'],
    es: ['Automático — {lang}', 'Guardado en la cuenta', 'Guardado en este dispositivo', 'Sincronización de la cuenta no disponible', 'Guardando…', 'Idioma', 'Idioma del juego'],
    de: ['Automatisch — {lang}', 'Im Konto gespeichert', 'Auf diesem Gerät gespeichert', 'Kontosynchronisierung nicht verfügbar', 'Wird gespeichert …', 'Sprache', 'Spielsprache'],
    fr: ['Automatique — {lang}', 'Enregistré dans le compte', 'Enregistré sur cet appareil', 'Synchronisation du compte indisponible', 'Enregistrement…', 'Langue', 'Langue du jeu'],
    pt: ['Automático — {lang}', 'Salvo na conta', 'Salvo neste dispositivo', 'Sincronização da conta indisponível', 'Salvando…', 'Idioma', 'Idioma do jogo'],
    it: ['Automatico — {lang}', 'Salvato nell’account', 'Salvato su questo dispositivo', 'Sincronizzazione dell’account non disponibile', 'Salvataggio…', 'Lingua', 'Lingua del gioco']
  };
  var BASE_DEFAULT = { en: 'en-US', es: 'es-ES', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };
  var EN_GB = ['gb', 'uk', 'ie', 'au', 'nz', 'za', 'in', 'sg', 'hk', 'mt'];
  var ES_LATAM = ['419', 'mx', 'ar', 'co', 'cl', 'pe', 've', 'ec', 'gt', 'cu', 'bo', 'do', 'hn', 'py', 'sv', 'ni', 'cr', 'pa', 'uy', 'pr', 'us'];
  var KEY = 'ui.language';

  function canon(tag) { return typeof tag === 'string' ? tag.trim().replace(/_/g, '-').toLowerCase() : ''; }

  /** The supported locale that best serves a language tag, or null. */
  function match(tag, supported) {
    supported = supported || LOCALES;
    var t = canon(tag); if (!t || t.length > 64) return null;
    var byLower = {}; supported.forEach(function (s) { byLower[s.toLowerCase()] = s; });
    if (byLower[t]) return byLower[t];
    var parts = t.split('-'), base = parts[0];
    var region = parts.slice(1).filter(function (p) { return /^([a-z]{2}|\d{3})$/.test(p); })[0] || '';
    function first(cands) { for (var i = 0; i < cands.length; i++) if (byLower[cands[i].toLowerCase()]) return byLower[cands[i].toLowerCase()]; return null; }
    var regional = null;
    if (base === 'en' && EN_GB.indexOf(region) >= 0) regional = first(['en-GB']);
    else if (base === 'es' && ES_LATAM.indexOf(region) >= 0) regional = first(['es-419']);
    else if (base === 'fr' && region === 'ca') regional = first(['fr-CA']);
    else if (base === 'pt') regional = first(['pt-' + (region || 'br').toUpperCase()]);
    if (regional) return regional;
    if (BASE_DEFAULT[base] && byLower[BASE_DEFAULT[base].toLowerCase()]) return BASE_DEFAULT[base];
    for (var i = 0; i < supported.length; i++) if (supported[i].toLowerCase().split('-')[0] === base) return supported[i];
    return null;
  }

  /** Resolve { choice, platform, device[], supported, fallback } → { locale, source }. */
  function resolve(o) {
    var supported = o.supported || LOCALES, fallback = o.fallback || supported[0];
    if (o.choice && o.choice !== 'auto') { var c = match(o.choice, supported); if (c) return { locale: c, source: 'choice' }; }
    if (o.platform) { var p = match(o.platform, supported); if (p) return { locale: p, source: 'account' }; }
    var device = o.device || [];
    for (var i = 0; i < device.length; i++) { var d = match(device[i], supported); if (d) return { locale: d, source: 'device' }; }
    return { locale: fallback, source: 'fallback' };
  }

  function validChoice(choice, supported) {
    if (choice === 'auto') return 'auto';
    var m = match(choice, supported);
    return m && canon(m) === canon(choice) ? m : null;
  }

  function text(locale) { return TEXT[String(locale || 'en').split('-')[0]] || TEXT.en; }

  function create(opts) {
    opts = opts || {};
    var supported = (opts.supported || LOCALES).slice();
    var fallback = opts.fallback || supported[0];
    var game = opts.game || 'game';
    var win = opts.window || root;
    var listeners = [];
    var nav = win.navigator || {};
    var device = (nav.languages && nav.languages.length ? Array.prototype.slice.call(nav.languages) : [nav.language]).filter(Boolean);
    var sdk = null, user = null, generation = 0;
    var platform = null, accountRead = false, writeChain = Promise.resolve(), pending = null;
    var status = 'device'; // 'account' | 'device' | 'unavailable' | 'saving'
    var choice = 'auto', current = null;

    function storageKey() { return game + '.language.' + (user || 'guest'); }
    function readLocal() {
      try {
        var raw = win.localStorage.getItem(storageKey());
        if (raw == null && !user && opts.legacyKey) raw = win.localStorage.getItem(opts.legacyKey);
        return raw == null ? null : validChoice(raw, supported);
      } catch (e) { return null; }
    }
    function writeLocal(value) { try { win.localStorage.setItem(storageKey(), value); } catch (e) { /* storage unavailable */ } }

    function compute() {
      var r = resolve({ choice: choice, platform: platform, device: device, supported: supported, fallback: fallback });
      var changed = !current || r.locale !== current.locale;
      current = r;
      if (changed && typeof opts.apply === 'function') {
        try { opts.apply(r.locale, r); } catch (e) { if (win.console) win.console.error(e); }
      }
      emit();
      return r;
    }
    function emit() { listeners.slice().forEach(function (fn) { try { fn(api.state()); } catch (e) { /* listener */ } }); }

    function settingsPath() { return '/api/v1/games/' + encodeURIComponent(sdk.slug) + '/settings'; }

    function loadAccount() {
      var g = ++generation;
      accountRead = false; platform = null;
      if (!sdk || !sdk.signedIn) { status = 'device'; return Promise.resolve(compute()); }
      status = 'saving'; emit();
      var lang = sdk.api('/api/v1/me/language').then(function (p) {
        if (g === generation && p && typeof p.preferredLanguage === 'string') platform = p.preferredLanguage;
      }, function () { /* keep device fallback */ });
      var settings = sdk.api(settingsPath()).then(function (res) {
        if (g !== generation) return;
        if (!res || !res.settings || typeof res.settings !== 'object' || Array.isArray(res.settings)) throw new Error('settings unavailable');
        accountRead = true;
        var stored = res.settings[KEY];
        var c = stored && validChoice(stored.choice, supported);
        if (pending) return save(pending);       // a choice made before the read finished wins
        if (c) { choice = c; writeLocal(c); }
        status = 'account';
      }).catch(function () { if (g === generation) status = 'unavailable'; });
      return Promise.all([lang, settings]).then(function () { if (g === generation) return compute(); });
    }

    function save(value) {
      var g = generation;
      pending = value;
      if (!sdk || !sdk.signedIn) { status = 'device'; pending = null; emit(); return Promise.resolve(false); }
      if (!accountRead) { status = 'unavailable'; emit(); return Promise.resolve(false); }
      status = 'saving'; emit();
      writeChain = writeChain.catch(function () {}).then(function () {
        if (g !== generation || pending !== value) return false;
        return sdk.api(settingsPath() + '/' + encodeURIComponent(KEY), { method: 'PUT', body: { value: { choice: value } } })
          .then(function (ok) {
            if (g !== generation || pending !== value) return false;
            pending = null; status = ok ? 'account' : 'unavailable'; emit(); return !!ok;
          }, function () {
            if (g === generation && pending === value) { status = 'unavailable'; emit(); }
            return false;
          });
      });
      return writeChain;
    }

    function attach(s) {
      if (!s || s === sdk) return;
      sdk = s;
      var onAuth = function () {
        var next = sdk.signedIn ? sdk.userId : null;
        if (next === user && (accountRead || !next)) return;
        user = next; pending = null;
        choice = readLocal() || 'auto';
        loadAccount();
      };
      if (typeof sdk.on === 'function') sdk.on('auth', onAuth);
      onAuth();
    }

    var api = {
      supported: supported,
      /** 'auto' or an explicit supported locale. */
      choice: function () { return choice; },
      /** The effective locale. */
      locale: function () { return (current || compute()).locale; },
      state: function () {
        return { choice: choice, locale: api.locale(), source: current ? current.source : 'fallback', status: status, platform: platform };
      },
      /** Apply immediately; persist locally and, when signed in, to ui.language. */
      setChoice: function (value) {
        var v = validChoice(value, supported);
        if (!v) return Promise.resolve(false);
        choice = v; writeLocal(v); compute();
        return save(v);
      },
      /** Retry account sync after a failure (rereads before writing). */
      retry: function () { return loadAccount(); },
      /** Re-read the account preference (e.g. on return from account settings). */
      refresh: function () { return loadAccount(); },
      on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
      /** Localized UI strings for the effective locale. */
      text: function () { return text(api.locale()); },
      label: function (locale) { return NATIVE[locale] || locale; },
      autoLabel: function () { return text(api.locale())[0].replace('{lang}', api.label(api.locale())); },
      statusText: function () {
        var t = text(api.locale());
        return status === 'account' ? t[1] : status === 'saving' ? t[4] : status === 'unavailable' ? t[3] : t[2];
      },
      /**
       * Populate a <select> with Automatic + supported locales (native names) and
       * keep it, plus an optional status element, in sync. Returns an unbind fn.
       */
      bindSelect: function (select, statusEl) {
        var doc = select.ownerDocument;
        function fill() {
          var want = ['auto'].concat(supported);
          var have = Array.prototype.map.call(select.options, function (o) { return o.value; });
          if (have.join('|') !== want.join('|')) {
            select.textContent = '';
            want.forEach(function (v) {
              var o = doc.createElement('option'); o.value = v;
              if (v !== 'auto') { o.lang = v; o.textContent = NATIVE[v] || v; }
              select.appendChild(o);
            });
          }
          select.options[0].textContent = api.autoLabel();
          select.value = choice;
          if (statusEl) statusEl.textContent = api.statusText();
        }
        function onChange() { api.setChoice(select.value); }
        select.addEventListener('change', onChange);
        var off = api.on(fill); fill();
        return function () { off(); select.removeEventListener('change', onChange); };
      }
    };

    choice = readLocal() || 'auto';
    compute();
    // The shared options panel (game-options.js) shows a Language section for the
    // registered instance; pass panel: false when the game binds its own selector.
    api.panel = opts.panel !== false;
    if (opts.register !== false && win === root && typeof win.document === 'object') root.GameLanguage = api;
    if (opts.starhermit !== false) {
      if (win.StarHermit) attach(win.StarHermit);
      else if (win.addEventListener) win.addEventListener('load', function () { attach(win.StarHermit); }, { once: true });
    }
    api.attach = attach;
    return api;
  }

  var exported = { LOCALES: LOCALES, NATIVE: NATIVE, match: match, resolve: resolve, validChoice: validChoice, create: create };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.StarHermitLanguage = exported;
})(typeof window !== 'undefined' ? window : globalThis);
