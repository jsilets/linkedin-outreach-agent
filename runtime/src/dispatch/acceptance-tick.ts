// The acceptance tick: releases cursors parked after a connect step once the
// invite has been accepted.
//
// A connect step parks its cursor in 'awaiting_connection' (see DispatchTick):
// the invite is out and time-based advance is suspended, because a message step
// can only run against a 1st-degree connection. This tick closes that gap.
//
// Each tick:
//   1. enumerate enrollments parked in 'awaiting_connection' and group them by
//      account, so each account's connection list is read once and a parked
//      target maps only against that account's own connections.
//   2. for each such account, read the recently-accepted connections (the
//      ConnectionsReaderPort, a direct Voyager relationships read from the
//      account's own page).
//   3. match each parked target against a connection using the SAME identity
//      matcher the reply tick uses (urn tail + /in/ vanity).
//   4. on a match: set the target stage to 'connected', then RELEASE the cursor
//      to the step AFTER the connect (advanceAfterStep from the connect index),
//      so the post-accept delay clock starts at ACCEPTANCE. No next step ->
//      completed. An unmatched parked target stays parked for a later tick.
//
// Mirrors ReplyTick/DispatchTick: runTick(now) does one pass; start(intervalMs)
// wraps it in a self-skipping setInterval so a host runs it unattended.
// Host-agnostic and restartable — no shared mutable tick state.

import type { TargetRepoPort } from '@loa/orchestrator';
import type { AccountSchedule, ActionType, db as shared } from '@loa/shared';
import { DEFAULT_SCHEDULE, isTruncatedName } from '@loa/shared';
import type { AcceptedConnection, ConnectionsReaderPort } from '../adapters/observe-live.js';
import type { SequenceStorePort } from '../store/index.js';
import { advanceAfterStep } from './advance.js';
import { matchesIdentity } from './match-target.js';

type TargetProgressRow = shared.TargetProgressRow;

/** How many connections to pull from each account's network per tick. */
const DEFAULT_CONNECTIONS_LIMIT = 40;

/** Display name off a target's external context, if present. */
function leadName(target: { externalContext?: unknown }): string | null {
  const ctx = target.externalContext;
  if (ctx && typeof ctx === 'object' && 'name' in ctx) {
    const n = (ctx as { name?: unknown }).name;
    if (typeof n === 'string' && n.trim()) return n;
  }
  return null;
}

/** How one parked cursor resolved in a tick. Returned for observability + tests.
 * The accepted variants carry accountId/campaignId/name so a host can log an
 * invite_accepted event without a second lookup. */
export type AcceptanceOutcome =
  | {
      kind: 'connected';
      targetId: string;
      progressId: string;
      nextStep: number;
      accountId: string;
      campaignId: string;
      name: string | null;
    }
  | {
      kind: 'completed'; // accepted; no next step
      targetId: string;
      progressId: string;
      accountId: string;
      campaignId: string;
      name: string | null;
    }
  | { kind: 'still_waiting'; progressId: string }; // parked target not yet accepted

export interface AcceptanceTickResult {
  /** Accounts whose connections were read this pass. */
  accounts: number;
  outcomes: AcceptanceOutcome[];
}

/** Narrow target-stage surface: read the parked target, set it 'connected' on
 * acceptance, and refresh the name the acceptance payload now reveals.
 * Supplied by compose from the store's target repo. */
type TargetStagePort = Pick<TargetRepoPort, 'findById' | 'setStage' | 'mergeExternalContext'>;

export interface AcceptanceTickDeps {
  connections: ConnectionsReaderPort;
  sequence: SequenceStorePort;
  targets: TargetStagePort;
  now?: () => Date;
  /** How many connections to read per account per tick. */
  connectionsLimit?: number;
  /** The account's working schedule, so the first message after acceptance is
   * clocked to the next working-day morning (not exactly N*24h from acceptance).
   * Defaults to the global schedule when not provided. */
  scheduleFor?: (accountId: string, actionType?: ActionType) => Promise<AccountSchedule>;
  /** Optional sink for per-outcome logging (audit / metrics). */
  onOutcome?: (o: AcceptanceOutcome) => void;
  /** Optional sink for name refreshes, so a host can log that a lead's sourced
   * stub was replaced by their real 1st-degree name. */
  onNameRefreshed?: (e: {
    targetId: string;
    accountId: string;
    from: string | null;
    to: string;
  }) => void;
  /** Optional sink for "this invite is no longer outstanding". The gate's
   * outstanding-invite ceiling counts the pending pile, and acceptance is how a
   * pending invite leaves it; without this the gate's count only ever grows
   * between restarts and would disagree with what the UI reads live. */
  onInviteAccepted?: (accountId: string) => void;
}

export class AcceptanceTick {
  private readonly connections: ConnectionsReaderPort;
  private readonly sequence: SequenceStorePort;
  private readonly targets: TargetStagePort;
  private readonly now: () => Date;
  private readonly connectionsLimit: number;
  private readonly scheduleFor?: (
    accountId: string,
    actionType?: ActionType,
  ) => Promise<AccountSchedule>;
  private readonly onOutcome?: (o: AcceptanceOutcome) => void;
  private readonly onNameRefreshed?: (e: {
    targetId: string;
    accountId: string;
    from: string | null;
    to: string;
  }) => void;
  private readonly onInviteAccepted?: (accountId: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: AcceptanceTickDeps) {
    this.connections = deps.connections;
    this.sequence = deps.sequence;
    this.targets = deps.targets;
    this.now = deps.now ?? (() => new Date());
    this.connectionsLimit = deps.connectionsLimit ?? DEFAULT_CONNECTIONS_LIMIT;
    this.scheduleFor = deps.scheduleFor;
    this.onOutcome = deps.onOutcome;
    this.onNameRefreshed = deps.onNameRefreshed;
    this.onInviteAccepted = deps.onInviteAccepted;
  }

  /** One pass: read each account's connections and release accepted targets. */
  async runTick(now: Date = this.now()): Promise<AcceptanceTickResult> {
    // Group parked enrollments by account, so each connection list is read once
    // and a target maps only against its own account's connections.
    const parked = await this.sequence.awaitingConnectionEnrollments();
    const byAccount = new Map<string, TargetProgressRow[]>();
    for (const p of parked) {
      const list = byAccount.get(p.accountId);
      if (list) list.push(p);
      else byAccount.set(p.accountId, [p]);
    }

    const outcomes: AcceptanceOutcome[] = [];
    for (const [accountId, enrolled] of byAccount) {
      const connections = await this.connections.readConnections(accountId, this.connectionsLimit);
      for (const progress of enrolled) {
        const outcome = await this.release(progress, connections, now);
        outcomes.push(outcome);
        this.onOutcome?.(outcome);
      }
    }
    return { accounts: byAccount.size, outcomes };
  }

  /**
   * Replace a truncated stored name with the full name the accepted connection
   * carries, returning the name the lead should now be known by (or null when
   * there is nothing better to say).
   *
   * Only a truncated or missing name is overwritten. A name that already reads
   * like a real name is left exactly as sourced — the connections payload is a
   * better source for a stub, not a licence to churn every lead's name on the
   * tick that accepts it.
   */
  private async refreshTruncatedName(
    target: shared.TargetRow,
    accepted: AcceptedConnection,
    accountId: string,
  ): Promise<string | null> {
    const stored = leadName(target);
    const full = accepted.name?.trim();
    if (!full || full === stored) return stored;
    if (stored && !isTruncatedName(stored)) return stored;
    if (isTruncatedName(full)) return stored; // no better than what we hold
    await this.targets.mergeExternalContext(target.id, { name: full });
    this.onNameRefreshed?.({ targetId: target.id, accountId, from: stored, to: full });
    return full;
  }

  /** Release one parked cursor if its target now appears in the connections. */
  private async release(
    progress: TargetProgressRow,
    connections: AcceptedConnection[],
    now: Date,
  ): Promise<AcceptanceOutcome> {
    const target = await this.targets.findById(progress.targetId);
    if (!target) return { kind: 'still_waiting', progressId: progress.id };

    const accepted = connections.find((c) => matchesIdentity(c.entityUrn, c.profileUrl, target));
    if (!accepted) return { kind: 'still_waiting', progressId: progress.id };

    // Acceptance is the moment the real name becomes knowable. A lead sourced
    // from search carries whatever LinkedIn showed a stranger, which for an
    // out-of-network person is a truncated stub ("R S."). The accepted
    // connection is 1st-degree, so this payload — already in hand, no extra
    // request — carries the full name. Refresh it now: the message step
    // addresses the composer by typing this name into LinkedIn's typeahead, and
    // a stub finds nobody.
    const resolvedName = await this.refreshTruncatedName(target, accepted, progress.accountId);

    // Accepted. Move the target to 'connected' and release the cursor to the
    // step after the connect. The cursor was parked ON the connect step, so
    // advanceAfterStep(handledIdx=currentStep) computes exactly the next-step
    // patch, with nextStepAt clocked from acceptance (now).
    await this.targets.setStage(progress.targetId, 'connected');
    const steps = (await this.sequence.listCampaignSteps(progress.campaignId)).filter(
      (s) => s.enabled,
    );
    // Day-align the first message to the next working morning (not accept + 24h).
    const nextStep = steps[progress.currentStep + 1]?.stepType;
    const actionType = nextStep && nextStep !== 'delay' ? nextStep : undefined;
    const schedule = (await this.scheduleFor?.(progress.accountId, actionType)) ?? DEFAULT_SCHEDULE;
    const patch = advanceAfterStep(steps, progress.currentStep, now, schedule);
    await this.sequence.advanceTargetProgress(progress.id, patch);
    // The cursor has just left 'awaiting_connection': this invite is accepted and
    // is no longer part of the outstanding pile the gate ceilings on.
    this.onInviteAccepted?.(progress.accountId);
    const name = resolvedName ?? leadName(target);
    if (patch.state === 'completed') {
      return {
        kind: 'completed',
        targetId: target.id,
        progressId: progress.id,
        accountId: progress.accountId,
        campaignId: progress.campaignId,
        name,
      };
    }
    return {
      kind: 'connected',
      targetId: target.id,
      progressId: progress.id,
      nextStep: patch.currentStep!,
      accountId: progress.accountId,
      campaignId: progress.campaignId,
      name,
    };
  }

  /** Start a restartable interval loop. No-op if already started. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // skip if the previous tick is still in flight
      this.running = true;
      void this.runTick()
        .catch(() => {
          // A tick must never crash the loop; a failed connections read just
          // retries next tick. Swallow so the interval keeps running.
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    // Do not keep the process alive solely for the tick (host owns lifecycle).
    this.timer.unref?.();
  }

  /** Stop the interval loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
