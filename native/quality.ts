// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the burst sparks and dust motes scaled within the tier by the level
// (frame().levelIndex, at most 2×), as gfx.js scaled them by its hardware
// level (sparkCap / motes). The runtime owns the rest of what the old
// Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and its readout.
// The old panel's per-effect overrides are not offered (the runtime's Options
// choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

/** gfx.js TABLE (SHADOW_MAP sizes). */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "off", animated: false, detailed: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "low", animated: true, detailed: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", orbSeg: 16, floorTex: 128, panels: 7, mobiles: 1, sparks: 600, motes: 80, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", orbSeg: 24, floorTex: 256, panels: 9, mobiles: 2, sparks: 1000, motes: 110, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", orbSeg: 32, floorTex: 256, panels: 11, mobiles: 3, sparks: 2000, motes: 140, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", orbSeg: 48, floorTex: 512, panels: 13, mobiles: 5, sparks: 2500, motes: 220, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 5000;
export const MOTE_MAX = 440;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js sparkCap: the live spark cap (Particles low: 30 % of the budget). */
export function sparkCap(look: Look): number {
  if (look.particles === "off") return 0;
  return look.particles === "high" ? look.budget.sparks : Math.round(look.budget.sparks * 0.3);
}
