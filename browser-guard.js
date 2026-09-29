// Suppresses browser UI that interferes with play: the right-click / long-press
// context menu, copy / cut / paste, and page text selection. Editable fields
// (inputs, textareas, contenteditable) keep their normal behaviour.
(function () {
  var editable = function (el) {
    if (el && el.nodeType !== 1) el = el.parentElement;
    return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
  };
  var block = function (e) { if (!editable(e.target)) e.preventDefault(); };
  ['contextmenu', 'copy', 'cut', 'paste', 'selectstart'].forEach(function (type) {
    window.addEventListener(type, block, true);
  });
  document.documentElement.style.setProperty('-webkit-touch-callout', 'none');
})();
