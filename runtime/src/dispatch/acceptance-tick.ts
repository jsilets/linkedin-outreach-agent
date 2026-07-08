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

import type { db as shared } from '@loa/shared';
import type { TargetRepoPort } from '@loa/orchestrator';
import type { AcceptedConnection, ConnectionsReaderPort } from '../adapters/observe-live.js';
import type { SequenceStorePort } from '../store/index.js';
import { advanceAfterStep } from './advance.js';
import { matchesIdentity } from './match-target.js';

type TargetProgressRow = shared.TargetProgressRow;

/** How many connections to pull from each account's network per tick. */
const DEFAULT_CONNECTIONS_LIMIT = 40;

/** How one parked cursor resolved in a tick. Returned for observability + tests. */
export type AcceptanceOutcome =
  | { kind: 'connected'; targetId: string; progressId: string; nextStep: number }
  | { kind: 'completed'; targetId: string; progressId: string } // accepted; no next step
  | { kind: 'still_waiting'; progressId: string }; // parked target not yet accepted

export interface AcceptanceTickResult {
  /** Accounts whose connections were read this pass. */
  accounts: number;
  outcomes: AcceptanceOutcome[];
}

/** Narrow target-stage surface: read the parked target and set it 'connected'
 * on acceptance. Supplied by compose from the store's target repo. */
type TargetStagePort = Pick<TargetRepoPort, 'findById' | 'setStage'>;

export interface AcceptanceTickDeps {
  connections: ConnectionsReaderPort;
  sequence: SequenceStorePort;
  targets: TargetStagePort;
  now?: () => Date;
  /** How many connections to read per account per tick. */
  connectionsLimit?: number;
  /** Optional sink for per-outcome logging (audit / metrics). */
  onOutcome?: (o: AcceptanceOutcome) => void;
}

export class AcceptanceTick {
  private readonly connections: ConnectionsReaderPort;
  private readonly sequence: SequenceStorePort;
  private readonly targets: TargetStagePort;
  private readonly now: () => Date;
  private readonly connectionsLimit: number;
  private readonly onOutcome?: (o: AcceptanceOutcome) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: AcceptanceTickDeps) {
    this.connections = deps.connections;
    this.sequence = deps.sequence;
    this.targets = deps.targets;
    this.now = deps.now ?? (() => new Date());
    this.connectionsLimit = deps.connectionsLimit ?? DEFAULT_CONNECTIONS_LIMIT;
    this.onOutcome = deps.onOutcome;
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

  /** Release one parked cursor if its target now appears in the connections. */
  private async release(
    progress: TargetProgressRow,
    connections: AcceptedConnection[],
    now: Date,
  ): Promise<AcceptanceOutcome> {
    const target = await this.targets.findById(progress.targetId);
    if (!target) return { kind: 'still_waiting', progressId: progress.id };

    const accepted = connections.some((c) => matchesIdentity(c.entityUrn, c.profileUrl, target));
    if (!accepted) return { kind: 'still_waiting', progressId: progress.id };

    // Accepted. Move the target to 'connected' and release the cursor to the
    // step after the connect. The cursor was parked ON the connect step, so
    // advanceAfterStep(handledIdx=currentStep) computes exactly the next-step
    // patch, with nextStepAt clocked from acceptance (now).
    await this.targets.setStage(progress.targetId, 'connected');
    const steps = (await this.sequence.listCampaignSteps(progress.campaignId)).filter(
      (s) => s.enabled,
    );
    const patch = advanceAfterStep(steps, progress.currentStep, now);
    await this.sequence.advanceTargetProgress(progress.id, patch);
    if (patch.state === 'completed') {
      return { kind: 'completed', targetId: target.id, progressId: progress.id };
    }
    return {
      kind: 'connected',
      targetId: target.id,
      progressId: progress.id,
      nextStep: patch.currentStep!,
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
