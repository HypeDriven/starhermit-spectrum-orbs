/* ui-scale.js — large-screen UI scale for browser games.
 * Canonical copy lives in tools/ui-scale.js; each game ships a copy (same as
 * browser-guard.js). Do not edit a game's copy by hand — update the canonical
 * file and re-copy.
 *
 * Sets `--ui-scale` (a unitless number ≥ 1) on <html> and keeps it current on
 * resize. At or below a 1600×1000 CSS-pixel viewport it is exactly 1, so
 * desktop, tablet and phone layouts are untouched; above that it grows with
 * the smaller of the width/height ratios (2560×1440 → 1.44, 3840×2160 → 2.16),
 * capped at 2.5.
 *
 * Use it from CSS on UI containers (menus, panels, HUD, toolbars):
 *   .menu { zoom: var(--ui-scale, 1); }
 * Inside a zoomed element vw/vh/dvh units are multiplied by the zoom, so
 * divide them: max-height: calc(90dvh / var(--ui-scale, 1)).
 * From JS (canvas-drawn HUD text, board sizing): UIScale.value, and
 * UIScale.on(fn) to hear changes.
 */
(function (root) {
  'use strict';
  var cfg = { refW: 1600, refH: 1000, max: 2.5 };
  var fns = [];
  var api = {
    value: 1,
    configure: function (o) {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(cfg, k)) cfg[k] = +o[k];
      apply();
      return api;
    },
    compute: function (w, h) {
      var s = Math.min(w / cfg.refW, h / cfg.refH);
      s = Math.max(1, Math.min(cfg.max, s));
      return Math.round(s * 100) / 100;
    },
    on: function (fn) { fns.push(fn); return function () { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); }; },
  };
  function apply() {
    if (typeof document === 'undefined') return;
    var s = api.compute(root.innerWidth || 0, root.innerHeight || 0);
    var el = document.documentElement;
    el.style.setProperty('--ui-scale', String(s));
    el.classList.toggle('ui-scaled', s > 1);
    if (s === api.value) return;
    api.value = s;
    for (var i = 0; i < fns.length; i++) { try { fns[i](s); } catch (e) { /* listener errors never break scaling */ } }
  }
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.UIScale = api;
  apply();
  root.addEventListener('resize', apply);
})(typeof window !== 'undefined' ? window : globalThis);
