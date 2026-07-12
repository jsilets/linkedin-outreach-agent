// Domain types. These describe the data model entities the whole system
// operates on. Persistence-shaped variants (with inferred column types) live
// in db/schema.ts; the types here are the in-memory domain contract.

import type {
  AccountState,
  ActionResult,
  ActionType,
  ApprovalDecision,
  AutonomyLevel,
  MessageDirection,
  MessageStatus,
  ReplyIntent,
  TargetStage,
} from './enums.js';

/** Opaque JSON blob. Callers should narrow before use. */
export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

/** Binding of an account to an egress proxy. */
export interface ProxyBinding {
  proxyId: string;
  region: string;
  sticky: boolean;
}

/** Rolling health snapshot for an account. */
export interface AccountHealth {
  acceptanceRate: number;
  replyRate: number;
  challengesLast7d: number;
  lastCheckedAt: Date;
}

export interface Account {
  id: string;
  /** Public handle / identity string, e.g. the LinkedIn vanity name. */
  handle: string;
  proxyBinding: ProxyBinding;
  state: AccountState;
  health: AccountHealth;
  /** Remaining budget for the current day, per action type. */
  budget: DailyBudget;
  /**
   * Operator-set automation limits for this account. These are the visible,
   * editable per-account daily caps that the SafetyGate enforces. Optional on
   * the domain type for backward-compatible fixtures; real rows always carry it
   * (the column is NOT NULL with a default), and the mapper backfills a default
   * when a legacy row lacks it.
   */
  limits?: AccountLimits;
  createdAt: Date;
  updatedAt: Date;
}

export interface Campaign {
  id: string;
  goal: string;
  autonomyLevel: AutonomyLevel;
  /** Free-form strategy descriptor consumed by the agent/LLM layer. */
  messageStrategy: string;
  /** Owner identity (operator responsible for approvals). */
  owner: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Target {
  id: string;
  /** Reference into the operator's own CRM / prospect store. */
  prospectRef: string;
  /** LinkedIn URN for the person. */
  linkedinUrn: string;
  /** Opaque enrichment blob; shape owned by the sourcing layer. */
  externalContext: Json;
  stage: TargetStage;
  campaignId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Action {
  id: string;
  type: ActionType;
  scheduledAt: Date;
  executedAt: Date | null;
  result: ActionResult;
  /** Idempotency key; a given (account, target, type) collapses to one row. */
  dedupKey: string;
  accountId: string;
  targetId: string;
  campaignId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  direction: MessageDirection;
  body: string;
  /** Thread / conversation reference on LinkedIn. */
  threadRef: string;
  /** Classified intent; only meaningful for inbound messages. */
  intent: ReplyIntent | null;
  status: MessageStatus;
  accountId: string;
  targetId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Approval {
  id: string;
  /** Reference to the item awaiting sign-off (action or message id). */
  pendingItemRef: string;
  decision: ApprovalDecision;
  /** Operator who decided. */
  editor: string;
  timestamp: Date;
}

/** Append-only audit record. Never updated after insert. */
export interface Event {
  id: string;
  ts: Date;
  accountId: string;
  kind: string;
  payload: Json;
}

// ---------------------------------------------------------------------------
// Supporting types for the locked interfaces (SafetyGate, LLMProvider).
// ---------------------------------------------------------------------------

export type { AccountState, ActionType, AutonomyLevel, Intent, ReplyIntent } from './enums.js';

/** Per-action-type daily caps and remaining counts. */
export interface DailyBudget {
  date: string; // ISO date, e.g. 2026-07-05
  caps: Record<ActionType, number>;
  used: Record<ActionType, number>;
}

/**
 * When an account is allowed to do outbound work: a local-time hour window and
 * the weekdays it runs. The SafetyGate defers every action outside this window
 * (to the next active day's start). Applies to ALL action types uniformly, the
 * same way the hour window always has.
 */
export interface AccountSchedule {
  /** Local-hour window start, inclusive (0-23). */
  hoursStart: number;
  /** Local-hour window end, exclusive (1-24). start === end disables the hour gate. */
  hoursEnd: number;
  /** Active weekdays, 0=Sunday … 6=Saturday. A day absent here is a day off. */
  days: number[];
}

/** Default schedule: 8am-8pm local, every day. Matches the legacy global window. */
export const DEFAULT_SCHEDULE: AccountSchedule = {
  hoursStart: 8,
  hoursEnd: 20,
  days: [0, 1, 2, 3, 4, 5, 6],
};

/**
 * Operator-set automation limits for one account. Kept separate from the daily
 * budget (which tracks today's counters) so editing a limit never collides with
 * usage accounting. `caps` is the per-action-type daily ceiling the SafetyGate
 * enforces. A cap of 0 disables that action entirely. `schedule` is the optional
 * per-account working-hours/days window; when absent the gate uses its global
 * config default.
 */
export interface AccountLimits {
  caps: Record<ActionType, number>;
  schedule?: AccountSchedule;
}

/**
 * Default per-action-type daily caps for a fresh, established account. Single
 * source of truth for the seed value used at account creation and the
 * SafetyGate's fallback. Conservative: connect/message land under LinkedIn's
 * daily and ~100/week rolling ceilings; the lower-risk reads run higher.
 */
export const DEFAULT_CAPS: Record<ActionType, number> = {
  connect: 20,
  message: 20,
  view_profile: 60,
  follow: 15,
  withdraw_invite: 10,
  react: 30,
};

/** A fresh AccountLimits seeded from DEFAULT_CAPS. */
export function defaultLimits(): AccountLimits {
  return { caps: { ...DEFAULT_CAPS } };
}

/** Result of SafetyGate.canAct: allow, defer until a time, or deny. */
export type Decision =
  | { kind: 'allow' }
  | { kind: 'defer'; until: Date }
  | { kind: 'deny'; reason: string };

/** A non-allow decision (defer or deny); the only shapes a re-check can surface
 * once the caller is already on the execute path. */
export type NonAllowDecision = Extract<Decision, { kind: 'defer' } | { kind: 'deny' }>;

/**
 * Raised when the SafetyGate is re-consulted at token-mint time (defense in
 * depth, inside the executor) and no longer returns `allow`. The anti-burst
 * pacer can flip an earlier `allow` to `defer` in the window between the gate
 * check and the mint, so this is a transient "retry later" signal, NOT an
 * executor failure. gateAct catches it and maps `decision` back to the matching
 * non-allow GateOutcome (deferred/denied); the dispatch tick then leaves the
 * cursor in_progress for the next tick instead of permanently failing it.
 */
export class SafetyDeferredError extends Error {
  readonly decision: NonAllowDecision;
  constructor(decision: NonAllowDecision) {
    super(`safety gate re-check returned ${decision.kind} at token-mint time`);
    this.name = 'SafetyDeferredError';
    this.decision = decision;
  }
}

/** A signal raised by the detector for the SafetyGate to react to. */
export interface Signal {
  kind: import('./enums.js').SignalKind;
  observedAt: Date;
  /** Optional numeric magnitude, e.g. observed velocity. */
  magnitude?: number;
  detail?: Json;
}

/** A state-machine transition produced by SafetyGate.onSignal. */
export interface Transition {
  fromState: AccountState;
  toState: AccountState;
  reason: string;
}

/** Context handed to the LLM to personalize an opening message. */
export interface TargetContext {
  target: Target;
  account: Account;
  campaign: Campaign;
  /** Prior messages in the thread, if any. */
  history: Message[];
}

/** A generated piece of copy, pre-send. */
export interface Draft {
  body: string;
  /** Model-reported confidence in [0, 1], if available. */
  confidence?: number;
  /** Provider/model identifier for audit. */
  model?: string;
}

/** A conversation thread handed to the LLM for reply drafting. */
export interface Thread {
  threadRef: string;
  target: Target;
  account: Account;
  messages: Message[];
}
