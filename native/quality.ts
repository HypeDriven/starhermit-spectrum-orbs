// The look per graphics level: the engine's level settings (levelSettings():
// shadows and their map size, AO, bloom resolution, grade, anti-aliasing) plus
// the browser build's art budgets (js/gfx.js BUDGETS) keyed by the runtime's
// quality tier (frame().quality), with the burst sparks and dust motes scaled
// within the tier by the level's particle budget (at most 2×). The runtime owns
// the rest of what the old Graphics panel did: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate
// limit and its readout. The old panel's per-effect overrides are not offered
// (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Orb, pedestal, glass and gallery shading. */
  material: "lambert" | "standard" | "physical";
  /** Orb sphere width segments (height ¾). */
  orbSeg: number;
  /** Terrazzo floor texture size (Gallery detail detailed). */
  floorTex: 128 | 256 | 512;
  /** Back-wall panels at detailed (odd). */
  panels: number;
  /** Kinetic mobiles at detailed. */
  mobiles: number;
  /** Burst spark cap at Particles high (low: 30 %). */
  sparks: number;
  /** Dust motes (Background animated). */
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "off" | "low" | "high";
  /** Spinning mobiles, drifting dust, light shimmer. */
  animated: boolean;
  /** Gallery walls' light strips, floor texture, light pool, mobiles. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "particles" | "animated" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "off", animated: false, detailed: false },
  balanced: { reflections: true, particles: "low", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", orbSeg: 16, floorTex: 128, panels: 7, mobiles: 1, sparks: 600, motes: 80 },
  balanced: { material: "standard", orbSeg: 24, floorTex: 256, panels: 9, mobiles: 2, sparks: 1000, motes: 110 },
  high: { material: "physical", orbSeg: 32, floorTex: 256, panels: 11, mobiles: 3, sparks: 2000, motes: 140 },
  ultra: { material: "physical", orbSeg: 48, floorTex: 512, panels: 13, mobiles: 5, sparks: 2500, motes: 220 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 5000;
export const MOTE_MAX = 440;

/** The look for a graphics level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, sparks: Math.min(SPARK_MAX, Math.round(b.sparks * k)), motes: Math.min(MOTE_MAX, Math.round(b.motes * k)) },
  };
}
/** gfx.js sparkCap: the live spark cap (Particles low: 30 % of the budget). */
export function sparkCap(look: Look): number {
  if (look.particles === "off") return 0;
  return look.particles === "high" ? look.budget.sparks : Math.round(look.budget.sparks * 0.3);
}
