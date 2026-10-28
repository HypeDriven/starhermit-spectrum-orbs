// The game's data and the StarHermit platform, on the runtime's modules (what
// js/platform.js did over the JS SDK and localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is js/progress.js's document { v, progression,
//   settings }: the browser build's progression (journey records, challenge
//   bests, dailies, streak, achievements, stats) plus the game's own
//   preferences. Two devices' saves merge on a conflict with
//   Progress.mergeDocs (best of both, nothing dropped; this device's
//   preferences), as the browser build merged on its saveconflict. The slot
//   the browser build wrote through the JS SDK (game:<slug>: the checksummed
//   progression JSON) shows as foreign: it is merged in and replaced once;
// - the browser build's copies of the preferences in the account's settings
//   KV (SYNCED_SETTINGS) are adopted once (the platform's value won there
//   too), then every old key is removed (volumes, mute, graphics, reduced
//   motion, contrast, larger text and the language are the runtime's Options);
// - on this device only, as before: the personal-best boards
//   (board:<id>, platform.js submitScore: the top 50 records with seed,
//   assists, duration and versions) and the last unfinished round's snapshot
//   (round: GameSession.snapshot, offered as Resume on the title);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   won ranked round's total through score-script.js (a practice session whose
//   socket carries { type: 'result', scores }, as the JS SDK's submitScores
//   did) with the rank, and the high-score board's entries (all or friends).
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as kv, storage } from "starhermit:storage";
import { Progress, type Progression, type SaveDoc, type Settings } from "./classic.ts";

// --- the save --------------------------------------------------------------------------------
let doc: SaveDoc = Progress.fresh();
let lastSavedAt = 0;
let hadSave = false;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** Canonical JSON (sorted keys): saves compare equal whatever their key order. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}
function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(JSON.parse(JSON.stringify(doc)) as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
export function save(): SaveDoc { return doc; }
export function progression(): Progression { return doc.progression; }
export function settings(): Settings { return doc.settings; }
/** Saves (the device at once, the account debounced by the runtime). */
export function persist(): void { write(); }
/** Progress.mergeDocs(other, this device's); true when the progression changed. */
function adopt(other: unknown): boolean {
  const next = Progress.mergeDocs(other, doc);
  if (canon(next) === canon(doc)) return false;
  const grew = canon(next.progression) !== canon(doc.progression);
  doc = next;
  write();
  return grew;
}
saves.onConflict((mine, remote) => ({ merged: Progress.mergeDocs(remote.data, mine?.data ?? null) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud progression: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const prev = Progress.fromBrowserSave(old.text);
  let grew = false;
  if (prev) {
    const next = Progress.mergeProgression(prev, doc.progression);
    grew = canon(next) !== canon(doc.progression);
    doc = { ...doc, progression: next };
  }
  write({ replaceForeign: true });
  hadSave = true;
  if (grew) merged();
}

/** The sync badge (platform.js syncStatus): offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the browser build's settings KV ----------------------------------------------------------
let legacyDone = false;
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function importLegacy(): void {
  const keys = kv.legacyKeys();
  if (!keys || legacyDone) return;
  legacyDone = true;
  const old: Record<string, unknown> = {};
  for (const key of keys) old[key] = kv.legacy(key);
  const prefs = Progress.legacyPreferences(old);
  if (Object.keys(prefs).length) { Object.assign(doc.settings, prefs); write(); settingsListeners.forEach((fn) => fn()); }
  for (const key of keys) if (Progress.isBrowserKey(key)) kv.removeLegacy(key);
}

/** Reads the device's save (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  hadSave = !!cur;
  doc = (cur ? Progress.migrate(JSON.parse(JSON.stringify(cur.data))) : null) ?? Progress.fresh();
  kv.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}
export function hadSaveBefore(): boolean { return hadSave; }

// --- device-only records ----------------------------------------------------------------------
function getJson<T>(key: string): T | null {
  try { return storage.getJson(key) as T | null; } catch { return null; }
}
function setJson(key: string, v: unknown): void {
  try { storage.setJson(key, v as JsonValue); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
}
/** platform.js saveRoundSnapshot / loadRoundSnapshot / clearRoundSnapshot. */
export function saveRound(snap: unknown): void { setJson("round", snap); }
export function loadRound<T>(): T | null { return getJson<T>("round"); }
export function clearRound(): void { try { storage.remove("round"); } catch { /* gone */ } }

export interface BoardRecord {
  game: string; board: string; score: number; rulesetVersion: number; contentVersion: number; seed: number;
  assists: { hints: number; undos: number; timingAssist: boolean }; durationMs: number; sessionId: string;
  player: string | null; at: number;
}
/** platform.js submitScore: the personal-best record on its local board (top 50); its 1-based rank. */
export function submitRecord(rec: BoardRecord): number {
  const key = `board:${rec.board}`;
  const list = getJson<BoardRecord[]>(key) ?? [];
  list.push(rec);
  list.sort((a, b) => b.score - a.score);
  setJson(key, list.slice(0, 50));
  return list.indexOf(rec) + 1;
}
export function localBoard(board: string): BoardRecord[] { return getJson<BoardRecord[]>(`board:${board}`) ?? []; }

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day, the top bar's clock). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
export function serverSynced(): boolean {
  try { return serverNow() !== null; } catch { return false; }
}
/** The UTC date of the platform's clock (platform.js utcDate). */
export function utcDate(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { player: string; score: number }
/** platform.js leaderboard (hosted): the platform board's top 50, all or friends; null when unavailable. */
export async function platformEntries(friendsOnly: boolean): Promise<BoardRow[] | null> {
  if (!player()) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 50, ...(friendsOnly ? { friendsOnly: true } : {}) });
    return r.items.slice(0, 50).map((e) => ({ player: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0 }));
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a won ranked round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
