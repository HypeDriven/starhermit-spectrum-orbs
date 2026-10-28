// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event (the hint chime on the
// old voice bus, here the interface bus; the rest on effects), the theme's
// quiet ambience (three sine pads at the theme's base, ×1.5 detuned +6 cents
// and ×2.02 detuned −4 cents, gains 0.05 / 0.03 / 0.015, each swelling ±50 %
// with a ~0.07 Hz LFO, on the old ambience bus) and the adaptive music (every
// 600 ms a sparse pentatonic pluck — a 1.2 s sine at gain 0.05 — whose
// density follows the board's progress, and every 16th step a 2.4 s triangle
// at the base; pitch variants ±6 % and the plucks' choices from the level's
// seeded audio stream). The ambience is rendered once per theme into a
// 30-second loop (every tone and swell completes whole cycles in it, so it
// loops without a seam; a slice a frame) and looped on the music bus — the
// runtime has no ambience bus — at the old ambience-to-music ratio
// (0.5 / 0.6); the plucks and the drone are rendered per theme into clips and
// played on fixed steps from main.ts (music bus). The synthesized transients
// audio.js played while a sample decoded are not ported (a live synthesis
// graph makes clip loads fail on the web runtime): a clip still loading is
// silent. The runtime's Options own the volumes and the mute. Clips load once
// the mixer runs (natively at once, in a browser after the first press), one
// at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import type { RandomStream } from "./classic.ts";

/** audio.js EVENT_SAMPLES (the events main.js plays). */
const SAMPLES = {
  focus: "ui-focus", pick: "orb-pick", drop: "orb-drop", invalid: "invalid-buzz", "tube-complete": "tube-complete",
  win: "round-win", lose: "round-lose", undo: "undo-swoosh", hint: "hint-chime",
} as const;
export type Sfx = keyof typeof SAMPLES;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

export function play(ev: Sfx): void {
  if (suspended) return;
  const name = SAMPLES[ev];
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = ev === "hint" ? "interface" : "effects";
  try { playClip(clip, { bus }); } catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); }
}

// -- the ambience and the music ----------------------------------------------------------------
const RATE = 11025;
const SINE = new Float32Array(4096);
for (let i = 0; i < SINE.length; i++) SINE[i] = Math.sin((2 * Math.PI * i) / SINE.length);
const sine = (ph: number): number => SINE[Math.floor((ph - Math.floor(ph)) * 4096) & 4095]!;
const tri = (ph: number): number => { const p = ph - Math.floor(ph); return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4; };
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
  pad: Float32Array; padPos: number; padClip: AudioClip | null;
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
/** One slice of the pad loop; true when done. */
function renderPad(t: ThemeAudio, count: number): boolean {
  const pads = padsFor(BASE[t.key] ?? 196);
  const end = Math.min(t.pad.length, t.padPos + count);
  for (let i = t.padPos; i < end; i++) {
    const s = i / RATE;
    let v = 0;
    for (const p of pads) v += sine(p.freq * s) * (p.gain + p.gain * 0.5 * sine(p.lfo * s));
    t.pad[i] = v;
  }
  t.padPos = end;
  return end >= t.pad.length;
}
/** audio.js _blip: 8 ms linear attack to `gain`, exponential fall to 0.0001 over `dur` (+50 ms tail). */
function blip(freq: number, dur: number, wave: "sine" | "triangle", gain: number): Float32Array {
  const n = Math.round(RATE * (dur + 0.05));
  const out = new Float32Array(n);
  const k = Math.log(0.0001 / gain);
  for (let i = 0; i < n; i++) {
    const s = i / RATE;
    const env = s < 0.008 ? (s / 0.008) * gain : s < dur ? gain * Math.exp((k * (s - 0.008)) / (dur - 0.008)) : 0;
    const ph = freq * s;
    out[i] = (wave === "sine" ? sine(ph) : tri(ph)) * env;
  }
  return out;
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

/** Each frame: the clips once the mixer runs (one at a time), then the theme's loop and notes. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SAMPLES)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading || !want) return;
  let t = themes.get(want);
  if (!t) {
    t = { key: want, pad: new Float32Array(RATE * LOOP_S), padPos: 0, padClip: null, notes: SCALE.map(() => null), drone: null };
    themes.set(want, t);
  }
  if (!t.padClip) {
    if (!renderPad(t, 12000)) return;
    try { t.padClip = createClip([t.pad], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); want = null; }
    return;
  }
  if (padTheme !== want) {
    if (padVoice) { try { padVoice.stop(); } catch { /* gone */ } }
    try { padVoice = playClip(t.padClip, { bus: "music", gain: suspended ? 0 : PAD_GAIN, loop: true }); padTheme = want; } catch { padVoice = null; }
    return;
  }
  const base = BASE[t.key] ?? 196;
  const missing = t.notes.findIndex((c) => !c);
  if (missing >= 0) {
    try { t.notes[missing] = createClip([blip(base * 2 * SCALE[missing]!, 1.2, "sine", 0.05)], RATE); } catch { /* retry next frame */ }
    return;
  }
  if (!t.drone) { try { t.drone = createClip([blip(base, 2.4, "triangle", 0.05)], RATE); } catch { /* retry */ } }
}
