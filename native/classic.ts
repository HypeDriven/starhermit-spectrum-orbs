// The browser build's pure game scripts, unchanged and shared with the Node
// tests and server.js: the seeded streams (js/rng.js), the rules
// (js/rules.js), the content (js/content.js: palettes, themes, the 40 Journey
// stages, the Daily, challenges, practice, lessons, achievements), the
// session (js/session.js: command log, undo, replay envelope, snapshots), the
// string tables (js/strings.js, js/sh-strings.js) with their lookup
// (js/lang.js) and the save model (js/progress.js), evaluated as classic
// scripts so their globals are this module's exports.
import { loadClassic } from "starhermit:script";

for (const f of [
  "js/rng.js", "js/rules.js", "js/content.js", "js/session.js",
  "js/strings.js", "js/lang.js", "js/sh-strings.js", "js/progress.js",
]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export interface Par { gold: number; silver: number; bronze: number }
export interface Limits { moves?: number | null; timeMs?: number | null; undo?: boolean }
export interface Level {
  id: string; index?: number; seed: number; colors: number; spare: number; capacity: number; tubeCount: number;
  par: Par; parTimeMs: number | null; theme: string; mechanics: string[]; tutorial: string | null; mastery?: boolean;
  name: string | null; date?: string; ranked?: boolean; limits?: Limits; blurb?: string; stacks?: number[][];
}
export interface State {
  version: number; contentId: string; sessionId: string; seed: number; tick: number; capacity: number; colors: number;
  tubes: number[][]; status: "active" | "won" | "lost"; terminalReason: string | null; moves: number; invalids: number;
  undos: number; hintsUsed: number; elapsedMs: number;
  limits: { moves: number | null; timeMs: number | null; undo: boolean };
  history: { type: string; from?: number; to?: number }[]; undoStack: unknown[];
}
export interface RuleEvent { type: string; from?: number; to?: number; orb?: number; reason?: string; tick?: number }
export interface Result {
  won: boolean; base: number; efficiency: number; speed: number; invalidPenalty: number; undoPenalty: number; medalBonus: number;
  medal: "gold" | "silver" | "bronze" | "clear" | null; moves: number; invalids: number; undos: number; elapsedMs: number; total: number;
  sessionId?: string; terminalReason?: string | null;
}
export interface Dispatch { accepted: boolean; rejected: { reason: string } | null; events: RuleEvent[] }
export interface Hint { from: number; to: number; certain: boolean }
export interface GameSession {
  level: Level; mode: string; state: State; finished: boolean; terminalResult: Result | null; startedAt: number;
  move(from: number, to: number): Dispatch; undo(): Dispatch; concede(): Dispatch; tickClock(): Dispatch | null;
  hint(): Hint | null; score(): Result; pause(): void; resume(): void; readonly paused: boolean;
  snapshot(): string; replayEnvelope(): unknown;
}
export interface Color { key: string; label: string; glyph: string; hex: string }
export interface Theme {
  key: string; name: string; sky: number; fog: number; floor: number; floorAccent: number; wall: number; pedestal: number;
  keyLight: number; keyIntensity: number; hemiSky: number; hemiGround: number; ambience: string; description: string;
}
export interface Lesson { id: string; title: string; body: string; hint: string; expect: { type: string; reason?: string } }
export interface Achievement { key: string; name: string; desc: string }
export interface PracticeDef { key: string; name: string; colors: number; spare: number; capacity: number; seedBase: number }

export interface Progression {
  version: number;
  journey: Record<string, { medal: string | null; moves: number; score: number; at: number }>;
  challenges: Record<string, { score: number; won: boolean; at: number }>;
  dailies: Record<string, { score: number; won: boolean }>;
  streak: { count: number; lastDate: string | null };
  achievements: Record<string, string>;
  stats: { totalCompletions: number; totalMoves: number; practiceRounds: number };
  updatedAt: number;
}
export interface Settings {
  palette: "default" | "cvd" | "contrast"; camera: "default" | "close" | "wide"; leftHanded: boolean; holdToSelect: boolean;
  timingAssist: boolean; haptics: boolean; tutorialDone: boolean;
}
export interface SaveDoc { v: number; progression: Progression; settings: Settings }

interface RulesApi {
  RULESET_VERSION: number; INVALID: Record<string, string>;
  legalActions(s: State): { from: number; to: number }[];
  canMove(s: State, from: number, to: number): { ok: boolean; reason?: string };
  solve(s: State, opts?: { maxNodes?: number }): { from: number; to: number }[] | null;
  stateHash(s: State): string;
}
interface ContentApi {
  CONTENT_VERSION: number; COLOR_DEFS: Color[]; THEMES: Record<string, Theme>; JOURNEY: Level[]; CHALLENGES: Level[];
  PRACTICE: Record<string, PracticeDef>; TUTORIAL: Lesson[]; ACHIEVEMENTS: Achievement[];
  palette(name: string): Color[]; dailyForDate(date: string): Level; practiceLevel(key: string, round: number): Level;
}
interface SessionApi {
  GameSession: {
    new (level: Level, opts: { mode: string; now: () => number }): GameSession;
    restore(json: string, opts: { now: () => number }): GameSession;
    validateReplay(env: unknown): { ok: boolean; reason?: string };
  };
}
export interface RandomStream { float(): number; int(a: number, b: number): number }
interface RngApi { streams(seed: number): { rules: RandomStream; decor: RandomStream; audio: RandomStream }; hashString(s: string): number }
interface I18nApi { LOCALES: string[]; T(key: string, vars?: Record<string, string | number> | null): string; setLocale(tag: string): void; getLang(): string }
interface ProgressApi {
  defaultProgression(): Progression; mergeProgression(a: unknown, b: unknown): Progression; defaultSettings(): Settings;
  legacyPreferences(kv: Record<string, unknown>): Partial<Settings>; isBrowserKey(key: string): boolean;
  fresh(): SaveDoc; migrate(doc: unknown): SaveDoc | null; mergeDocs(remote: unknown, local: unknown): SaveDoc;
  fromBrowserSave(text: string | null): Progression | null;
}

const g = globalThis as unknown as {
  SpectrumRules: RulesApi; SpectrumContent: ContentApi; SpectrumSession: SessionApi; SpectrumRng: RngApi;
  SOI18N: I18nApi; SO_SH_STRINGS: Record<string, Record<string, string>>; SOProgress: ProgressApi;
};
export const Rules = g.SpectrumRules;
export const Content = g.SpectrumContent;
export const Session = g.SpectrumSession;
export const Rng = g.SpectrumRng;
export const I18n = g.SOI18N;
export const ShStrings = g.SO_SH_STRINGS;
export const Progress = g.SOProgress;
