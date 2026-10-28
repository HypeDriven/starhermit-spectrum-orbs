// Spectrum Orbs on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js)
// and session (js/session.js) are the browser build's, unchanged; this module
// is what js/main.js did around them — the state machine (title → modes /
// setup → countdown → active ⇄ paused → resolving → results, plus scores and
// profile), every mode (Learn's five lessons, Journey, Daily, Practice,
// Challenge, Score chase), lifting and pouring by keys, pads, pointer, touch,
// the tube labels and the board-status chips, hold to select, undo, the hint,
// invalid-move explanations, the countdown, timed boards, the results with
// medals, achievements, the local personal-best boards and the platform score
// post, resuming an unfinished round, and the lifecycle (a hidden window
// pauses the round's clock, as visibilitychange did). Screens are drawn by
// screens.ts (starhermit:ui), the gallery by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the session's clock (GameSession's
// `now`), the countdown, the 0.42 s move resolution that locks input, the
// timed boards' 250 ms clock tick, the music's 600 ms beat, the toast, hint,
// invalid-reason and lesson hand-off timers and the results' short wait all
// run on a clock advanced 1/60 s per fixed step (the browser build used
// Date.now, setTimeout and setInterval), so slow frames never change a round
// and play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  Content, Rng, Rules, Session, type Achievement, type Color, type GameSession, type Level, type RandomStream, type Result, type Settings,
} from "./classic.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Base = "title" | "modes" | "setup" | "game" | "scores" | "profile";
export type Overlay = "pause" | "results" | "settings" | "help";
export type Fsm = "title" | "mode-select" | "setup" | "preparing" | "countdown" | "active" | "paused" | "resolving" | "results" | "scores" | "progression";

export interface ResultsView {
  result: Result; level: Level; mode: string; progress: () => string; board: () => string;
  newAchievements: Achievement[]; nextLabel: string; next: () => void; lb: platform.Posted | "posting" | null;
}
export interface SetupView { kind: "journey" | "practice" | "challenge"; level: Level | null }

/** Authored boards for the five interactive lessons (main.js LEARN_BOARDS). */
const LEARN_BOARDS = [
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 1], [1, 0], []], capacity: 2, colors: 2, tubeCount: 3 },
  { stacks: [[0, 0], [1], [1]], capacity: 2, colors: 2, tubeCount: 3 },
];

export const app = {
  base: "title" as Base,
  overlays: [] as Overlay[],
  fsm: "title" as Fsm,
  openedFrame: 0,
  focusNext: null as string | null,
  setup: null as SetupView | null,
  practiceDifficulty: "standard",
  results: null as ResultsView | null,
  toasts: [] as { text: string; warn: boolean; until: number; key?: string }[],
  invalidReason: "",
  railOpen: null as "left" | "right" | null,
  scoresBoard: "",
  scoresFriends: false,
  scoresData: null as { entries: { player: string; score: number; seed: number | null; durationMs: number | null }[]; casual: boolean; note?: string } | null,
  resumeSnap: null as ({ level: Level; finished?: boolean } & Record<string, unknown>) | null,
};
export const game = {
  session: null as GameSession | null,
  level: null as Level | null,
  mode: "",
  palette: [] as Color[],
  selected: -1,
  kbFocus: -1,
  inputLocked: false,
  tutorialIndex: -1,
  holdSource: -1,
  hint: null as { from: number; to: number } | null,
  audioRng: null as RandomStream | null,
};

let clockMs = 0;
export const now = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;
const timers: { at: number; fn: () => void; tag?: string }[] = [];
/** setTimeout on the fixed-step clock (a tag replaces the pending timer of that tag). */
function after(ms: number, fn: () => void, tag?: string): void {
  if (tag) for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.tag === tag) timers.splice(i, 1);
  timers.push({ at: clockMs + ms, fn, ...(tag ? { tag } : {}) });
}
function cancel(tag: string): void { for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.tag === tag) timers.splice(i, 1); }

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
/** The live regions (#live-region, #alert-region): joined, one announcement a frame. */
export function announce(text: string): void { if (text) spoken.push(text); }
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text); } catch { /* busy */ }
}
/** ui.js toast (3.6 s; keyed toasts replace the previous one of their key). */
export function toast(text: string, warn = false, opts: { key?: string; ms?: number } = {}): void {
  if (opts.key) app.toasts = app.toasts.filter((t) => t.key !== opts.key);
  app.toasts.push({ text, warn, until: clockMs + (opts.ms ?? 3600), ...(opts.key ? { key: opts.key } : {}) });
  if (app.toasts.length > 4) app.toasts.shift();
}
export function sound(ev: audio.Sfx): void { audio.play(ev); }
function haptic(ms: number): void {
  if (!settings().haptics) return;
  try { vibrate(ms); } catch { /* none */ }
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
export const settings = (): Settings => platform.settings();
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings()[key] = value;
  platform.persist();
  applySettings();
}
export function fmtTime(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** ui.js levelName: content names are English data. */
export function levelName(lv: Level | null): string {
  if (!lv) return "";
  if (/^daily-/.test(lv.id) && lv.date) return T("Daily — {date}", { date: lv.date });
  const pm = /^practice-(\w+)-/.exec(lv.id || "");
  if (pm && Content.PRACTICE[pm[1]!]) return T("{name} Practice", { name: T(Content.PRACTICE[pm[1]!]!.name) });
  return lv.name ? T(lv.name) : lv.id;
}
export function colorName(c: Color | undefined): string { return c ? T(c.label) : "?"; }

// ------------------------------------------------------------------ the state machine (main.js setState)
const SCREEN_OF: Record<Fsm, Base> = {
  title: "title", "mode-select": "modes", setup: "setup", preparing: "game", countdown: "game", active: "game",
  paused: "game", resolving: "game", results: "game", scores: "scores", progression: "profile",
};
export function setState(next: Fsm, reason: string): void {
  const prev = app.fsm;
  app.fsm = next;
  showBase(SCREEN_OF[next]);
  if (next === "paused") openOverlay("pause");
  if (prev === "paused" && next === "active") closeOverlay("pause");
  void reason;
}
const FIRST: Partial<Record<Base | Overlay, string>> = {
  title: "btn-play", modes: "mode-journey", setup: "btn-begin", scores: "btn-back", profile: "btn-back",
  pause: "btn-resume", results: "btn-results-next", settings: "btn-done", help: "btn-done",
};
function focusFor(name: Base | Overlay): void {
  app.openedFrame = frame().frame;
  const coarse = frame().width / Math.max(0.01, ui.preferences().scale) <= 700;
  app.focusNext = coarse ? null : FIRST[name] ?? null;
  ui.setFocus(null);
}
export function showBase(name: Base): void {
  if (app.base !== name) { app.railOpen = null; }
  app.base = name;
  render.setActive(name === "game");
  focusFor(name);
}
export function openOverlay(name: Overlay): void {
  if (!app.overlays.includes(name)) app.overlays.push(name);
  focusFor(name);
}
export function closeOverlay(name?: Overlay): void {
  const top = name ?? app.overlays[app.overlays.length - 1];
  if (!top) return;
  app.overlays = app.overlays.filter((n) => n !== top);
  app.openedFrame = frame().frame;
  app.focusNext = null;
  ui.setFocus(null);
}
export function closeAllOverlays(): void { app.overlays = []; app.openedFrame = frame().frame; ui.setFocus(null); }
export const topOverlay = (): Overlay | null => app.overlays[app.overlays.length - 1] ?? null;

// ------------------------------------------------------------------ mode setup
export function setupJourney(): void {
  const done = platform.progression().journey;
  const next = Content.JOURNEY.find((l) => !done[l.id]) ?? Content.JOURNEY[Content.JOURNEY.length - 1]!;
  app.setup = { kind: "journey", level: next };
  game.mode = "journey";
  setState("setup", "journey-selected");
}
export function setupPractice(): void {
  app.setup = { kind: "practice", level: null };
  game.mode = "practice";
  setState("setup", "practice-selected");
}
export function setupChallenge(): void {
  app.setup = { kind: "challenge", level: Content.CHALLENGES[0]! };
  game.mode = "challenge";
  setState("setup", "challenge-selected");
}
export function beginPending(): void {
  const s = app.setup;
  if (!s) return;
  if (s.kind === "practice") startPractice();
  else if (s.level) startLevel(s.level, s.kind);
}

// ------------------------------------------------------------------ sessions
const sessionNow = (): number => clockMs;
export function startLevel(level: Level, mode: string, opts: { skipCountdown?: boolean } = {}): void {
  closeTransient();
  const eff: Level = { ...level };
  // timing assist: the accessibility option, declared with every submission
  if (settings().timingAssist && eff.limits && eff.limits.timeMs) eff.limits = { ...eff.limits, timeMs: Math.floor(eff.limits.timeMs * 1.5) };
  game.session = new Session.GameSession(eff, { mode, now: sessionNow });
  game.level = eff;
  game.mode = mode;
  game.selected = -1; game.kbFocus = -1; game.inputLocked = false; game.holdSource = -1; game.hint = null;
  const streams = Rng.streams(eff.seed);
  game.audioRng = streams.audio;
  game.palette = Content.palette(settings().palette);
  render.build(game.session.state, Content.THEMES[eff.theme]!, game.palette, streams.decor);
  render.setCameraPreset(settings().camera);
  app.invalidReason = "";
  setState("preparing", "level-ready");
  audio.stopAmbience();
  audio.resetMusic();
  audio.startAmbience(eff.theme);
  if (opts.skipCountdown) setState("active", "resume");
  else runCountdown();
  persistRound();
}
function runCountdown(): void {
  setState("countdown", "begin");
  const rm = preferences().reducedMotion;
  const seq = rm ? [T("Go")] : ["3", "2", "1", T("Go")];
  seq.forEach((s, i) => {
    after(i * (rm ? 200 : 650), () => {
      if (app.fsm !== "countdown") return;
      announce(s);
      toast(s, false, { key: "countdown", ms: i === seq.length - 1 ? 900 : 700 });
      if (i === seq.length - 1) setState("active", "countdown-complete");
    }, `countdown-${i}`);
  });
}
export function startDaily(): void { startLevel(Content.dailyForDate(platform.utcDate()), "daily"); }
export function startPractice(): void {
  const round = platform.progression().stats.practiceRounds || 0;
  startLevel(Content.practiceLevel(app.practiceDifficulty, round), "practice");
}
export function startLearn(): void { game.tutorialIndex = 0; startLesson(); }
function startLesson(): void {
  const board = LEARN_BOARDS[game.tutorialIndex]!;
  const step = Content.TUTORIAL[game.tutorialIndex]!;
  const level: Level = {
    id: `learn-${game.tutorialIndex}`, seed: 100 + game.tutorialIndex,
    colors: board.colors, spare: board.tubeCount - board.colors, capacity: board.capacity,
    tubeCount: board.tubeCount, stacks: board.stacks,
    par: { gold: 6, silver: 9, bronze: 14 }, parTimeMs: null,
    theme: "atrium", mechanics: ["move", "undo", "hint"], tutorial: step.id, name: step.title,
  };
  startLevel(level, "learn", { skipCountdown: true });
}
function advanceTutorial(): void {
  game.tutorialIndex++;
  if (game.tutorialIndex >= Content.TUTORIAL.length) {
    game.tutorialIndex = -1;
    setSetting("tutorialDone", true);
    persistRoundClear();
    closeToTitle();
    toast(T("Lessons complete — welcome to the gallery."));
    return;
  }
  startLesson();
}
export function skipLesson(): void { advanceTutorial(); }
export function resumeSnapshot(): void {
  const snap = app.resumeSnap;
  app.resumeSnap = null;
  if (!snap) return;
  try {
    closeTransient();
    const s = Session.GameSession.restore(JSON.stringify(snap), { now: sessionNow });
    game.session = s;
    game.level = s.level;
    game.mode = s.mode;
    game.selected = -1; game.kbFocus = -1; game.inputLocked = false; game.holdSource = -1; game.hint = null;
    game.tutorialIndex = -1;
    game.palette = Content.palette(settings().palette);
    const streams = Rng.streams(s.level.seed);
    game.audioRng = streams.audio;
    render.build(s.state, Content.THEMES[s.level.theme]!, game.palette, streams.decor);
    render.setCameraPreset(settings().camera);
    setState("active", "reconnect");
    audio.stopAmbience(); audio.resetMusic(); audio.startAmbience(s.level.theme);
    toast(T("Session restored from snapshot."));
  } catch {
    platform.clearRound();
    toast(T("Saved round was corrupted and has been cleared."), true);
  }
}
export function restartRound(): void {
  if (!game.level) return;
  closeAllOverlays();
  if (game.mode === "learn") { startLesson(); return; }
  const level = game.mode === "practice"
    ? Content.practiceLevel(app.practiceDifficulty, platform.progression().stats.practiceRounds || 0)
    : game.level;
  startLevel(level, game.mode);
}
export function leaveRound(): void {
  if (game.session && game.session.state.status === "active") game.session.concede();
  closeAllOverlays();
  if (game.mode === "learn") { closeToTitle(); return; }
  finishRound();
}
export function closeToTitle(): void {
  closeAllOverlays();
  if (game.session && game.session.state.status === "active") persistRound();
  game.session = null;
  game.tutorialIndex = -1;
  for (const t of [...timers]) if (t.tag?.startsWith("countdown") || t.tag === "results" || t.tag === "settle" || t.tag === "lesson") cancel(t.tag);
  audio.stopAmbience();
  render.clearSparks();
  refreshResume();
  setState("title", "user");
}
function closeTransient(): void { closeAllOverlays(); app.setup = app.setup; cancel("results"); cancel("lesson"); cancel("settle"); }
/** The last unfinished round's snapshot, offered on the title (main.js boot). */
function refreshResume(): void {
  const snap = platform.loadRound<{ level: Level; finished?: boolean } & Record<string, unknown>>();
  app.resumeSnap = snap && !snap.finished && snap.level ? snap : null;
}

// ------------------------------------------------------------------ input (main.js onTubePick …)
export const canPlay = (): boolean => !!game.session && app.fsm === "active" && game.session.state.status === "active";
export function onTubePickDown(i: number | null): void {
  // hold versus toggle: in hold mode, press-and-hold selects the source
  if (settings().holdToSelect && canPlay() && i !== null && i >= 0 && game.session!.state.tubes[i]!.length) {
    game.holdSource = i;
    selectTube(i);
  }
}
export function onTubePick(i: number | null): void {
  if (!canPlay()) return;
  const st = game.session!.state;
  if (settings().holdToSelect && game.holdSource >= 0) {
    const src = game.holdSource;
    game.holdSource = -1;
    if (i === null || i === src) { deselect(); return; }
    tryMove(src, i);
    return;
  }
  if (i === null || i < 0) { deselect(); return; }
  if (game.selected < 0) {
    if (!st.tubes[i]!.length) { explainInvalid(i, Rules.INVALID.EMPTY_SOURCE!); return; }
    selectTube(i);
  } else if (i === game.selected) deselect();
  else tryMove(game.selected, i);
}
function selectTube(i: number): void {
  const st = game.session!.state;
  game.selected = i;
  game.kbFocus = i;
  render.select(i);
  render.previewTargets(Rules.legalActions(st), i);
  const tube = st.tubes[i]!;
  const color = game.palette[tube[tube.length - 1]!];
  announce(T("Tube {n} selected, top orb {color}", { n: i + 1, color: color ? colorName(color) : "" }));
  sound("pick");
}
export function deselect(): void {
  game.selected = -1;
  render.select(-1);
  render.previewTargets(null);
}
function tryMove(from: number, to: number): void {
  if (game.inputLocked || !canPlay()) return;
  const s = game.session!;
  const r = s.move(from, to);
  persistRound();
  if (!r.accepted) { explainInvalid(to, r.rejected?.reason ?? ""); return; }
  game.inputLocked = true; // locked only for the resolution animation
  const evt = r.events.find((e) => e.type === "move")!;
  const target = s.state.tubes[to]!;
  const completed = target.length === s.state.capacity && target.every((c) => c === target[0]);
  deselect();
  render.animateMove(evt);
  after(preferences().reducedMotion ? 0 : 420, () => {
    game.inputLocked = false;
    if (game.session !== s) return;
    render.syncState(s.state);
    sound(completed ? "tube-complete" : "drop");
    if (completed) {
      render.burst(to, game.palette[target[0]!]?.hex ?? "#ffffff", 60, false);
      announce(T("Tube {n} complete: {color}", { n: to + 1, color: colorName(game.palette[target[0]!]) }));
    }
    haptic(12);
    audio.setProgress(progressFraction());
    checkTutorialProgress("move");
    if (s.state.status !== "active") finishRound();
  }, "settle");
}
const INVALID_TEXT: Record<string, string> = {
  terminal: N("This round has ended."), "out-of-bounds": N("That tube does not exist."), "empty-source": N("That tube is empty — nothing to lift."),
  "same-tube": N("Selection cleared."), "target-full": N("That tube is full."), "color-mismatch": N("Colors must match — pour onto the same color or an empty tube."),
  "undo-disabled": N("Undo is disabled in this mode."), "hint-disabled": N("Hints are not available in this mode."), "nothing-to-undo": N("Nothing to undo."),
  "duplicate-command": N("Already applied."),
};
export function invalidText(reason: string): string { return T(INVALID_TEXT[reason] ?? N("That move is not legal.")); }
function explainInvalid(tube: number, reason: string): void {
  app.invalidReason = reason;
  announce(invalidText(reason));
  sound("invalid");
  render.invalidFeedback(tube);
  haptic(70);
  after(3200, () => { app.invalidReason = ""; }, "invalid");
  if (game.mode === "learn") checkTutorialProgress("invalid", reason);
}
export function canUndo(): boolean {
  const st = game.session?.state;
  return !!st && st.limits.undo && st.undoStack.length > 0 && st.status === "active";
}
export function doUndo(): void {
  if (!canPlay()) return;
  const s = game.session!;
  const r = s.undo();
  persistRound();
  if (!r.accepted) { explainInvalid(game.selected >= 0 ? game.selected : 0, r.rejected?.reason ?? ""); return; }
  deselect();
  render.syncState(s.state);
  sound("undo");
  announce(T("Move undone. {n} moves played.", { n: s.state.moves }));
  checkTutorialProgress("undo");
}
export function doHint(): void {
  if (!canPlay()) return;
  if (!game.level!.mechanics.includes("hint")) { explainInvalid(0, "hint-disabled"); return; }
  const h = game.session!.hint();
  if (!h) { toast(T("No hint available.")); return; }
  game.hint = h;
  render.setHint(h);
  sound("hint");
  announce(T(h.certain ? "Hint: try pouring tube {from} onto tube {to}" : "Hint: try pouring tube {from} onto tube {to} (suggestion)", { from: h.from + 1, to: h.to + 1 }));
  toast(T("Hint: tube {from} → tube {to}", { from: h.from + 1, to: h.to + 1 }));
  after(5000, () => { game.hint = null; render.setHint(null); }, "hint");
}
export function resetCamera(): void { render.resetCamera(); }
function moveKbFocus(dir: number): void {
  const n = game.session ? game.session.state.tubes.length : 0;
  if (!n) return;
  game.kbFocus = ((game.kbFocus < 0 ? (dir > 0 ? -1 : n) : game.kbFocus) + dir + n) % n;
  sound("focus");
  announce(T("Tube {n} focused", { n: game.kbFocus + 1 }));
}
export function pause(): void {
  if (app.fsm !== "active" || !game.session) return;
  game.session.pause();
  setState("paused", "user");
  persistRound();
}
export function resume(): void {
  if (app.fsm !== "paused" || !game.session) return;
  game.session.resume();
  setState("active", "user");
}

// keys and pads (main.js onKey / pollGamepad, through the runtime's actions)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (app.overlays.length) {
    if (!fresh()) return;
    if (a === "cancel" || (a === "pause" && topOverlay() === "pause")) {
      later(() => {
        if (topOverlay() === "results") return;
        closeOverlay();
        if (app.fsm === "paused" && !app.overlays.length) resume();
      });
    }
    return;
  }
  if (app.fsm !== "active" && app.fsm !== "countdown") {
    if (a === "cancel" && fresh() && (app.base === "modes" || app.base === "setup" || app.base === "scores" || app.base === "profile")) later(goBack);
    return;
  }
  // Enter / Space and arrows on a focused button (a chip, a rail action) are the button's
  if (ui.focused() !== null && (a === "confirm" || a === "prev" || a === "next")) return;
  switch (a) {
    case "prev": later(() => { ui.setFocus(null); moveKbFocus(-1); }); break;
    case "next": later(() => { ui.setFocus(null); moveKbFocus(1); }); break;
    case "confirm": later(() => onTubePick(game.kbFocus >= 0 ? game.kbFocus : 0)); break;
    case "cancel": later(() => { if (game.selected >= 0) deselect(); else pause(); }); break;
    case "pause": later(pause); break;
    case "undo": later(doUndo); break;
    case "hint": later(doHint); break;
    case "restart": later(restartRound); break;
    case "camera": later(resetCamera); break;
  }
});
/** The screens' ← Back (the old back links went to the title or All Modes). */
export function goBack(): void {
  if (app.base === "setup") setState("mode-select", "user");
  else setState("title", "user");
}

// pointer and touch (render.js _bindPointer: tap vs drag by 12 px / 600 ms)
/** The playfield's uncovered rectangle (render.js _safeRect) in window pixels, set by screens.ts. */
export const view: render.Rect = { x: 0, y: 0, width: 1, height: 1 };
/** The playfield's own rectangle (#playfield), window pixels. */
export const field: render.Rect = { x: 0, y: 0, width: 1, height: 1 };
interface Press { kind: "down" | "move" | "up" | "cancel"; x: number; y: number }
const presses: Press[] = [];
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = clockMs;
  if (!e.primary) return;
  presses.push({ kind: e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel", x: e.x, y: e.y });
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  presses.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y });
});
onPointerMove((x, y) => { if (clockMs - lastTouch >= 600) presses.push({ kind: "move", x, y }); });
let down: { x: number; y: number; t: number } | null = null;
/** Set by screens.ts when a widget took a press this frame (its taps are not the board's). */
export const frameFlags = { widgetPress: false };
function pointerInput(wasPlaying: boolean): void {
  const list = presses.splice(0);
  const inField = (p: Press): boolean => p.x >= field.x && p.y >= field.y && p.x <= field.x + field.width && p.y <= field.y + field.height;
  for (const p of list) {
    if (p.kind === "move") {
      if (field.width > 1 && inField(p)) render.setPointer(((p.x - field.x) / field.width) * 2 - 1, -(((p.y - field.y) / field.height) * 2 - 1));
      continue;
    }
    if (p.kind === "down") {
      down = null;
      if (!wasPlaying || app.base !== "game" || app.overlays.length || !inField(p) || ui.pointerOver() || frameFlags.widgetPress) continue;
      down = { x: p.x, y: p.y, t: clockMs };
      onTubePickDown(render.pickTube(p.x, p.y));
      continue;
    }
    if (!down) continue;
    const d = down;
    down = null;
    if (p.kind === "cancel") continue;
    const dist = Math.hypot(p.x - d.x, p.y - d.y) / frame().scale;
    if (dist > 12 || clockMs - d.t > 600) continue;
    ui.setFocus(null);
    onTubePick(render.pickTube(p.x, p.y));
  }
}

// ------------------------------------------------------------------ lifecycle helpers
function progressFraction(): number {
  const st = game.session?.state;
  if (!st) return 0;
  let done = 0;
  for (const t of st.tubes) if (t.length === st.capacity && t.every((c) => c === t[0])) done++;
  return done / st.colors;
}
function checkTutorialProgress(actionType: string, reason?: string): void {
  if (game.mode !== "learn" || game.tutorialIndex < 0) return;
  const step = Content.TUTORIAL[game.tutorialIndex]!;
  const ex = step.expect;
  let pass = false;
  if (ex.type === "any" && actionType === "move") pass = true;
  else if (ex.type === actionType && (!ex.reason || ex.reason === reason)) pass = true;
  else if (ex.type === "win" && game.session!.state.status === "won") pass = true;
  if (pass) {
    toast(`✓ ${T(step.title)}`);
    const idx = game.tutorialIndex;
    after(700, () => { if (game.mode === "learn" && game.tutorialIndex === idx) advanceTutorial(); }, "lesson");
  }
}
function persistRound(): void {
  if (!game.session) return;
  try { platform.saveRound(JSON.parse(game.session.snapshot())); } catch { /* storage full: play continues without resume */ }
}
function persistRoundClear(): void { platform.clearRound(); }

// ------------------------------------------------------------------ finishing (main.js finishRound)
function unlock(key: string, got: Achievement[]): void {
  const p = platform.progression();
  if (p.achievements[key]) return;
  p.achievements[key] = new Date(platform.nowMs()).toISOString();
  const def = Content.ACHIEVEMENTS.find((a) => a.key === key);
  if (def) got.push(def);
}
function finishRound(): void {
  const s = game.session;
  if (!s || (!s.finished && s.state.status === "active")) return;
  if (game.mode === "learn") {
    if (s.state.status === "lost") {
      toast(T("That board locked up — let’s try the lesson again."), true);
      startLesson();
    }
    return;
  }
  if (app.fsm === "resolving" || app.fsm === "results") return;
  setState("resolving", "terminal");
  const result = s.terminalResult ?? s.score();
  const won = result.won;
  if (won) { render.celebrate(); sound("win"); } else sound("lose");
  const level = game.level!, mode = game.mode;
  const showResults = (): void => {
    if (game.session !== s) return;
    const prog = platform.progression();
    const got: Achievement[] = [];
    const date = platform.utcDate();
    if (won) {
      prog.stats.totalCompletions++;
      prog.stats.totalMoves += result.moves;
      if (mode === "journey") {
        const prev = prog.journey[level.id];
        if (!prev || result.total > prev.score) prog.journey[level.id] = { medal: result.medal, moves: result.moves, score: result.total, at: Date.now() };
        if (Object.keys(prog.journey).length >= 10) unlock("tube_master", got);
      }
      if (mode === "daily") {
        prog.dailies[date] = { score: result.total, won: true };
        const yesterday = new Date(platform.nowMs() - 86400000).toISOString().slice(0, 10);
        prog.streak.count = prog.streak.lastDate === date ? prog.streak.count : (prog.streak.lastDate === yesterday ? prog.streak.count + 1 : 1);
        prog.streak.lastDate = date;
        if (prog.streak.count >= 3) unlock("daily_streak_3", got);
      }
      if (mode === "challenge") {
        const prev = prog.challenges[level.id];
        if (!prev || result.total > prev.score) prog.challenges[level.id] = { score: result.total, won: true, at: Date.now() };
        if (level.id === "challenge-crowded") unlock("hard_milestone", got);
      }
      unlock("first_completion", got);
      if (prog.stats.totalCompletions >= 50) unlock("long_haul", got);
    }
    prog.updatedAt = platform.nowMs();
    platform.persist();
    let boardText = (): string => "";
    const ranked = won && ["daily", "challenge", "journey"].includes(mode);
    if (ranked) {
      const board = mode === "daily" ? `daily:${date}` : mode === "challenge" ? level.id : "journey";
      platform.submitRecord({
        game: "spectrum-orbs", board, score: result.total, rulesetVersion: Rules.RULESET_VERSION, contentVersion: Content.CONTENT_VERSION,
        seed: s.state.seed, assists: { hints: s.state.hintsUsed, undos: result.undos, timingAssist: settings().timingAssist },
        durationMs: result.elapsedMs, sessionId: result.sessionId ?? s.state.sessionId,
        player: platform.signedIn() ? platform.displayName() || null : null, at: platform.nowMs(),
      });
      const hosted = platform.signedIn();
      boardText = () => (hosted ? T("Personal best recorded on this device and synced to your account.") : T("Saved to the local board (offline)."));
    }
    persistRoundClear();
    const done = Object.keys(prog.journey).length, streak = prog.streak.count;
    const next = nextRecommendation(mode, level);
    const view: ResultsView = {
      result, level, mode, newAchievements: got, nextLabel: next.label, next: next.fn, lb: null, board: boardText,
      progress: mode === "journey" ? () => T("Journey: {done} / {total} stages complete.", { done, total: Content.JOURNEY.length })
        : mode === "daily" ? () => T("Daily streak: {n} day(s).", { n: streak }) : () => "",
    };
    app.results = view;
    openOverlay("results");
    setState("results", "round-end");
    announce(T(won ? "Round complete. Score {n}." : "Round over. Score {n}.", { n: result.total }));
    if (ranked && platform.signedIn()) {
      view.lb = "posting";
      void platform.postScore(result.total).then((r) => { view.lb = r; });
    }
  };
  // let the win animation land before the overlay (resolving)
  after(won && !preferences().reducedMotion ? 900 : 150, showResults, "results");
}
function nextRecommendation(mode: string, level: Level): { label: string; fn: () => void } {
  const prog = platform.progression();
  if (mode === "journey") {
    const next = Content.JOURNEY.find((l) => !prog.journey[l.id]);
    if (next) return { label: N("Next stage"), fn: () => startLevel(next, "journey") };
  }
  if (mode === "practice") return {
    label: N("New practice board"),
    fn: () => { prog.stats.practiceRounds = (prog.stats.practiceRounds || 0) + 1; platform.persist(); startPractice(); },
  };
  if (mode === "daily") return { label: N("Practice a board"), fn: setupPractice };
  if (mode === "challenge") {
    const next = Content.CHALLENGES.find((c) => !(prog.challenges[c.id] && prog.challenges[c.id]!.won));
    if (next && next.id !== level.id) return { label: N("Next trial"), fn: () => startLevel(next, "challenge") };
  }
  return { label: N("Back to title"), fn: closeToTitle };
}
export function resultsNext(): void {
  const fn = app.results?.next;
  closeAllOverlays();
  app.results = null;
  if (fn) fn(); else closeToTitle();
}
export function retry(): void { closeAllOverlays(); app.results = null; restartRound(); }

// ------------------------------------------------------------------ scores and profile
export function scoreBoards(): [string, string][] {
  const list: [string, string][] = [
    [`daily:${platform.utcDate()}`, T("Daily (today)")],
    ["journey", T("Journey (all stages)")],
    ...Content.CHALLENGES.map((c) => [c.id, T(c.name!)] as [string, string]),
  ];
  if (platform.signedIn()) list.unshift(["platform", T("Global (platform)")]);
  return list;
}
let scoresSeq = 0;
/** platform.js leaderboard: the platform board when hosted, else (or when it is unavailable) the local records. */
export function loadScores(): void {
  const board = app.scoresBoard, friends = app.scoresFriends;
  const local = (): void => {
    const entries = platform.localBoard(board).map((e) => ({ player: e.player || "", score: e.score, seed: e.seed, durationMs: e.durationMs }));
    app.scoresData = { entries, casual: true };
  };
  if (board !== "platform" || !platform.signedIn()) { local(); return; }
  const req = ++scoresSeq;
  app.scoresData = { entries: [], casual: false, note: N("Platform leaderboard — read-only. Your personal bests are stored with your account.") };
  void platform.platformEntries(friends).then((rows) => {
    if (req !== scoresSeq) return;
    if (!rows) { local(); return; }
    app.scoresData = { entries: rows.map((r) => ({ ...r, seed: null, durationMs: null })), casual: false, note: N("Platform leaderboard — read-only. Your personal bests are stored with your account.") };
  });
}
export function openScores(): void {
  const boards = scoreBoards();
  if (!boards.some(([id]) => id === app.scoresBoard)) app.scoresBoard = boards[0]![0];
  loadScores();
  setState("scores", "scores");
}
export function openProfile(): void { setState("progression", "profile"); }
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("copied")); } catch { toast(`${S("copyFailed")}: ${link}`, true); }
}

// ------------------------------------------------------------------ settings (main.js applySettings)
let paletteKey = "";
function applySettings(): void {
  const s = settings();
  render.setReducedMotion(preferences().reducedMotion);
  render.setCameraPreset(s.camera);
  if (s.palette !== paletteKey) {
    const first = paletteKey === "";
    paletteKey = s.palette;
    if (!first && game.session) { game.palette = Content.palette(s.palette); render.setPalette(game.palette); }
  }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
let step = 0;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  step++;
  render.tick(1 / 60);
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i]!;
    if (clockMs >= t.at) { timers.splice(i--, 1); t.fn(); }
  }
  const s = game.session;
  if (s && app.base === "game") {
    // the HUD's 250 ms tick: timed boards check their clock
    if (step % 15 === 0 && s.state.limits.timeMs !== null && s.state.status === "active" && !s.paused) {
      s.tickClock();
      if (s.state.status !== "active") finishRound();
    }
    if (step % 36 === 0 && game.audioRng && app.fsm !== "paused") audio.musicStep(game.audioRng, game.audioRng);
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applySettings();
  refreshResume();
  setState("title", "boot-complete");
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(applySettings);
platform.onProgressMerged(() => toast(T("Progress synced from your account.")));
onSessionEnded(() => toast(S("signedOut")));
let awayAt = 0;
onSuspend(() => {
  hidden = true;
  awayAt = Date.now();
  if (game.session && app.fsm === "active") game.session.pause();
  audio.setSuspended(true);
  persistRound();
  platform.flush();
});
onResume(() => {
  hidden = false;
  if (game.session && app.fsm === "active") game.session.resume();
  audio.setSuspended(false);
  if (awayAt && Date.now() - awayAt > 30000 && game.session) toast(T("Welcome back — away {time}, clock was paused.", { time: fmtTime(Date.now() - awayAt) }));
  awayAt = 0;
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update();
  app.toasts = app.toasts.filter((x) => x.until > clockMs);
});
onRender(() => {
  const wasPlaying = canPlay();
  frameFlags.widgetPress = false;
  const f = frame();
  render.update(frameDt, f.width, f.height, view, ui.preferences().scale);
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  flushAnnouncements();
});
