// The two LOCKED interfaces. Every package implements or consumes these; do not
// change their shape without a coordinated migration across all packages.

import type {
  Account,
  Action,
  DailyBudget,
  Decision,
  Draft,
  Intent,
  Message,
  Signal,
  TargetContext,
  Thread,
  Transition,
} from './types.js';

/**
 * SafetyGate governs whether an account may take an action, how it reacts to
 * detector signals, and what its daily budget is. Lives conceptually in the
 * control-plane (@loa/safety); the account-runner mirrors a subset locally.
 */
export interface SafetyGate {
  /** Decide whether an action may run now: allow, defer(until), or deny(reason). */
  canAct(acct: Account, action: Action): Decision;
  /** React to a detector signal, possibly moving the account's state. */
  onSignal(acct: Account, sig: Signal): Transition;
  /** Current per-action-type daily budget for the account. */
  budget(acct: Account): DailyBudget;
}

/**
 * LLMProvider is the boundary to whatever model generates and classifies copy.
 * All methods are async because real implementations call a remote API.
 */
export interface LLMProvider {
  /** Draft a personalized opening message from target context. */
  personalize(ctx: TargetContext): Promise<Draft>;
  /** Classify the intent of an inbound message. */
  classifyReply(msg: Message): Promise<Intent>;
  /** Draft a reply given a thread and the classified intent. */
  draftReply(thread: Thread, intent: Intent): Promise<Draft>;
}
