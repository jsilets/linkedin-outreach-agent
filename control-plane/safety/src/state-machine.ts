// Account safety state machine. Pure functions, no side effects, exported so
// they can be exercised directly in tests. There is no warmup ramp: an
// established account is treated as steady-state Active, and only reactive
// signals move it. Cold is a legacy/unused label that recovers straight to
// Active.
//
// Transitions (the only legal edges):
//   Cold       -> Active      (recovered: legacy label, treated as Active)
//   Active     -> Throttled   (soft signal)
//   Throttled  -> Active      (recovered)
//   Throttled  -> Cooldown    (repeated soft signal)
//   Cooldown   -> Active      (recovered)
//   Active     -> Restricted  (ban_banner / hard signal)
//   Throttled  -> Restricted  (hard signal)
//   Restricted -> (terminal)  (halt; raise a human task)

import type { AccountState, Transition } from '@loa/shared';

/** The event vocabulary the state machine reacts to. */
export type StateEvent =
  | 'soft_signal' // recoverable risk signal
  | 'repeated_soft_signal' // soft signal while already throttled
  | 'recovered' // health restored
  | 'hard_signal'; // ban banner or equivalent; terminal

export interface StateStep {
  toState: AccountState;
  reason: string;
}

// Adjacency map: for each state, which events are legal and where they lead.
const TABLE: Record<AccountState, Partial<Record<StateEvent, StateStep>>> = {
  // Legacy label; kept only so old rows resolve. Recovers straight to Active.
  Cold: {
    recovered: { toState: 'Active', reason: 'legacy Cold account promoted to Active' },
  },
  // Legacy label; no account is produced in this state any more. Included for
  // exhaustiveness so an old row can still recover to Active.
  Warming: {
    recovered: { toState: 'Active', reason: 'legacy Warming account promoted to Active' },
    hard_signal: { toState: 'Restricted', reason: 'hard signal, restricting' },
  },
  Active: {
    soft_signal: { toState: 'Throttled', reason: 'soft signal, throttling' },
    hard_signal: { toState: 'Restricted', reason: 'hard signal, restricting' },
  },
  Throttled: {
    recovered: { toState: 'Active', reason: 'health recovered' },
    repeated_soft_signal: { toState: 'Cooldown', reason: 'repeated soft signal, cooling down' },
    hard_signal: { toState: 'Restricted', reason: 'hard signal, restricting' },
  },
  Cooldown: {
    recovered: { toState: 'Active', reason: 'recovered after cooldown' },
  },
  Restricted: {
    // Terminal. No outbound edges; a human must intervene.
  },
};

/** True if the state has no outbound transitions. */
export function isTerminal(state: AccountState): boolean {
  return Object.keys(TABLE[state]).length === 0;
}

/**
 * Apply an event to a state. Returns the resulting Transition, or null if the
 * event is not legal from the current state (the caller should treat null as
 * "no state change").
 */
export function transition(fromState: AccountState, event: StateEvent): Transition | null {
  const step = TABLE[fromState][event];
  if (!step) return null;
  return { fromState, toState: step.toState, reason: step.reason };
}
