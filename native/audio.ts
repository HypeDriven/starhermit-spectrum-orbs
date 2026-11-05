// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event (the hint chime on the
// old voice bus, here the interface bus; the rest on effects), the theme's
// quiet ambience (three sine pads at the theme's base, ×1.5 detuned +6 cents
// and ×2.02 detuned −4 cents, gains 0.05 / 0.03 / 0.015, each swelling ±50 %
// with a ~0.07 Hz LFO, on the old ambience bus) and the adaptive music (every
// 600 ms a sparse pentatonic pluck — a 1.2 s sine at gain 0.05 — whose
// density follows the board's progress, and every 16th step a 2.4 s triangle
// at the base; pitch variants ±6 % and the plucks' choices from the level's
// seeded audio stream). The ambience renders once per theme into a 30-second
// loop (OfflineAudioContext; every tone and swell completes whole cycles in it,
// so it loops without a seam) and loops on the music bus — the
// runtime has no ambience bus — at the old ambience-to-music ratio
// (0.5 / 0.6); the plucks and the drone are rendered per theme into clips and
// played on fixed steps from main.ts (music bus). The synthesized transients
// audio.js played while a sample decoded are not ported: a clip still loading
// is silent. The runtime's Options own the volumes and the mute. Clips load at
// once in onStart; only starting the loop waits for the mixer (in a browser,
// the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import type { RandomStream } from "./classic.ts";

/** audio.js EVENT_SAMPLES (the events main.js plays). */
const SAMPLES = {
  focus: "ui-focus", pick: "orb-pick", drop: "orb-drop", invalid: "invalid-buzz", "tube-complete": "tube-complete",
  win: "round-win", lose: "round-lose", undo: "undo-swoosh", hint: "hint-chime",
} as const;
export type Sfx = keyof typeof SAMPLES;
const clips = new Map<string, AudioClip>();
let suspended = false;

/** Loads every clip at once (onStart). */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => { console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`); });
  }
}

export function play(ev: Sfx): void {
  if (suspended) return;
  const name = SAMPLES[ev];
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = ev === "hint" ? "interface" : "effects";
  try { playClip(clip, { bus }); } catch { /* the mixer is full this frame: skip it */ }
}

// -- the ambience and the music ----------------------------------------------------------------
const RATE = 11025;
/** audio.js startAmbience: the theme's base frequency. */
const BASE: Record<string, number> = { atrium: 196, verdant: 174, midnight: 146, ember: 130, porcelain: 220 };
const SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
const LOOP_S = 30;
/** A frequency rounded to whole cycles in the loop (inaudible: ≤ 1/60 Hz). */
const whole = (f: number): number => Math.max(1, Math.round(f * LOOP_S)) / LOOP_S;
const cents = (c: number): number => Math.pow(2, c / 1200);

interface Pad { freq: number; lfo: number; gain: number }
interface ThemeAudio {
  key: string;
  padClip: AudioClip | null;
  notes: (AudioClip | null)[]; drone: AudioClip | null;
}
const themes = new Map<string, ThemeAudio>();
let want: string | null = null;
let padVoice: Sound | null = null;
let padTheme: string | null = null;
const PAD_GAIN = 0.5 / 0.6;

function padsFor(base: number): Pad[] {
  return [
    { freq: whole(base), lfo: whole(0.07), gain: 0.05 },
    { freq: whole(base * 1.5 * cents(6)), lfo: whole(0.076), gain: 0.03 },
    { freq: whole(base * 2.02 * cents(-4)), lfo: whole(0.066), gain: 0.015 },
  ];
}
/** The pad loop: sines swelling ±50 % with their LFOs. */
async function renderPad(base: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, RATE * LOOP_S, RATE);
  for (const p of padsFor(base)) {
    const osc = off.createOscillator(); osc.frequency.value = p.freq;
    const g = off.createGain(); g.gain.value = p.gain;
    const lfo = off.createOscillator(); lfo.frequency.value = p.lfo;
    const depth = off.createGain(); depth.gain.value = p.gain * 0.5;
    lfo.connect(depth).connect(g.gain); lfo.start();
    osc.connect(g).connect(off.destination); osc.start();
  }
  return createClip(await off.startRendering());
}
/** audio.js _blip: 8 ms linear attack to `gain`, exponential fall to 0.0001 over `dur` (+50 ms tail). */
async function renderBlip(freq: number, dur: number, wave: "sine" | "triangle", gain: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(RATE * (dur + 0.05)), RATE);
  const osc = off.createOscillator(); osc.type = wave; osc.frequency.value = freq;
  const g = off.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(gain, 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  osc.connect(g).connect(off.destination);
  osc.start(); osc.stop(dur);
  return createClip(await off.startRendering());
}
/** Renders a theme's loop and notes once. */
function themeAudio(key: string): ThemeAudio {
  let t = themes.get(key);
  if (t) return t;
  const made: ThemeAudio = { key, padClip: null, notes: SCALE.map(() => null), drone: null };
  themes.set(key, made);
  const warn = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };
  const base = BASE[key] ?? 196;
  renderPad(base).then((c) => { made.padClip = c; }, warn);
  SCALE.forEach((s, i) => { renderBlip(base * 2 * s, 1.2, "sine", 0.05).then((c) => { made.notes[i] = c; }, warn); });
  renderBlip(base, 2.4, "triangle", 0.05).then((c) => { made.drone = c; }, warn);
  t = made;
  return t;
}

/** The level's theme: its ambience loops while a round is on (audio.js startAmbience / stopAmbience). */
export function startAmbience(theme: string): void { want = theme; }
export function stopAmbience(): void {
  want = null;
  if (padVoice) { try { padVoice.fade(0, 0.3); const v = padVoice; setTimeout(() => { try { v.stop(); } catch { /* gone */ } }, 1200); } catch { /* gone */ } }
  padVoice = null; padTheme = null;
}
/** A hidden window silences everything (audio.js setBackgrounded). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try { padVoice?.fade(on ? 0 : PAD_GAIN, 0.1); } catch { /* gone */ }
}

// The adaptive music: main.ts calls musicStep every 600 ms of the round's fixed-step clock.
let intensity = 0.3;
let step = 0;
/** audio.js setProgress: 0..1 raises the plucks' density. */
export function setProgress(p: number): void { intensity = 0.2 + Math.min(1, Math.max(0, p)) * 0.5; }
export function resetMusic(): void { intensity = 0.3; step = 0; }
/** One 600 ms beat (audio.js startAmbience's interval), drawing from the level's audio stream as the old one did. */
export function musicStep(rng: RandomStream, variant: RandomStream): void {
  step++;
  if (rng.float() > intensity) return;
  const t = padTheme ? themes.get(padTheme) : null;
  const note = Math.floor(rng.float() * SCALE.length) % SCALE.length;
  const pitch = 0.94 + variant.float() * 0.12;
  if (t && !suspended) { const c = t.notes[note]; if (c) { try { playClip(c, { bus: "music", pitch }); } catch { /* busy */ } } }
  if (step % 16 === 0) {
    const p2 = 0.94 + variant.float() * 0.12;
    if (t && t.drone && !suspended) { try { playClip(t.drone, { bus: "music", pitch: p2 }); } catch { /* busy */ } }
  }
}

/** Each frame, once the mixer runs: the theme's loop. */
export function update(): void {
  if (context.state !== "running" || !want) return;
  const t = themeAudio(want);
  if (!t.padClip || padTheme === want) return;
  if (padVoice) { try { padVoice.stop(); } catch { /* gone */ } }
  try { padVoice = playClip(t.padClip, { bus: "music", gain: suspended ? 0 : PAD_GAIN, loop: true }); padTheme = want; } catch { padVoice = null; }
}
