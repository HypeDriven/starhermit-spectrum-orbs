// Game-owned language fonts. Browser and native builds use the same packaged faces.
import { files, strings, type FontWeight } from "starhermit:engine";
import { FontFace, fonts } from "starhermit:canvas";
import type { TextOptions as DrawOptions } from "starhermit:draw";
import * as ui from "starhermit:ui";

interface FontManifest { locales: Record<string, string>; faces: Record<string, string> }
// Only locales whose complete body tables are active are present in this file.
strings.load("assets/localization/common.json");
const manifest = files.readJson("assets/localization/fonts.json") as unknown as FontManifest;
const loaded = new Set<string>();
const failed = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
const registeredStyles: Record<string, ui.Style> = {};
const fontListeners = new Set<() => void>();
let defaultFont: { family?: string; weight?: FontWeight } | null = null;

const RTL_LANGUAGES = new Set(["ar", "arc", "ary", "arq", "aeb", "azb", "bal", "bqi", "ckb", "dv", "fa", "glk", "haz",
  "he", "iw", "ji", "khw", "ks", "lrc", "mzn", "nqo", "pnb", "prs", "ps", "sd", "sdh",
  "skr", "syr", "ug", "ur", "yi"]);
const RTL_SCRIPTS = new Set(["adlm", "arab", "aran", "armi", "avst", "chrs", "cprt", "elym",
  "hatr", "hebr", "hung", "khar", "lydi", "mand", "mani", "mend", "merc", "mero", "narb",
  "nbat", "nkoo", "orkh", "ougr", "palm", "phli", "phlp", "phnx", "prti", "rohg", "samr",
  "sarb", "sogd", "sogo", "syrc", "thaa", "yezi"]);

/** The runtime's omitted/Auto direction is LTR, so pass the locale's direction explicitly. */
export function applyLocaleDirection(locale = strings.locale): void {
  const parts = locale.toLowerCase().split("-");
  const script = parts.slice(1).find((part) => /^[a-z]{4}$/.test(part));
  const rtl = script ? RTL_SCRIPTS.has(script) : RTL_LANGUAGES.has(parts[0] || "en");
  ui.setLanguage(locale, rtl ? "rtl" : "ltr");
}
function family(locale = strings.locale): string | null {
  return manifest.locales[locale] || null;
}

export function prepareLocaleFont(locale: string): Promise<boolean> {
  const name = family(locale);
  if (!name || loaded.has(name)) return Promise.resolve(true);
  const pending = loading.get(name);
  if (pending) return pending;
  const source = manifest.faces[name];
  if (!source) return Promise.resolve(false);
  const face = new FontFace(name, source, { weight: "400" });
  // In browsers load() fetches bytes first; add() tries to read them now.
  const request = face.load().then(() => {
    fonts.add(face);
    loaded.add(name);
    refresh();
    return true;
  }).catch((error: unknown) => { failed.add(name); console.error("Language font could not be loaded", error); return false; });
  loading.set(name, request);
  return request;
}

export function localeFontPending(locale = strings.locale): boolean {
  const name = family(locale);
  return !!name && loading.has(name) && !loaded.has(name) && !failed.has(name);
}

export function localeFontReady(locale: string): boolean { const name = family(locale); return !name || loaded.has(name); }
export function fontForLocale(locale: string, original = "sans-serif"): string {
  const name = family(locale);
  return name && loaded.has(name) ? name : original;
}

/** Preserve the game's typography for other languages and for emoji-only widgets. */
export function localizedFont<T>(original: T): T {
  if (typeof original !== "string") return original;
  const name = family();
  return (name && loaded.has(name) && original.toLowerCase() !== "starhermit emoji" ? name : original) as T;
}

export function localizedCanvasFont(original: string): string {
  const name = family();
  if (!name || !loaded.has(name)) return original;
  return /\d+(?:\.\d+)?(?:px|pt|em|rem)\s+/.test(original)
    ? original.replace(/(\d+(?:\.\d+)?(?:px|pt|em|rem)\s+).+$/, "$1'" + name + "'")
    : localizedFont(original);
}

/** Draw text without an explicit family must use the same script face as UI text. */
export function localizedDrawOptions(options: DrawOptions = {}): DrawOptions {
  const name = family();
  if (!name || !loaded.has(name)) return options;
  return { ...options, font: localizedFont(options.font ?? "system-ui") };
}

function styleTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    const next = value.map(styleTree);
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (!value || typeof value !== "object") return value;
  // Host textures/canvases and other class instances carry native identity.
  // Only changed style ancestors are copied; opaque resources pass through.
  const prototype = Object.getPrototypeOf(value);
  if (prototype && Object.getPrototypeOf(prototype) !== null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const next = key === "image" || key === "texture" ? item
      : key === "font" && typeof item === "string" ? localizedFont(item) : styleTree(item);
    if (next !== item) changed = true;
    return [key, next];
  });
  return changed ? Object.fromEntries(entries) : value;
}

/** Resolve inline and constant UI styles when they are used, preserving their authored family. */
export function localizedStyle<T>(style: T): T {
  const name = family();
  return name && loaded.has(name) ? styleTree(style) as T : style;
}

export function onLocalizedFontChange(listener: () => void): () => void {
  fontListeners.add(listener);
  return () => { fontListeners.delete(listener); };
}

export function setLocalizedStyles(styles: Record<string, ui.Style>): void {
  Object.assign(registeredStyles, styles);
  ui.setStyles(localizedStyle(styles));
}

export function setLocalizedDefaultFont(font: { family?: string; weight?: FontWeight } | null): void {
  defaultFont = font;
  const name = family();
  ui.setFont(name && loaded.has(name) ? { ...font, family: name } : font);
}

function refresh(): void {
  setLocalizedDefaultFont(defaultFont);
  if (Object.keys(registeredStyles).length) ui.setStyles(localizedStyle(registeredStyles));
  for (const listener of fontListeners) try { listener(); } catch (error) { console.error("Language font redraw failed", error); }
}

strings.onChange((locale) => { prepareLocaleFont(locale); refresh(); });
prepareLocaleFont(strings.locale);
