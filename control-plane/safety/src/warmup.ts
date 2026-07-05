// Warmup ramp. Maps an account's warmupDay onto a 4-week schedule and the
// cap table that applies during that week.

import type { ActionType } from '@loa/shared';
import type { CapTable, SafetyConfig } from './config.js';

/** Warmup week 1..4 (4 means "week 4 or later", i.e. steady-state ramp). */
export type WarmupWeek = 1 | 2 | 3 | 4;

/**
 * Map a 1-based warmup day onto a warmup week. Day 0 (warmup not started)
 * is treated as week 1. Days beyond week 4 clamp to week 4.
 */
export function warmupWeek(warmupDay: number): WarmupWeek {
  if (warmupDay <= 7) return 1;
  if (warmupDay <= 14) return 2;
  if (warmupDay <= 21) return 3;
  return 4;
}

/** Caps that apply to a Warming account on a given warmup day. */
export function warmupCaps(warmupDay: number, cfg: SafetyConfig): CapTable {
  return cfg.warmupByWeek[warmupWeek(warmupDay)];
}

/**
 * True once the account has completed the full ramp and may transition
 * Warming -> Active. Uses the configured ramp length (default 28 days).
 */
export function warmupComplete(warmupDay: number, cfg: SafetyConfig): boolean {
  return warmupDay >= cfg.warmupRampDays;
}

/** Whether a given action is permitted at all during a warmup week. */
export function warmupAllows(action: ActionType, warmupDay: number, cfg: SafetyConfig): boolean {
  return warmupCaps(warmupDay, cfg)[action] > 0;
}
