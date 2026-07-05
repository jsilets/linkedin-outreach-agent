// PORT interfaces: the integration contract between @loa/agent and the packages
// being built in parallel (safety, account-runner, scheduler) plus the
// orchestrator's persistence. The loop depends only on these, never on those
// packages' concrete types, so wiring happens later and tests inject fakes.

import type {
  Account,
  Action,
  ActionType,
  Campaign,
  Decision,
  Draft,
  Intent,
  Message,
  Target,
  TargetContext,
  Thread,
} from '@loa/shared';

/**
 * SafetyPort mirrors the subset of @loa/safety the loop needs: a gate check
 * before every act, and a read of the account's current budget. Full SafetyGate
 * lives in @loa/safety; the loop only needs canAct.
 */
export interface SafetyPort {
  /** Decide whether an action may run now: allow, defer(until), or deny(reason). */
  canAct(acct: Account, action: Action): Decision;
}

/**
 * An action the loop wants the executor to observe or perform. Kept looser than
 * the persisted Action row so the loop can describe intent before a row exists.
 */
export interface ExecIntent {
  type: ActionType;
  accountId: string;
  targetId: string;
  campaignId: string;
  /** Message body for message actions; ignored for others. */
  body?: string;
}

/** A raw inbound message the executor observed, pre-persistence. */
export interface ObservedMessage {
  threadRef: string;
  body: string;
  accountId: string;
  targetId: string;
}

/** What the executor observed for a target: profile signals and any new inbound. */
export interface Observation {
  target: Target;
  /** New inbound messages since last observation. */
  inbound: ObservedMessage[];
}

/**
 * ExecutorPort mirrors the subset of @loa/account-runner the loop needs. The
 * loop never drives a browser directly; it asks the executor to observe and to
 * act. In v1 the loop does not call act() for sends (human gate), but the port
 * exposes it for later autonomy levels.
 */
export interface ExecutorPort {
  observe(acct: Account, target: Target): Promise<Observation>;
  act(acct: Account, intent: ExecIntent): Promise<Action>;
}

/**
 * SchedulerPort mirrors the subset of @loa/scheduler the loop needs: enqueue a
 * paced follow-up. The loop emits intent; the scheduler owns timing.
 */
export interface SchedulerPort {
  enqueueFollowUp(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    /** Earliest time the follow-up may run. */
    notBefore: Date;
    reason: string;
  }): Promise<void>;
}

/**
 * PersistencePort is the slice of @loa/orchestrator the loop writes through.
 * Every send and every drafted reply becomes a pending approval item in v1; the
 * loop never auto-sends. Also records messages and funnels events.
 */
export interface PersistencePort {
  /** Persist an outbound draft as a pending item awaiting human sign-off. */
  enqueuePendingSend(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    draft: Draft;
  }): Promise<{ pendingItemRef: string }>;
  /** Persist a drafted reply as a pending item awaiting human sign-off. */
  enqueuePendingReply(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    threadRef: string;
    intent: Intent;
    draft: Draft;
  }): Promise<{ pendingItemRef: string }>;
  /** Persist an observed inbound message and return the stored row. */
  recordInboundMessage(msg: ObservedMessage): Promise<Message>;
  /** Append one audit event. The only write path for events. */
  recordEvent(kind: string, accountId: string, payload: unknown): Promise<void>;
  /** True if the target is suppressed (e.g. after a Stop) and must not be messaged. */
  isSuppressed(targetId: string): Promise<boolean>;
}

/** The LLM boundary, re-exported from @loa/shared for port symmetry. */
export interface LLMPort {
  personalize(ctx: TargetContext): Promise<Draft>;
  classifyReply(msg: Message): Promise<Intent>;
  draftReply(thread: Thread, intent: Intent): Promise<Draft>;
}

/** Everything the loop needs wired in. */
export interface LoopPorts {
  safety: SafetyPort;
  executor: ExecutorPort;
  scheduler: SchedulerPort;
  persistence: PersistencePort;
  llm: LLMPort;
}

/** Context for a single target the loop steps over. */
export interface LoopContext {
  account: Account;
  campaign: Campaign;
  target: Target;
}
