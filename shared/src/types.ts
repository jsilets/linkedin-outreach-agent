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
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

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
  /** Day index into the warmup ramp; 0 before warmup begins. */
  warmupDay: number;
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

export type { AccountState, AutonomyLevel, ActionType, ReplyIntent, Intent } from './enums.js';

/** Per-action-type daily caps and remaining counts. */
export interface DailyBudget {
  date: string; // ISO date, e.g. 2026-07-05
  caps: Record<ActionType, number>;
  used: Record<ActionType, number>;
}

/** Result of SafetyGate.canAct: allow, defer until a time, or deny. */
export type Decision =
  | { kind: 'allow' }
  | { kind: 'defer'; until: Date }
  | { kind: 'deny'; reason: string };

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
