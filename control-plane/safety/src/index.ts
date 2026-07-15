// @loa/safety — SafetyGate implementation and account state machine.

export type { CapTable, SafetyConfig } from './config.js';
export { DEFAULT_CONFIG } from './config.js';
export type {
  Clock,
  DailyUsageCounter,
  OutstandingInviteCounter,
  PauseState,
  RecentActionClock,
  SafetyGateOptions,
  WeeklyInviteCounter,
} from './safety-gate.js';
export {
  actionEnabled,
  activeHoursDefer,
  DefaultSafetyGate,
  effectiveSchedule,
  isoDate,
  nextDay,
  scheduleDefer,
} from './safety-gate.js';
export type { StateEvent, StateStep } from './state-machine.js';
export { isTerminal, transition } from './state-machine.js';

// Test-only helpers (see test-support.ts) for keeping gate-backed tests off the
// wall clock. Exported here so consumer packages can import them from @loa/safety.
export { MID_WINDOW_NOW, midWindowClock, NO_ACTIVE_HOURS_CONFIG } from './test-support.js';
