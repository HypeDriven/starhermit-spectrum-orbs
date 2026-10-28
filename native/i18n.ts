// Localization: the browser build's tables (js/strings.js through
// js/lang.js: US English source strings as keys, the nine StarHermit
// locales; the account strings in js/sh-strings.js) in the interface
// language the runtime reports (preferences().language: the player's choice
// in Options › Language, else the account's preferred language or the
// device's). The runtime's Options replace the game's own Language setting
// (sh-language.js) and the DOM re-labelling: every string is drawn through
// T() each frame, so a change shows on the next frame and never restarts a
// round.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n, ShStrings } from "./classic.ts";

/** The closest supported locale for a BCP-47 tag (en-US by default; sh-language.js's matching). */
export function pickLocale(tag: string): string {
  const t = String(tag || "").replace("_", "-");
  const exact = I18n.LOCALES.find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const base = t.split("-")[0]!.toLowerCase();
  if (base === "en") return /-(gb|uk|ie|au|nz)$/i.test(t) ? "en-GB" : "en-US";
  if (base === "es") return /-es$/i.test(t) ? "es-ES" : "es-419";
  if (base === "fr") return /-ca$/i.test(t) ? "fr-CA" : "fr-FR";
  return ({ de: "de-DE", pt: "pt-BR", it: "it-IT" } as Record<string, string>)[base] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  I18n.setLocale(locale);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The account strings (signIn, invite, copied, copyFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string {
  const table = ShStrings[locale] ?? ShStrings["en-US"]!;
  let s = table[key] ?? ShStrings["en-US"]![key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
