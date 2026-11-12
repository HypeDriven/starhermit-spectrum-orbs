// One saved game-language choice. Automatic follows the runtime/account/device language.
import { files, frame, openMenu, preferences, strings } from "starhermit:engine";
import { onAction } from "starhermit:input";
import { settings } from "starhermit:storage";
import * as ui from "starhermit:ui";
import { applyLocaleDirection, fontForLocale, localeFontPending, localeFontReady, prepareLocaleFont } from "./font.ts";

const names = files.readJson("assets/localization/locales.json") as unknown as Record<string, string>;
// Language, Automatic, More settings, Close. This menu owns its labels, so symbolic
// game message keys and English-text game keys work identically.
type MenuLabels = readonly [string, string, string, string];
const ENGLISH: MenuLabels = ["Language", "Automatic", "More settings", "Close"];
const labels: Record<string, MenuLabels> = {
  en: ["Language", "Automatic", "More settings", "Close"],
  de: ["Sprache", "Automatisch", "Weitere Einstellungen", "Schließen"],
  fr: ["Langue", "Automatique", "Autres paramètres", "Fermer"],
  es: ["Idioma", "Automático", "Más ajustes", "Cerrar"],
  pt: ["Idioma", "Automático", "Mais configurações", "Fechar"],
  it: ["Lingua", "Automatico", "Altre impostazioni", "Chiudi"],
  ja: ["言語", "自動", "その他の設定", "閉じる"],
  nl: ["Taal", "Automatisch", "Meer instellingen", "Sluiten"],
  fi: ["Kieli", "Automaattinen", "Lisää asetuksia", "Sulje"],
  sv: ["Språk", "Automatiskt", "Fler inställningar", "Stäng"],
  et: ["Keel", "Automaatne", "Veel seadeid", "Sulge"],
  id: ["Bahasa", "Otomatis", "Pengaturan lainnya", "Tutup"],
  vi: ["Ngôn ngữ", "Tự động", "Cài đặt khác", "Đóng"],
  ms: ["Bahasa", "Automatik", "Tetapan lain", "Tutup"],
  ta: ["மொழி", "தானியங்கி", "கூடுதல் அமைப்புகள்", "மூடு"],
  zh: ["语言", "自动", "更多设置", "关闭"],
  "zh-HK": ["語言", "自動", "更多設定", "關閉"],
  yue: ["語言", "自動", "更多設定", "關閉"],
  yi: ["שפּראַך", "אויטאָמאַטיש", "מער אײַנשטעלונגען", "פֿאַרמאַכן"],
  km: ["ភាសា", "ស្វ័យប្រវត្តិ", "ការកំណត់បន្ថែម", "បិទ"],
};
let choice = "auto";
let visible = false;
let installed = false;
let floatingButton = false;
const text = (): MenuLabels => {
  const keys = ["localization.language", "localization.auto", "localization.more", "localization.close"] as const;
  if (keys.every((key) => strings.has(key))) return [strings.t(keys[0]), strings.t(keys[1]), strings.t(keys[2]), strings.t(keys[3])];
  return labels[strings.locale] || labels[strings.locale.split("-")[0] || "en"] || ENGLISH;
};

function readChoice(): void {
  const value = settings.get("ui.language");
  const saved = typeof value === "string" ? value :
    value && typeof value === "object" && !Array.isArray(value) ? value.choice : null;
  choice = typeof saved === "string" && (saved === "auto" || strings.locales.includes(saved)) ? saved : "auto";
  strings.setLanguage(choice === "auto" ? null : choice);
}

async function choose(locale: string): Promise<void> {
  const resolved = locale === "auto" ? strings.bestLocale(preferences().language, strings.locales) || "en-US" : locale;
  if (!await prepareLocaleFont(resolved)) return;
  choice = locale;
  strings.setLanguage(locale === "auto" ? null : locale);
  settings.set("ui.language", { choice: locale });
}

/** Existing in-game Options buttons open the game language panel and the runtime's options. */
export function openLocalizedOptions(): void { visible = true; }

/** Registered after the game's render callbacks, so the modal receives input first. */
export function installLanguageMenu(floating = false): void {
  if (installed) return;
  installed = true;
  floatingButton = floating;
  settings.onChange((key) => { if (key === "ui.language") readChoice(); });
  // Resolve the saved choice before the first game frame, not after rendering it.
  readChoice();
  onAction((event) => { if (event.action === "localization" && event.pressed) visible = !visible; });
}

/** Compose with the game's one render callback; never replace its lifecycle callbacks. */
export function withLanguageRender(render: (dt: number) => void): (dt: number) => void {
  return (dt) => {
    // A game's language-change callbacks may have reset direction to Auto.
    applyLocaleDirection();
    if (localeFontPending()) {
      const f = frame();
      ui.area({ x: f.width / 2 - 24, y: f.height / 2 - 24, width: 48, height: 48 }, () => ui.label("…", { size: 24 }));
      return;
    }
    render(dt);
    drawLanguageMenu();
  };
}

function drawLanguageMenu(): void {
    if (!installed) return;
    const f = frame(), scale = ui.preferences().scale;
    if (floatingButton && !visible) {
      ui.area({ x: f.width - 48 * scale, y: 6 * scale, width: 42 * scale, height: 42 * scale }, () => {
        if (ui.id("game-language-open").button(text()[0], { content: () => ui.label("🌐") })) visible = true;
      });
    }
    if (!visible) return;
    const available = strings.locales.filter((locale) => !!names[locale]);
    for (const locale of available) void prepareLocaleFont(locale);
    const width = Math.max(120, Math.min(420, f.width / scale - 64));
    const height = Math.max(80, Math.min(380, f.height / scale - 220));
    let close = false;
    const stillOpen = ui.dialog("game-language", text()[0], visible, () => {
      ui.column("game-language-content", () => {
        if (ui.id("game-language-auto").button(text()[1], { selected: choice === "auto" })) void choose("auto");
        ui.scrollArea("game-language-list", { width, height }, () => {
          for (const locale of available) {
            const label = localeFontReady(locale) ? names[locale] || locale : locale;
            if (ui.id("game-language-" + locale).button(label, {
              selected: choice === locale, font: fontForLocale(locale)
            })) void choose(locale);
          }
        });
        if (ui.id("game-language-more").button(text()[2])) { close = true; openMenu(); }
        if (ui.id("game-language-close").button(text()[3])) close = true;
      }, { width, spacing: 8 });
    });
    visible = stillOpen && !close;
}
