// Game-owned language fonts. Browser and native builds use the same packaged faces.
import {preferences, files, strings, type FontWeight} from "starhermit:engine";

// Locale tables are split per language. Only the player's fallback chain is
// parsed and kept (en-US first, so it remains the default). Other locales stay
// in the package until the language changes.
const __stringLocales = new Set<string>();
let __stringsBusy = false;
let __stringsWatching = false;
function loadGameStrings(dir: string): void {
  if (__stringsBusy) return;
  __stringsBusy = true;
  try {
    let tag = "en";
    try {
      const language = preferences().language;
      if (language) tag = language;
    } catch { /* preferences are not ready while the module is still loading */ }
    const want = stringLocalesFor(tag);
    const ordered = [...want.filter((locale) => locale === "en-US"), ...want.filter((locale) => locale !== "en-US")];
    const batch: { [locale: string]: unknown } = {};
    for (const locale of ordered) {
      if (__stringLocales.has(locale)) continue;
      const path = `${dir}/${locale}.json`;
      if (!files.exists(path)) continue;
      const table = files.readJson(path);
      if (!table || typeof table !== "object" || Array.isArray(table)) continue;
      batch[locale] = table;
    }
    const added = Object.keys(batch);
    if (added.length) {
      strings.load(batch);
      for (const locale of added) __stringLocales.add(locale);
    }
  } finally {
    __stringsBusy = false;
  }
  if (!__stringsWatching) {
    __stringsWatching = true;
    strings.onChange(() => loadGameStrings(dir));
  }
}
function stringLocalesFor(tag: string): string[] {
  const out: string[] = [];
  const add = (locale: string): void => { if (locale && !out.includes(locale)) out.push(locale); };
  const bits = tag.replace(/_/g, "-").split("-").filter(Boolean);
  const language = (bits[0] || "en").toLowerCase();
  const regionBit = bits.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part));
  const region = regionBit ? (/^\d{3}$/.test(regionBit) ? regionBit : regionBit.toUpperCase()) : "";
  add(region ? `${language}-${region}` : language);
  if (bits.length > 2) {
    add(bits.map((part, index) => index === 0 ? language : (/^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : part)).join("-"));
  }
  if (language === "en" && region && region !== "US" && region !== "CA") add("en-001");
  if (language === "en" && region && region !== "US") add("en-GB");
  if (language === "es" && region !== "ES") add("es-419");
  if (language === "es") add("es-ES");
  if (language === "fr") add("fr-FR");
  if (language === "fr" && region === "CA") add("fr-CA");
  if (language === "de") add("de-DE");
  if (language === "pt" && region !== "BR") add("pt-PT");
  if (language === "pt") add("pt-BR");
  if (language === "it") add("it-IT");
  if (language === "nl") add("nl-NL");
  if (language === "ja") add("ja-JP");
  if (language === "zh") {
    const traditional = region === "HK" || region === "TW" || region === "MO";
    add(traditional ? "zh-HK" : "zh-CN");
    if (!traditional) add("zh-SG");
  }
  if (language === "yue") add("yue-HK");
  if (language === "ru") add("ru-FI");
  add(language);
  add("en-US");
  return out;
}
import { FontFace, fonts } from "starhermit:canvas";
import type { TextOptions as DrawOptions } from "starhermit:draw";
import * as ui from "starhermit:ui";

interface FontManifest { locales: Record<string, string>; faces: Record<string, string> }
// Only locales whose complete body tables are active are present in this file.
loadGameStrings("assets/l10n/common");
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
