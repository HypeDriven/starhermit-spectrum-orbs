// The look of the top bar, rails, playfield chrome and screens: the browser
// build's css/style.css, rewritten class-based in tools/ui-style.css and
// converted once with `starhermit css` into assets/ui-style.json (`npm run
// css`), registered at start with the theme the runtime's own widgets (scroll
// bars, focus rings, selects, sliders, text fields) take. The runtime's high
// contrast option is the old body.high-contrast token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#10131d", panel: "#1a1f2e", "panel-2": "#232a3d", ink: "#e8ecf4", "ink-dim": "#9aa5bb",
  accent: "#6ea8ff", "accent-2": "#7dffa8", danger: "#ff6a5e", line: "#2e3650", "primary-ink": "#06101f",
  topbar: "#10131dd9", strip: "#10131db8", label: "#10131d8c", tutorial: "#1a1f2eeb", drawer: "#1a1f2ee0",
};
/** body.high-contrast. */
const CONTRAST: Tokens = {
  bg: "#000000", panel: "#0a0a0a", "panel-2": "#141414", ink: "#ffffff", "ink-dim": "#d0d0d0",
  accent: "#66b3ff", "accent-2": "#00ff88", line: "#666666",
  topbar: "#000000d9", strip: "#000000b8", label: "#0000008c", tutorial: "#0a0a0aeb", drawer: "#0a0a0ae0",
};

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.1, headingSize: 22.4, padding: 8, spacing: 8, radius: 10,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE.panel!, control: BASE["panel-2"]!, hovered: "#2c3550",
    pressed: "#34405e", field: BASE["panel-2"]!, accent: BASE.accent!, focus: BASE.accent!, outline: BASE.line!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$accent", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#ffffff44", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .overlay: rgba(6, 8, 14, 0.72) behind the panels
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#06080eb8" } } },
    // .screen without .overlay: the menus fill the page, nothing behind them shows
    ".dialog-clear": { background: "#00000000", padding: 0, parts: { backdrop: { background: "#00000000" } } },
  });
  key = "";
  applyTokens(false);
}

let key = "";
/** The base or high-contrast tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current.panel!, control: current["panel-2"]!,
    field: current["panel-2"]!, accent: current.accent!, focus: current.accent!, outline: current.line!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
