// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the top bar (brand → home, Online /
// Offline, the sync badge, the platform clock, the player chip, Help and
// Settings), the title, modes, setup, scores and profile screens, and the
// game screen — the Objective rail (level, moves, limit, time, medal pace,
// the par bar, the mode note), the Actions rail (Undo, Hint, Restart, Camera,
// Pause with their keys, the invalid-move reason), the numbered tube labels
// over the 3D tubes, the board-status chips (one button per tube with its orb
// glyphs: the screen-reader and keyboard mirror of the board), the lesson
// card, the drawer toggles and the phone tray — and the overlays (results,
// pause, settings, help) and toasts. The old media queries are layouts picked
// by the window's logical size: wide desktop (≥ 1024: both rails beside the
// playfield), compact (< 1024: the rails are drawers opened by ☰ / ⚙),
// portrait phone (≤ 700 wide: plus the bottom tray) and short landscape
// (≤ 500 tall: a narrow static Objective rail, the tray under the board, the
// lesson card docked right). The playfield's rectangle less the lesson card
// and the chips (render.js _safeRect) goes to main.ts (view → render.ts).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, type Level } from "./classic.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import { token } from "./style.ts";
import {
  app, beginPending, canUndo, closeOverlay, closeToTitle, colorName, copyInvite, doHint, doUndo, field, fmtTime, frameFlags, fresh, game,
  goBack, invalidText, later, leaveRound, levelName, loadScores, onTubePick, openOverlay, openProfile, openScores, pause, resetCamera,
  restartRound, resultsNext, resume, resumeSnapshot, retry, scoreBoards, setSetting, settings, setState, setupChallenge, setupJourney,
  setupPractice, signIn, skipLesson, startDaily, startLearn, startLevel, topOverlay, view, type Overlay,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ts: number; phone: boolean; land: boolean; compact: boolean; narrow: boolean; ox: number; oy: number }
function layoutNow(): Layout {
  const f = frame();
  const p = ui.preferences();
  const sc = p.scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const land = lw > lh && lh <= 500;
  const phone = !land && lw <= 700 && lh >= lw;
  return { lw, lh, sc, ts: p.textScale, phone, land, compact: lw < 1024, narrow: lw <= 700, ox: sa.left, oy: sa.top };
}
interface Box { x: number; y: number; w: number; h: number }
const toWindow = (L: Layout, b: Box): ui.Rect => ({ x: L.ox + b.x * L.sc, y: L.oy + b.y * L.sc, width: b.w * L.sc, height: b.h * L.sc });
const lastSize = new Map<string, ui.Rect>();
const sizeOf = (id: string, sc: number): { w: number; h: number } | null => {
  const r = lastSize.get(id);
  return r ? { w: r.width / sc, h: r.height / sc } : null;
};
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
const INK = new Set(["menu-btn-primary"]);
function button(b: Btn): void {
  const style = b.style ?? "menu-btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const inner = b.width - 42;
    opts.content = () => { ui.style(INK.has(style) ? "wrap-ink" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.style(INK.has(style) ? "wrap-ink" : "wrap").label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) {
    frameFlags.widgetPress = true;
    later(b.act);
  }
}
/** Buttons at their own widths in rows that wrap at `width` (.row.wrap). */
function flow(label: string, list: Btn[], width: number, gap = 12, justify: "start" | "center" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "menu-btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
/** Words wrapped to `maxPx` window pixels (draw.text's own wrap breaks inside words). */
function wrapLines(text: string, maxPx: number, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && draw.measureText(next, { size, font: "sans-serif" }).width > maxPx) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
/** The key a runtime action is bound to (the old <kbd> labels). */
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
function keyOf(action: string, device: "keyboard" | "gamepad" = "keyboard"): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === device).map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return list[0] ?? "—";
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const top = topBarH(L);
  if (app.base === "game" && game.session) gameScreen(L, top);
  else {
    draw.rect(0, 0, f.width, f.height, token("bg"));
    Object.assign(view, { x: 0, y: 0, width: f.width, height: f.height });
    menuScreen(L, top);
  }
  topBar(L, top);
  const ov = topOverlay();
  if (ov) overlay(L, ov);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}
const topBarH = (L: Layout): number => (L.land ? 44 : L.narrow ? 104 : 61);

// ------------------------------------------------------------------ the top bar
function brandOrb(): void {
  ui.widget("", {
    role: "none", size: { width: 18, height: 18 },
    draw: (r) => {
      const cols = ["#e8533f", "#e8a33f", "#7bc950", "#3fb8af", "#4a7de0", "#8a5fd6"];
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2, rad = r.width / 2;
      draw.circle(cx, cy, rad * 1.5, "#6ea8ff22");
      cols.forEach((c, i) => {
        const pts: [number, number][] = [[cx, cy]];
        for (let k = 0; k <= 6; k++) { const a = ((i + k / 6) / 6) * Math.PI * 2 - Math.PI / 2; pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); }
        draw.polygon(pts, c);
      });
    },
  });
}
function topBar(L: Layout, h: number): void {
  const f = frame();
  draw.box(0, 0, f.width, (L.oy / L.sc + h) * L.sc, "topbar");
  const hosted = platform.signedIn();
  const st = platform.syncState();
  const clock = `${new Date(platform.nowMs()).toUTCString().slice(17, 25)} UTC`;
  const who = hosted ? platform.displayName() || T("Player") : T("Guest");
  const brand = (): void => { button({
    id: "btn-home", text: "Spectrum Orbs", name: T("Spectrum Orbs — home"), style: "brand-btn", act: closeToTitle,
    content: () => { ui.row("brand-face", () => { brandOrb(); ui.style("brand").label("Spectrum Orbs"); }, { spacing: 8, align: "center" }); },
  }); };
  const status = (): void => { ui.row("topbar-status", () => {
    ui.row("conn", () => {
      ui.style(hosted ? "status-ok" : "status-off").label("●");
      ui.style("status").id("conn-status").label(hosted ? T("Online") : T("Offline"));
    }, { spacing: 4, align: "center" });
    if (st === "synced" || st === "saving") ui.style(st === "synced" ? "status-ok" : "status").id("sync-status").label(st === "synced" ? `✓ ${T("Synced")}` : `… ${T("Saving…")}`);
    ui.style("status").id("clock-status").label(clock);
    ui.style("status", { text: { overflow: "ellipsis" }, width: Math.min(140, textWidth(who, "status") + 2) }).id("profile-chip").label(who);
    button({ id: "btn-help-top", text: "?", name: T("Help"), style: "icon-btn", width: 44, act: () => openOverlay("help") });
    button({ id: "btn-settings-top", text: "⚙", name: T("Settings"), style: "icon-btn", width: 44, act: () => openOverlay("settings") });
  }, { spacing: L.narrow ? 8 : 12, align: "center" }); };
  if (L.narrow && !L.land) {
    ui.place("topbar-a", { anchor: "top-start", x: 14, y: 4 }, brand);
    ui.place("topbar-b", { anchor: "top-end", x: 14, y: 52 }, status);
  } else {
    const y = L.land ? 0 : 8;
    ui.place("topbar-a", { anchor: "top-start", x: 16, y }, brand);
    ui.place("topbar-b", { anchor: "top-end", x: 16, y }, status);
  }
}

// ------------------------------------------------------------------ menu screens
function menuScreen(L: Layout, top: number): void {
  const colW = app.base === "modes" ? 960 : app.base === "profile" ? 720 : 704;
  const w = Math.min(colW, L.lw - 32);
  const h = L.lh - top - 8;
  const key = `screen-${app.base}`;
  const prev = sizeOf(key, L.sc);
  const opening = frame().frame - app.openedFrame <= 6;
  const body = (): void => {
    lastSize.set(key, ui.column(`${key}-in`, () => {
      switch (app.base) {
        case "title": titleScreen(L, w); break;
        case "modes": modesScreen(w); break;
        case "setup": setupScreen(w); break;
        case "scores": scoresScreen(w); break;
        case "profile": profileScreen(w); break;
        default: break;
      }
    }, { width: w, spacing: 12, padding: { top: 24, bottom: 24 } }));
  };
  ui.place(key, { anchor: "top-start", x: (L.lw - w) / 2 - (prev && prev.h > h ? 7 : 0), y: top + 4 }, () => {
    if (prev && prev.h > h) ui.scrollArea(`${key}-scroll`, { width: w + 14, height: h }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function titleScreen(L: Layout, w: number): void {
  const done = Object.keys(platform.progression().journey).length;
  const nowMs = platform.nowMs();
  const nextDay = new Date(`${platform.utcDate()}T00:00:00Z`).getTime() + 86400000;
  ui.column("title-hero", () => {
    ui.spacer(0.0001);
    const size = Math.min(57.6, Math.max(35.2, L.lw * 0.06));
    ui.style("h1", { text: { size } }).id("title-heading").label("Spectrum Orbs");
    ui.style("tagline").id("tagline").paragraph(T("A kinetic sculpture gallery. Sort every tube to a single color."), Math.min(w, 600));
  }, { width: w, align: "center", spacing: 8, padding: { top: Math.round(L.lh * 0.04) } });
  const mw = Math.min(380, w);
  ui.column("title-menu", () => {
    const item = (id: string, text: string, sub: string, act: () => void, primary = false): void => {
      ui.column(`${id}-item`, () => {
        button({ id, text, style: primary ? "menu-btn-primary" : "menu-btn", width: mw, act });
        if (sub) ui.style("menu-sub", { width: mw }).id(`${id}-sub`).label(sub);
      }, { spacing: 2, width: mw });
    };
    item("btn-play", T("Play"), T("{done} / {total} stages", { done, total: Content.JOURNEY.length }), setupJourney, true);
    item("btn-daily", T("Daily Challenge"), T("next board in {time}", { time: fmtTime(nextDay - nowMs) }), startDaily);
    item("btn-modes", T("All Modes"), "", () => setState("mode-select", "user"));
    item("btn-learn", T("Learn to Play"), "", startLearn);
    item("btn-scores", T("Scores & Friends"), "", openScores);
    item("btn-profile", T("Profile & Progress"), "", openProfile);
    if (!platform.signedIn()) item("btn-signin", S("signIn"), "", signIn);
    if (platform.inviteLink()) item("btn-invite", S("invite"), "", copyInvite);
  }, { width: w, spacing: 12, align: "center" });
  const snap = app.resumeSnap;
  if (snap) ui.column("resume-note", () => {
    button({ id: "btn-resume-round", text: T("Resume unfinished round ({name})", { name: levelName(snap.level) }), width: mw, act: resumeSnapshot });
  }, { width: w, align: "center", padding: { top: 8 } });
}

const MODE_CARDS: [string, string, string, string, () => void][] = [
  ["journey", N("Journey"), N("Forty authored stages across five gallery wings. New ideas arrive one at a time."), N("Scored per stage · ~2–5 min each"), () => setupJourney()],
  ["daily", N("Daily"), N("One shared seed for everyone, per UTC day. Compare scores with friends."), N("One board per day · platform time"), () => startDaily()],
  ["practice", N("Practice"), N("Selectable difficulty, free undo and hints, fresh boards on demand."), N("Unranked · endless"), () => setupPractice()],
  ["challenge", N("Challenge"), N("Move limits, speed targets, crowded layouts, restricted tools."), N("Five trials"), () => setupChallenge()],
  ["learn", N("Learn"), N("Interactive lessons. One rule at a time — you perform each action."), N("Unranked · five lessons"), () => startLearn()],
  ["scores", N("Score Chase"), N("Global platform leaderboard plus local personal-best records."), N("Asynchronous comparison · read-only"), () => openScores()],
];
function card(id: string, title: string, body: string, meta: string, w: number, act: () => void, selected = false): void {
  const iw = w - 38;
  button({
    id, text: title, name: title, style: "card", width: w, act, selected,
    content: () => ui.column(`${id}-face`, () => {
      para(title, iw, "card-h3");
      if (body) para(body, iw, "card-p");
      if (meta) para(meta, iw, "card-meta");
    }, { spacing: 6, width: iw }),
  });
}
/** .card-grid: repeat(auto-fit, minmax(240px, 1fr)) with 14 px gaps. */
function cardGrid(id: string, w: number, count: number, build: (i: number, cw: number) => void): void {
  const gap = 14;
  const cols = Math.max(1, Math.min(count, Math.floor((w + gap) / (240 + gap))));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < count; r++) ui.row(`${id}-r${r}`, () => {
      for (let i = r * cols; i < Math.min(count, (r + 1) * cols); i++) build(i, cw);
    }, { spacing: gap, align: "stretch" });
  }, { spacing: gap, width: w });
}
function backLink(text = T("← Back to title")): void {
  button({ id: "btn-back", text, style: "text-btn", act: goBack });
}
function modesScreen(w: number): void {
  para(T("Choose a mode"), w, "h2", "modes-heading");
  cardGrid("mode-cards", w, MODE_CARDS.length, (i, cw) => {
    const [id, name, body, meta, act] = MODE_CARDS[i]!;
    card(`mode-${id}`, T(name), T(body), T(meta), cw, act);
  });
  backLink();
}
function setupScreen(w: number): void {
  const s = app.setup;
  para(T("Setup"), w, "h2", "setup-heading");
  if (!s) return;
  if (s.kind === "journey" && s.level) {
    const lv = s.level;
    const extra = T("Stage {n} of {total}", { n: lv.index ?? 0, total: Content.JOURNEY.length }) +
      (lv.mastery ? ` · ${T("Mastery stage")}` : "") + ` · ${T("Theme: {name}", { name: T(Content.THEMES[lv.theme]!.name) })}`;
    setupFacts(lv, w, { modeLabel: T("Journey"), duration: T("2–5 min"), assists: T("Undo + hints enabled"), extra });
  } else if (s.kind === "practice") {
    para(T("Practice — unranked"), w, "h3", "setup-h3");
    for (const d of Object.values(Content.PRACTICE)) {
      card(`practice-${d.key}`, T(d.name),
        `${T("{colors} colors · capacity {capacity}", { colors: d.colors, capacity: d.capacity })} · ${T(d.spare > 1 ? "{n} spare tubes" : "{n} spare tube", { n: d.spare })}`,
        "", w, () => { app.practiceDifficulty = d.key; }, d.key === app.practiceDifficulty);
    }
    para(T("Undo and hints enabled · no effect on competitive rating · restart anytime"), w, "note", "setup-facts");
  } else if (s.kind === "challenge") {
    para(T("Challenge trials"), w, "h3", "setup-h3");
    const prog = platform.progression();
    for (const c of Content.CHALLENGES) {
      const best = prog.challenges[c.id];
      card(`challenge-${c.id}`, T(c.name!), T(c.blurb ?? ""), best && best.won ? T("Best: {n} pts", { n: best.score }) : T("Not yet cleared"), w,
        () => { app.setup = { kind: "challenge", level: c }; beginPending(); });
    }
  }
  flow("setup-actions", [
    { id: "btn-begin", text: T("Begin"), style: "menu-btn-primary", act: beginPending },
    { id: "btn-back", text: T("← Back"), style: "text-btn", act: goBack },
  ], w, 12);
}
function setupFacts(lv: Level, w: number, info: { modeLabel: string; duration: string; assists: string; extra: string }): void {
  para(levelName(lv), w, "h3", "setup-h3");
  const facts = [
    `${info.modeLabel} · ${T("{n} player", { n: 1 })}`,
    T("Expected duration: {time}", { time: info.duration }),
    T("Assists: {list}", { list: info.assists }),
    `${T("{colors} colors · capacity {capacity}", { colors: lv.colors, capacity: lv.capacity })} · ${T("{n} spare", { n: lv.spare })}`,
    T("Par: 🥇{gold} 🥈{silver} 🥉{bronze} moves", { gold: lv.par.gold, silver: lv.par.silver, bronze: lv.par.bronze }),
    info.extra,
  ].filter(Boolean);
  ui.column("setup-facts", () => { facts.forEach((f, i) => para(f, w, "note", `fact-${i}`)); }, { spacing: 4, width: w });
  const rules = [
    T("Rules: pour the top orb onto an empty tube or a matching color."),
    lv.limits?.moves ? T("Move limit: {n}.", { n: lv.limits.moves }) : "",
    lv.limits?.timeMs ? T("Time limit: {time}.", { time: fmtTime(lv.limits.timeMs) }) : "",
    lv.limits && lv.limits.undo === false ? T("Undo disabled.") : "",
  ].filter(Boolean).join(" ");
  para(rules, w, "note", "setup-rules");
}

/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 36, height: 36 },
      draw: (r, st) => {
        const s = st.scale, box = 20 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : token("panel-2"));
        draw.strokeRoundRect(bx, by, box, box, 4, on ? token("accent") : "#ffffff66", 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 15 * s, color: token("primary-ink"), align: "center", weight: "bold" });
      },
    });
    para(label, w - 48, "text-sm", `${id}-label`);
    if (res.activated && fresh()) { frameFlags.widgetPress = true; later(() => set(!on)); }
  }, { width: w, align: "center", spacing: 8 });
}
function selectRow(id: string, label: string, w: number, index: number, options: string[], set: (i: number) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, w * 0.36, "text-sm", `${id}-label`);
    ui.spacer();
    const pick = ui.id(id).select(label, index, options, { width: Math.min(w * 0.6, 260) } as ui.WidgetOptions);
    if (pick !== index) later(() => set(pick));
  }, { width: w, align: "center", spacing: 10 });
}

function scoresScreen(w: number): void {
  para(T("Scores & Friends"), w, "h2", "scores-heading");
  const boards = scoreBoards();
  const idx = Math.max(0, boards.findIndex(([id]) => id === app.scoresBoard));
  selectRow("scores-board-select", T("Board"), Math.min(w, 460), idx, boards.map(([, l]) => l), (i) => { app.scoresBoard = boards[i]![0]; loadScores(); });
  if (app.scoresBoard === "platform") toggleRow("scores-friends", T("Friends only"), app.scoresFriends, Math.min(w, 460), (v) => { app.scoresFriends = v; loadScores(); });
  const data = app.scoresData;
  if (data?.note) para(T(data.note), w, "note", "scores-casual-note");
  else if (data?.casual) para(T("Casual board — authoritative validation unavailable offline."), w, "note", "scores-casual-note");
  const narrow = w < 480;
  const cols = narrow ? [T("#"), T("Player"), T("Score")] : [T("#"), T("Player"), T("Score"), T("Seed"), T("Duration")];
  const entries = data?.entries ?? [];
  ui.grid("scores-table", () => {
    for (const c of cols) ui.style("lb-h").label(c);
    if (!entries.length) {
      ui.cell({ span: cols.length }).style("note").label(T("No scores yet — be the first."));
      return;
    }
    entries.slice(0, 50).forEach((e, i) => {
      const vals = [String(i + 1), e.player || T("Guest"), String(e.score)];
      if (!narrow) vals.push(e.seed === null || e.seed === undefined ? "—" : String(e.seed).slice(0, 8), fmtTime(e.durationMs || 0));
      vals.forEach((v, k) => ui.style("lb-c", { text: { overflow: "ellipsis" } }).id(`lb-${i}-${k}`).label(v));
    });
  }, { columns: narrow ? [36, { fr: 1 }, { width: "auto", align: "end" }] : [36, { fr: 1 }, "auto", "auto", { width: "auto", align: "end" }], width: w, gap: { row: 6, column: 12 }, rowStyle: "score-row" });
  backLink();
}

function profileScreen(w: number): void {
  const prog = platform.progression();
  para(T("Profile & Progress"), w, "h2", "profile-heading");
  const name = platform.signedIn() ? platform.displayName() || T("Player") : T("Guest");
  para(T("{name} — {done} of {total} journey stages complete. {boards} total boards finished. Daily streak: {streak}.", {
    name, done: Object.keys(prog.journey).length, total: Content.JOURNEY.length, boards: prog.stats.totalCompletions, streak: prog.streak.count,
  }), w, "text", "profile-body");
  if (!platform.signedIn()) para(T("Playing as guest — progress is stored on this device. Sign in through the host for cloud sync."), w, "note", "profile-guest");
  para(T("Achievements"), w, "h3", "ach-heading");
  ui.column("achievement-list", () => {
    for (const a of Content.ACHIEVEMENTS) {
      const got = !!prog.achievements[a.key];
      ui.column(`ach-${a.key}`, () => {
        para(`${got ? "🏆 " : "○ "}${T(a.name)}`, w - 30, "ach-name");
        para(T(a.desc), w - 30, "ach-desc");
      }, { style: "ach-item", width: w, spacing: 2 });
    }
  }, { spacing: 8, width: w });
  para(T("Mastery track"), w, "h3", "mastery-heading");
  const done = prog.journey;
  const unlocked = Content.JOURNEY.filter((l) => done[l.id]).length + 1;
  const gap = 8;
  const cols = Math.max(1, Math.floor((w + gap) / (64 + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column("journey-grid", () => {
    for (let r = 0; r * cols < Content.JOURNEY.length; r++) ui.row(`journey-grid-r${r}`, () => {
      for (let i = r * cols; i < Math.min(Content.JOURNEY.length, (r + 1) * cols); i++) {
        const lv = Content.JOURNEY[i]!;
        const rec = done[lv.id];
        const locked = i >= unlocked;
        const medalName = T(({ gold: "gold", silver: "silver", bronze: "bronze" } as Record<string, string>)[rec?.medal ?? ""] ?? "clear");
        const name = T("Stage {n}", { n: lv.index ?? i + 1 }) + (lv.name ? ` ${levelName(lv)}` : "") +
          (locked ? T(", locked") : rec ? T(", completed, medal {medal}", { medal: medalName }) : T(", available"));
        const medal = rec ? (({ gold: "🥇", silver: "🥈", bronze: "🥉", clear: "✓" } as Record<string, string>)[rec.medal ?? "clear"] ?? "✓") : lv.mastery ? "◆" : "";
        button({
          id: `stage-${i + 1}`, text: name, name, style: lv.mastery ? "journey-mastery" : "journey-cell", width: cw, height: 56, disabled: locked,
          act: () => startLevel(lv, "journey"),
          content: () => ui.column(`stage-${i + 1}-face`, () => {
            ui.style("cell-num").label(String(lv.index ?? i + 1));
            if (medal) ui.style("cell-medal").label(medal);
          }, { spacing: 2, align: "center" }),
        });
      }
    }, { spacing: gap });
  }, { spacing: gap, width: w });
  backLink();
}

// ------------------------------------------------------------------ the game screen
function gameScreen(L: Layout, top: number): void {
  const f = frame();
  const lefty = settings().leftHanded;
  const pad = L.land ? 6 : 12, gap = L.land ? 6 : 12;
  const trayOn = L.phone || L.land;
  const trayH = trayOn ? (sizeOf("tray", L.sc)?.h ?? (L.land ? 58 : 70)) : 0;
  const areaTop = top + pad, areaBottom = L.lh - pad - (trayOn ? trayH + gap : 0);
  // .game-screen grid: 250px 1fr 210px (wide), 1fr (compact: rails are drawers), 190px 1fr (short landscape)
  let fx = pad, fw = L.lw - 2 * pad;
  let leftRail: Box | null = null, rightRail: Box | null = null;
  if (L.land) {
    const rw = 190;
    leftRail = { x: lefty ? L.lw - pad - rw : pad, y: areaTop, w: rw, h: areaBottom - areaTop };
    fx = lefty ? pad : pad + rw + gap; fw = L.lw - 2 * pad - rw - gap;
  } else if (!L.compact) {
    const lw = 250, rw = 210;
    const a = { x: pad, y: areaTop, w: lw, h: areaBottom - areaTop }, b = { x: L.lw - pad - rw, y: areaTop, w: rw, h: areaBottom - areaTop };
    // left-handed: the Actions rail on the left (css body.left-handed .rail#rail-right { order: -1 })
    if (lefty) { rightRail = { ...a, w: rw }; leftRail = { ...b, x: L.lw - pad - lw, w: lw }; fx = pad + rw + gap; }
    else { leftRail = a; rightRail = b; fx = pad + lw + gap; }
    fw = L.lw - 2 * pad - lw - rw - 2 * gap;
  }
  const fb: Box = { x: fx, y: areaTop, w: fw, h: areaBottom - areaTop };
  Object.assign(field, toWindow(L, fb));
  // the page around the playfield (#playfield sits on --bg between the rails)
  const fr = toWindow(L, fb);
  const bg = token("bg");
  draw.rect(0, 0, f.width, fr.y, bg);
  draw.rect(0, fr.y + fr.height, f.width, f.height - fr.y - fr.height, bg);
  draw.rect(0, fr.y, fr.x, fr.height, bg);
  draw.rect(fr.x + fr.width, fr.y, f.width - fr.x - fr.width, fr.height, bg);
  // rounded playfield corners (border-radius 14)
  const rr = 14 * L.sc;
  for (const [cx, cy, sx, sy] of [[fr.x, fr.y, 1, 1], [fr.x + fr.width, fr.y, -1, 1], [fr.x, fr.y + fr.height, 1, -1], [fr.x + fr.width, fr.y + fr.height, -1, -1]] as const) {
    const pts: [number, number][] = [[cx, cy]];
    for (let k = 0; k <= 8; k++) { const a = (k / 8) * (Math.PI / 2); pts.push([cx + sx * (rr - rr * Math.cos(a)), cy + sy * (rr - rr * Math.sin(a))]); }
    pts.push([cx, cy]);
    draw.polygon([[cx, cy], [cx + sx * rr, cy], ...pts.slice(1, -1).reverse(), [cx, cy + sy * rr]], bg);
  }

  // the lesson card and the chips carve the camera's rectangle (render.js _safeRect)
  const lesson = game.mode === "learn" && game.tutorialIndex >= 0 ? Content.TUTORIAL[game.tutorialIndex]! : null;
  const cardSz = sizeOf("tutorial-card", L.sc);
  let cardBox: Box | null = null;
  if (lesson) {
    if (L.land) { const cw = Math.min(220, fb.w * 0.4); cardBox = { x: fb.x + fb.w - 8 - cw, y: fb.y + 8, w: cw, h: Math.min(cardSz?.h ?? 140, fb.h - 16) }; }
    else { const cw = Math.min(420, fb.w - 24); cardBox = { x: fb.x + (fb.w - cw) / 2, y: fb.y + (L.compact ? 64 : 12), w: cw, h: cardSz?.h ?? 150 }; }
  }
  const stripSz = sizeOf("board-status", L.sc);
  const stripH = stripSz?.h ?? 40;
  let t = fb.y, b = fb.y + fb.h, l = fb.x, r = fb.x + fb.w;
  if (cardBox) {
    if (cardBox.w > fb.w * 0.55 || (cardBox.x < fb.x + fb.w / 2 && cardBox.x + cardBox.w > fb.x + fb.w / 2)) t = Math.max(t, cardBox.y + cardBox.h);
    else if (cardBox.x + cardBox.w / 2 < fb.x + fb.w / 2) l = Math.max(l, cardBox.x + cardBox.w);
    else r = Math.min(r, cardBox.x);
  }
  b = Math.min(b, fb.y + fb.h - 8 - stripH);
  if (r - l < fb.w * 0.4) { l = fb.x; r = fb.x + fb.w; }
  if (b - t < fb.h * 0.4) { t = fb.y; b = fb.y + fb.h; }
  Object.assign(view, toWindow(L, { x: l, y: t, w: r - l, h: b - t }));

  // widgets (later ones are on top)
  tubeLabels(L);
  boardStatus(L, fb);
  if (lesson && cardBox) tutorialCard(L, cardBox, lesson);
  if (L.compact && !L.land) drawerToggles(L, fb);
  if (leftRail) objectiveRail(L, leftRail, "rail");
  if (rightRail) actionsRail(L, rightRail, "rail");
  if (L.compact && !L.land && app.railOpen) {
    const dw = Math.min(300, L.lw * 0.84);
    const box: Box = { x: app.railOpen === "left" ? fb.x : fb.x + fb.w - dw, y: fb.y, w: dw, h: fb.h };
    if (app.railOpen === "left") objectiveRail(L, box, "drawer"); else actionsRail(L, box, "drawer");
  }
  if (trayOn) tray(L, trayH, pad);
}
const medalPace = (moves: number, par: Level["par"] | null): string => {
  if (!par) return "—";
  if (moves <= par.gold) return `🥇 ${T("gold pace")}`;
  if (moves <= par.silver) return `🥈 ${T("silver pace")}`;
  if (moves <= par.bronze) return `🥉 ${T("bronze pace")}`;
  return T("clear pace");
};
const MODE_NOTE: Record<string, () => string> = {
  journey: () => T("Journey"), daily: () => T("Daily · seed {seed}", { seed: game.level!.seed.toString(16) }),
  practice: () => T("Practice · unranked"), challenge: () => T("Challenge"), learn: () => T("Lesson"),
};
function objectiveRail(L: Layout, box: Box, style: "rail" | "drawer"): void {
  const st = game.session!.state, lv = game.level!;
  const iw = box.w - 30;
  const small = L.land;
  ui.place(`rail-left-${style}`, { anchor: "top-start", x: box.x, y: box.y }, () => {
    const rows: [string, string, string][] = [[N("Level"), levelName(lv), "hud-level"], [N("Moves"), String(st.moves), "hud-moves"]];
    if (st.limits.moves !== null) rows.push([N("Limit"), T("{n} moves left", { n: st.limits.moves - st.moves }), "hud-limit"]);
    else if (st.limits.timeMs !== null) rows.push([N("Limit"), T("{time} left", { time: fmtTime(Math.max(0, st.limits.timeMs - liveElapsed())) }), "hud-limit"]);
    rows.push([N("Time"), fmtTime(liveElapsed()), "hud-time"], [N("Medal pace"), medalPace(st.moves, lv.par), "hud-medal"]);
    const scroll = (): void => {
      ui.style("rail-heading", small ? { text: { size: 16 } } : null).id("rail-left-h").label(T("Objective").toLocaleUpperCase());
      para(T("Sort each tube to a single color."), iw, small ? "mini" : "text-sm", "objective-text");
      const labelW = Math.min(110, iw * 0.45);
      for (const [k, v, id] of rows) {
        ui.row(`${id}-row`, () => {
          ui.style("meta-label", { width: labelW }).label(T(k));
          para(v, iw - labelW - 8, "meta-value", id);
        }, { spacing: 8, width: iw });
      }
      const pct = Math.min(1, st.moves / lv.par.bronze);
      ui.widget("", {
        role: "none", size: { width: iw, height: 6 },
        draw: (rr) => { draw.box(rr.x, rr.y, rr.width, rr.height, "par-bar"); if (pct > 0) draw.box(rr.x, rr.y, rr.width * pct, rr.height, "par-fill"); },
      });
      const note = MODE_NOTE[game.mode]?.() ?? "";
      if (note) para(note, iw, "note", "hud-mode-note");
    };
    ui.column(`rail-left-${style}-col`, scroll, { style, width: box.w, height: box.h, spacing: small ? 4 : 8, clip: true });
  });
}
/** The session's live elapsed time (GameSession.elapsedMs; state.elapsedMs only moves with commands). */
function liveElapsed(): number {
  const s = game.session as unknown as { elapsedMs(): number } | null;
  return s ? s.elapsedMs() : 0;
}
function actionsRail(_L: Layout, box: Box, style: "rail" | "drawer"): void {
  const iw = box.w - 30;
  const items: [string, string, string, () => void, boolean][] = [
    ["btn-undo", N("Undo"), "undo", doUndo, !canUndo()],
    ["btn-hint", N("Hint"), "hint", doHint, false],
    ["btn-restart", N("Restart"), "restart", restartRound, false],
    ["btn-camera", N("Camera"), "camera", resetCamera, false],
    ["btn-pause", N("Pause"), "pause", pause, false],
  ];
  ui.place(`rail-right-${style}`, { anchor: "top-start", x: box.x, y: box.y }, () => {
    ui.column(`rail-right-${style}-col`, () => {
      ui.style("rail-heading").id("rail-right-h").label(T("Actions").toLocaleUpperCase());
      for (const [id, name, action, act, disabled] of items) {
        const k = action === "pause" ? "Esc" : keyOf(action);
        button({
          id, text: T(name), style: "action-btn", width: iw, disabled, act,
          content: () => ui.row(`${id}-face`, () => {
            ui.style("action-label").label(T(name));
            ui.spacer();
            ui.row(`${id}-kbd`, () => { ui.style("kbd-text").label(k); }, { style: "kbd" });
          }, { width: iw - 26, align: "center" }),
        });
      }
      if (app.invalidReason) para(invalidText(app.invalidReason), iw, "alert", "invalid-reason");
    }, { style, width: box.w, height: box.h, spacing: 8, clip: true });
  });
}
function tubeLabels(L: Layout): void {
  const anchors = render.tubeAnchors();
  anchors.forEach((p, i) => {
    const x = p.x / L.sc - L.ox / L.sc, y = p.y / L.sc - L.oy / L.sc;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const sel = i === game.selected;
    ui.place(`tube-label-${i}`, { anchor: "top-start", x: x - 22, y: y - 44 }, () => {
      button({
        id: `tube-label-${i}`, text: String(i + 1), name: T("Tube {n}", { n: i + 1 }), style: i === game.kbFocus ? "tube-label-focus" : "tube-label",
        width: 44, height: 44, selected: sel, act: () => onTubePick(i),
        content: () => ui.style("tube-num").label(String(i + 1)),
      });
    });
  });
}
function boardStatus(L: Layout, fb: Box): void {
  const st = game.session!.state, pal = game.palette;
  const maxW = fb.w - 16;
  const sz = sizeOf("board-status", L.sc);
  const w = sz?.w ?? maxW;
  ui.place("board-status-wrap", { anchor: "top-start", x: fb.x + (fb.w - w) / 2, y: fb.y + fb.h - 8 - (sz?.h ?? 40) }, () => {
    const chipW = (tube: number[]): number => 28 + tube.length * 17 + (tube.length ? 0 : 12);
    const rows: number[][] = [[]];
    let used = 0;
    st.tubes.forEach((tube, i) => {
      const cw = chipW(tube);
      if (rows[rows.length - 1]!.length && used + 6 + cw > maxW - 18) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? 6 : 0) + cw;
      rows[rows.length - 1]!.push(i);
    });
    const shown = L.land ? rows.slice(0, 2) : rows;
    const r = ui.column("board-status", () => {
      shown.forEach((row, ri) => ui.row(`chips-${ri}`, () => {
        for (const i of row) {
          const tube = st.tubes[i]!;
          const names = tube.map((c) => colorName(pal[c]));
          const name = T("Tube {n}: {orbs}, {count} of {capacity}", { n: i + 1, orbs: names.length ? names.join(", ") : T("empty"), count: tube.length, capacity: st.capacity }) +
            (i === game.selected ? T(", selected") : "");
          const cw = chipW(tube);
          const res = ui.id(`chip-${i}`).widget(name, {
            role: "button", size: { width: cw, height: 28 }, style: "chip",
            draw: (rr, ws) => {
              const s = ws.scale;
              if (i === game.selected) draw.roundRect(rr.x, rr.y, rr.width, rr.height, 6, "#6ea8ff33");
              const cy = rr.y + rr.height / 2 - 7.5 * s;
              draw.text(`${i + 1}`, rr.x + 6 * s, cy, { size: 12.5 * s, color: token("ink"), font: "sans-serif" });
              tube.forEach((c, k) => {
                const def = pal[c];
                draw.text(def ? def.glyph : "?", rr.x + (22 + k * 17 + 7) * s, cy - 1.5 * s, { size: 15.5 * s, color: def ? def.hex : "#ffffff", align: "center", font: "sans-serif" });
              });
              if (!tube.length) draw.text("∅", rr.x + 26 * s, cy, { size: 12.5 * s, color: "#ffffff80", align: "center", font: "sans-serif" });
            },
          });
          if (res.activated && fresh()) { frameFlags.widgetPress = true; later(() => onTubePick(i)); }
        }
      }, { spacing: 6, justify: "center" }));
    }, { style: "strip", spacing: 2, align: "center" });
    lastSize.set("board-status", r);
  });
}
function tutorialCard(L: Layout, box: Box, lesson: (typeof Content.TUTORIAL)[number]): void {
  const iw = box.w - 38;
  const small = L.land;
  ui.place("tutorial-card", { anchor: "top-start", x: box.x, y: box.y }, () => {
    const r = ui.column("tutorial", () => {
      ui.style("tutorial-title", small ? { text: { size: 15.2 } } : null).id("tutorial-title")
        .paragraph(T("Lesson {n} of {total} — {title}", { n: game.tutorialIndex + 1, total: Content.TUTORIAL.length, title: T(lesson.title) }), iw);
      ui.style("tutorial-body", small ? { text: { size: 13.6 } } : null).id("tutorial-body").paragraph(T(lesson.body), iw);
      if (lesson.hint) ui.style("tutorial-hint", small ? { text: { size: 13.6 } } : null).id("tutorial-hint").paragraph(T(lesson.hint), iw);
      button({ id: "btn-skip-lesson", text: T("Skip lesson"), style: "text-btn", act: skipLesson });
    }, { style: "tutorial", width: box.w, spacing: small ? 4 : 8, padding: small ? { top: 10, bottom: 10, start: 12, end: 12 } : undefined });
    lastSize.set("tutorial-card", r);
  });
}
function drawerToggles(_L: Layout, fb: Box): void {
  ui.place("drawer-left-toggle", { anchor: "top-start", x: fb.x + 10, y: fb.y + 10 }, () => {
    button({ id: "drawer-left-toggle", text: "☰", name: T("Toggle objective panel"), style: "drawer-toggle", width: 44, height: 44,
      act: () => { app.railOpen = app.railOpen === "left" ? null : "left"; } });
  });
  ui.place("drawer-right-toggle", { anchor: "top-start", x: fb.x + fb.w - 54, y: fb.y + 10 }, () => {
    button({ id: "drawer-right-toggle", text: "⚙", name: T("Toggle actions panel"), style: "drawer-toggle", width: 44, height: 44,
      act: () => { app.railOpen = app.railOpen === "right" ? null : "right"; } });
  });
}
/** #tray: ↶ 💡 ⟳ ⏸ (portrait phones and short landscape). */
function tray(L: Layout, h: number, pad: number): void {
  const items: [string, string, string, () => void, boolean][] = [
    ["tray-undo", "↶", N("Undo"), doUndo, !canUndo()],
    ["tray-hint", "💡", N("Hint"), doHint, false],
    ["tray-restart", "⟳", N("Restart"), restartRound, false],
    ["tray-pause", "⏸", N("Pause"), pause, false],
  ];
  const big = L.phone;
  ui.place("tray", { anchor: "top-start", x: pad, y: L.lh - pad - h }, () => {
    const r = ui.row("tray", () => {
      for (const [id, glyph, name, act, disabled] of items) {
        button({
          id, text: T(name), name: T(name), style: "tray-btn", width: big ? 56 : 48, height: big ? 52 : 44, disabled, act,
          content: () => (glyph === "⏸" ? pauseGlyph() : ui.style("tray-glyph", big ? null : { text: { size: 17.6 } }).label(glyph)),
        });
      }
    }, { style: big ? "tray" : undefined, width: L.lw - 2 * pad, spacing: big ? 10 : 8, justify: "center", padding: big ? 8 : 6 });
    lastSize.set("tray", r);
  });
}
/** ⏸ draws thin in fonts: two bars. */
function pauseGlyph(): void {
  ui.widget("", {
    role: "none", size: { width: 16, height: 16 },
    draw: (r, st) => {
      const s = st.scale, bw = 3.5 * s, bh = 13 * s, y = r.y + (r.height - bh) / 2, cx = r.x + r.width / 2;
      draw.roundRect(cx - bw - 1.5 * s, y, bw, bh, 1, st.colors.text);
      draw.roundRect(cx + 1.5 * s, y, bw, bh, 1, st.colors.text);
    },
  });
}

// ------------------------------------------------------------------ overlays
const OVERLAY_LABEL: Record<Overlay, string> = { pause: N("Paused"), results: N("Results"), settings: N("Settings"), help: N("How to play") };
function overlay(L: Layout, s: Overlay): void {
  const wide = s !== "pause";
  const w = Math.min(wide ? 680 : 430, L.lw - 32);
  const padX = L.narrow ? 18 : 26, padY = L.land ? 14 : 22;
  const inner = w - 2 * padX - 2;
  const maxH = L.lh - (L.land ? 24 : 100);
  const key = `panel-${s}`;
  const prev = lastSize.get(key);
  const footH = (sizeOf(`${key}-foot`, L.sc)?.h ?? 52) + 18;
  const scroll = !!prev && prev.height / L.sc + 2 * padY + footH > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  const isOpen = ui.dialog(T(OVERLAY_LABEL[s]), "", true, () => {
    ui.column("panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildOverlay(s, iw, L), { spacing: 10, width: iw })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + 2, height: maxH - 2 * padY - footH }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
      lastSize.set(`${key}-foot`, ui.column(`${key}-foot`, () => overlayFooter(s, inner), { width: inner, spacing: 8, padding: { top: 6 } }));
    }, { style: "panel", width: w, spacing: 10, padding: { top: padY, bottom: padY, start: padX, end: padX } });
  });
  if (!isOpen && fresh()) {
    if (s === "pause") later(resume);
    else if (s !== "results") later(() => closeOverlay(s));
  }
}
function overlayFooter(s: Overlay, w: number): void {
  switch (s) {
    case "results": {
      const r = app.results;
      flow("results-actions", [
        { id: "btn-results-next", text: T(r?.nextLabel || "Next"), style: "menu-btn-primary", act: resultsNext },
        { id: "btn-retry", text: T("Retry"), act: retry },
        { id: "btn-title", text: T("Title"), act: closeToTitle },
      ], w, 12, "center");
      break;
    }
    case "pause": break;
    default:
      button({ id: "btn-done", text: T("Done"), style: "menu-btn-primary", act: () => closeOverlay(s), width: Math.min(w, buttonWidth(T("Done"), "menu-btn-primary")) });
  }
}
function buildOverlay(s: Overlay, w: number, L: Layout): void {
  switch (s) {
    case "pause": pausePanel(w); break;
    case "results": resultsPanel(w); break;
    case "settings": settingsPanel(w); break;
    case "help": helpPanel(w, L); break;
  }
}
function pausePanel(w: number): void {
  para(T("Paused"), w, "h2", "pause-heading");
  ui.column("pause-stack", () => {
    button({ id: "btn-resume", text: T("Resume"), style: "menu-btn-primary", width: w, act: resume });
    button({ id: "btn-pause-settings", text: T("Settings"), width: w, act: () => openOverlay("settings") });
    button({ id: "btn-pause-help", text: T("Help"), width: w, act: () => openOverlay("help") });
    button({ id: "btn-pause-restart", text: T("Restart board"), width: w, act: restartRound });
    button({ id: "btn-leave", text: T("Leave round"), style: "menu-btn-danger", width: w, act: leaveRound });
  }, { spacing: 8, width: w });
}
const TERMINAL_TEXT: Record<string, string> = {
  "move-limit-exceeded": N("Out of moves."), "time-expired": N("Time ran out."), "no-legal-moves": N("No legal moves remain."), abandoned: N("Round left unfinished."),
};
const MEDAL_TITLE: Record<string, string> = { gold: N("Gold (≤ {n} moves)"), silver: N("Silver (≤ {n} moves)"), bronze: N("Bronze (≤ {n} moves)") };
const medalRank = (m: string | null): number => ({ gold: 0, silver: 1, bronze: 2, clear: 3 } as Record<string, number>)[m ?? ""] ?? 4;
const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n}`;
function resultsPanel(w: number): void {
  const v = app.results;
  if (!v) return;
  const r = v.result, lv = v.level;
  para(T("Results"), w, "h2", "results-heading");
  const headline = r.won
    ? (r.medal === "gold" ? T("A flawless arrangement.") : r.medal === "silver" ? T("Beautifully sorted.") : r.medal === "bronze" ? T("The gallery settles.") : T("Sorted — with room to refine."))
    : T(TERMINAL_TEXT[r.terminalReason ?? ""] ?? "Round over.");
  para(headline, w, "headline", "results-headline");
  ui.row("results-medal", () => {
    for (const m of ["gold", "silver", "bronze"] as const) {
      const earned = r.won && medalRank(r.medal) <= medalRank(m);
      ui.widget(T(MEDAL_TITLE[m]!, { n: lv.par[m] }), {
        role: "image", size: { width: 30, height: 32 },
        draw: (rr, st) => {
          const s = st.scale;
          if (earned) draw.circle(rr.x + rr.width / 2, rr.y + rr.height / 2, 14 * s, m === "gold" ? "#ffd76a40" : m === "silver" ? "#c0c8d840" : "#cd8f5a40");
          draw.text(m === "gold" ? "🥇" : m === "silver" ? "🥈" : "🥉", rr.x + rr.width / 2, rr.y + 3 * s, { size: 22.4 * s, align: "center" });
          if (!earned) draw.circle(rr.x + rr.width / 2, rr.y + rr.height / 2, 14 * s, "#1a1f2ea6");
        },
      });
    }
  }, { spacing: 8, align: "center" });
  const rows: [string, string][] = [[T("Completion"), r.won ? `+${r.base}` : "0"],
    [T("Move efficiency ({moves} moves, par {par})", { moves: r.moves, par: lv.par.gold }), signed(r.efficiency)]];
  if (r.speed) rows.push([T("Speed bonus"), signed(r.speed)]);
  rows.push([T("Medal bonus"), signed(r.medalBonus)]);
  if (r.invalids) rows.push([T("Invalid actions × {n}", { n: r.invalids }), signed(r.invalidPenalty)]);
  if (r.undos) rows.push([T("Undos × {n}", { n: r.undos }), signed(r.undoPenalty)]);
  rows.push([T("Time"), fmtTime(r.elapsedMs)]);
  ui.column("score-table", () => {
    rows.forEach(([k, val], i) => ui.row(`score-${i}`, () => {
      para(k, w - 100, "score-k", `score-${i}-k`);
      ui.spacer();
      ui.style("score-v").id(`score-${i}-v`).label(val);
    }, { style: "score-row", width: w, align: "center" }));
    ui.row("score-total-row", () => {
      ui.style("total-k").label(T("Total"));
      ui.spacer();
      ui.style("total-v").id("score-total").label(String(r.total));
    }, { style: "score-foot", width: w, align: "center" });
  }, { spacing: 0, width: w });
  para(v.progress(), w, "note", "results-progress");
  v.newAchievements.forEach((a, i) => para(`🏆 ${T("Achievement unlocked: {name}", { name: T(a.name) })}`, w, "ok-text", `results-ach-${i}`));
  para(v.board(), w, "note", "results-board-status");
  const lb = v.lb;
  if (lb) para(lb === "posting" ? S("lbPosting") : !lb.posted ? S("lbNotPosted") : lb.rank ? S("lbRank", { rank: lb.rank }) : S("lbPosted"), w, "note", "results-lb");
}
function fieldset(id: string, legend: string, w: number, build: (iw: number) => void): void {
  ui.column(id, () => { para(legend, w - 30, "legend", `${id}-legend`); build(w - 30); }, { style: "fieldset", width: w, spacing: 6 });
}
function settingsPanel(w: number): void {
  const s = settings();
  para(T("Settings"), w, "h2", "settings-heading");
  fieldset("set-audio", T("Audio"), w, (iw) => {
    para(T("Music, effects and mute, graphics quality, language, larger text, high contrast and reduced motion are in the StarHermit Options."), iw, "note", "options-note");
    button({ id: "btn-options", text: T("Open Options"), act: () => openMenu(), width: Math.min(iw, buttonWidth(T("Open Options"), "menu-btn")) });
  });
  fieldset("set-graphics", T("Graphics"), w, (iw) => {
    const cams = ["default", "close", "wide"] as const;
    selectRow("set-camera", T("Camera"), iw, Math.max(0, cams.indexOf(s.camera)), [T("Default"), T("Close"), T("Wide")], (i) => setSetting("camera", cams[i]!));
  });
  fieldset("set-a11y", T("Accessibility"), w, (iw) => {
    const pals = ["default", "cvd", "contrast"] as const;
    selectRow("set-palette", T("Color palette"), iw, Math.max(0, pals.indexOf(s.palette)), [T("Default"), T("Color-vision safe"), T("High contrast")], (i) => setSetting("palette", pals[i]!));
    toggleRow("set-left-handed", T("Left-handed controls"), s.leftHanded, iw, (v) => setSetting("leftHanded", v));
    toggleRow("set-hold-select", T("Hold to select (vs toggle)"), s.holdToSelect, iw, (v) => setSetting("holdToSelect", v));
    toggleRow("set-timing-assist", T("Timing assist (+50% time)"), s.timingAssist, iw, (v) => setSetting("timingAssist", v));
    toggleRow("set-haptics", T("Haptics"), s.haptics, iw, (v) => setSetting("haptics", v));
    button({ id: "btn-replay-tutorial", text: T("Replay tutorial"), style: "text-btn", act: () => { app.overlays = []; startLearn(); } });
  });
  fieldset("set-controls", T("Controls"), w, (iw) => {
    para(T("Keys and gamepad buttons are rebound in the StarHermit Options."), iw, "note", "controls-note");
    button({ id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind(), width: Math.min(iw, buttonWidth(T("Key bindings"), "menu-btn")) });
  });
}
function helpPanel(w: number, L: Layout): void {
  const k = (a: string): string => keyOf(a);
  const cards: [string, string, string | null][] = [
    [T("Goal"), T("Move the top orb between tubes until every tube holds a single color (or is empty). A tube is complete when it is full of one color."), "[● ● ● ●] " + T("← complete")],
    [T("Lift & pour"), T("Select a tube to lift its top orb, then select a target tube. Keyboard: {prev}/{next} to choose, {confirm} to confirm.", { prev: k("prev"), next: k("next"), confirm: k("confirm") }), "[▲] → [▲ ▲]"],
    [T("Matching rule"), T("An orb may only land on an empty tube or on an orb of the same color. Full tubes accept nothing. Invalid attempts explain why."), "[●] ✗→ [▲]"],
    [T("Undo & hints"), T("Undo ({undo}) takes back your last move where the mode allows. Hint ({hint}) suggests a legal move using the same rules engine.", { undo: k("undo"), hint: k("hint") }), null],
    [T("Medals"), T("Finish within par for bronze, silver, or gold. Score = completion + efficiency + speed − penalties. Every component is itemized on the results screen."), null],
    [T("Controls"), T("Pause: {pause} · Restart: {restart} · Camera: {camera} · Gamepad: D-pad moves focus, bottom button confirms.", { pause: k("pause"), restart: k("restart"), camera: k("camera") }), null],
  ];
  para(T("How to play"), w, "h2", "help-heading");
  const gap = 14;
  const cols = L.narrow ? 1 : Math.max(1, Math.floor((w + gap) / (240 + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column("help-cards", () => {
    for (let r = 0; r * cols < cards.length; r++) ui.row(`help-r${r}`, () => {
      for (let i = r * cols; i < Math.min(cards.length, (r + 1) * cols); i++) {
        const [title, body, demo] = cards[i]!;
        ui.column(`help-${i}`, () => {
          para(title, cw - 38, "card-h3", `help-${i}-h`);
          para(body, cw - 38, "card-p", `help-${i}-p`);
          if (demo) ui.style("text", { text: { size: 19.2 } }).label(demo);
        }, { style: "rail", width: cw, spacing: 6, padding: 18 });
      }
    }, { spacing: gap, align: "stretch" });
  }, { spacing: gap, width: w });
}

// ------------------------------------------------------------------ toasts
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const f = frame();
  // during play, lift the toasts above the board-status chips (ui.js placeToasts)
  let bottom = L.lh - 16;
  const strip = lastSize.get("board-status");
  if (app.base === "game" && strip && !app.overlays.length) bottom = Math.max(16, (strip.y - L.oy) / L.sc - 8);
  const size = 14.4 * L.sc * L.ts;
  const lineH = size * 1.3;
  const maxPx = Math.min(520, L.lw - 32) * L.sc - 36 * L.sc;
  const pills = app.toasts.map((t) => ({ t, lines: wrapLines(t.text, maxPx, size) }));
  let y = bottom * L.sc + L.oy;
  for (let i = pills.length - 1; i >= 0; i--) {
    const { t, lines } = pills[i]!;
    const wpx = Math.max(...lines.map((l) => draw.measureText(l, { size, font: "sans-serif" }).width)) + 36 * L.sc;
    const hpx = lines.length * lineH + 20 * L.sc;
    y -= hpx;
    const x = (f.width - wpx) / 2;
    ui.place(`toast-${i}`, { anchor: "top-start", x: (x - L.ox) / L.sc, y: (y - L.oy) / L.sc }, () => {
      ui.widget("", {
        role: "none", size: { width: wpx / L.sc, height: hpx / L.sc },
        draw: (r) => {
          draw.box(r.x, r.y, r.width, r.height, t.warn ? "toast-warn" : "toast");
          lines.forEach((ln, k) => draw.text(ln, r.x + r.width / 2, r.y + 10 * L.sc + k * lineH, { size, color: t.warn ? token("danger") : token("ink"), align: "center", font: "sans-serif" }));
        },
      });
    });
    y -= 8 * L.sc;
  }
}
