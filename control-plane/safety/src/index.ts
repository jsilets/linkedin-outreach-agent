// @loa/safety — SafetyGate implementation and account state machine.

export { DEFAULT_CONFIG } from './config.js';
export type { CapTable, SafetyConfig } from './config.js';

export { transition, isTerminal } from './state-machine.js';
export type { StateEvent, StateStep } from './state-machine.js';

export { DefaultSafetyGate, isoDate, nextDay } from './safety-gate.js';
export type {
  SafetyGateOptions,
  WeeklyInviteCounter,
  DailyUsageCounter,
  RecentActionClock,
  PauseState,
  Clock,
} from './safety-gate.js';

// Test-only helpers (see test-support.ts) for keeping gate-backed tests off the
// wall clock. Exported here so consumer packages can import them from @loa/safety.
export { NO_ACTIVE_HOURS_CONFIG, MID_WINDOW_NOW, midWindowClock } from './test-support.js';
