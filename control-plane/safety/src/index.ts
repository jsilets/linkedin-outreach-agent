// @loa/safety — SafetyGate implementation and account state machine.

export { DEFAULT_CONFIG } from './config.js';
export type { CapTable, SafetyConfig } from './config.js';

export { transition, isTerminal } from './state-machine.js';
export type { StateEvent, StateStep } from './state-machine.js';

export { warmupWeek, warmupCaps, warmupComplete, warmupAllows } from './warmup.js';
export type { WarmupWeek } from './warmup.js';

export { DefaultSafetyGate, isoDate, nextDay } from './safety-gate.js';
export type { SafetyGateOptions, WeeklyInviteCounter, Clock } from './safety-gate.js';
