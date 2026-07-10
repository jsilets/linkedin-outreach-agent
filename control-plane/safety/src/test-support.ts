// Test-only helpers for gate-backed tests. Importing @loa/safety and building a
// DefaultSafetyGate with defaults pulls in the 8am-8pm active-hours window, so a
// suite that runs before 8am or after 8pm gets a `defer` decision it never
// intended and cascading failures. Use these to keep such tests off the wall
// clock's time of day. Not referenced by production code.

import { DEFAULT_CONFIG, type SafetyConfig } from './config.js';
import type { Clock } from './safety-gate.js';

/**
 * DEFAULT_CONFIG with the active-hours window disabled (start === end), so
 * canAct never defers on time of day. The real clock is left in place, so
 * pacing, daily caps, and the daily reset behave exactly as in production.
 * Prefer this for gate-backed tests that only need to escape the hours window.
 */
export const NO_ACTIVE_HOURS_CONFIG: SafetyConfig = {
  ...DEFAULT_CONFIG,
  activeHoursStart: 0,
  activeHoursEnd: 0,
};

/**
 * A fixed instant at local noon, inside the default 8am-8pm window in any
 * timezone the tests run in. Use with `midWindowClock` when a test needs a
 * pinned "now" (e.g. to assert on dates) rather than just escaping the window.
 */
export const MID_WINDOW_NOW = new Date(2026, 6, 6, 12, 0, 0); // Monday, local noon

/** A Clock pinned to MID_WINDOW_NOW for deterministic gate decisions. */
export const midWindowClock: Clock = { now: () => MID_WINDOW_NOW };
