// The reply tick: watches each active account's inbox and pulls any prospect
// who replied out of the automated funnel for manual handling.
//
// Each tick:
//   1. enumerate active enrollments (in_progress cursors) and group them by
//      account, so we only read the inbox of accounts that have live campaigns
//      and we know which prospects to map replies to.
//   2. for each such account, read recent inbound messages (the InboxReaderPort,
//      a direct Voyager messaging read from the account's own page).
//   3. map each inbound sender to an enrolled target by matching the sender urn
//      / profile url against the target's linkedinUrn (see matchesTarget).
//   4. skip messages already handled on a prior tick (an in-memory seen-set,
//      keyed by thread+timestamp+text — see the dedupe note below).
//   5. classify each NEW inbound via LLMProvider.classifyReply, then route it
//      through ReplyRouter.route, which pulls the target from the funnel
//      (terminal 'replied' progress state) and does per-intent follow-up.
//
// Mirrors DispatchTick: runTick(now) does one pass; start(intervalMs) wraps it
// in a self-skipping setInterval so a host runs it unattended. Host-agnostic and
// restartable — no shared tick state beyond the seen-set.
//
// DEDUPE LIMITATION: there is no store field marking a message as processed, so
// the seen-set is IN-MEMORY and per-process. A restart forgets it. That is safe
// but not perfectly idempotent: a still-recent reply seen again after a restart
// re-routes the (already pulled-out) target — pullTargetFromFunnel and the stage
// set are idempotent, but a NotNow/OutOfOffice reply would enqueue a second
// paced follow-up. Persisting a processed-marker (e.g. a messages-row insert
// keyed by the LinkedIn message urn) is the durable fix; deferred here.

import type { Intent, LLMProvider, Message } from '@loa/shared';
import type { db as shared } from '@loa/shared';
import type { ReplyRouter } from '@loa/orchestrator';
import type { TargetRepoPort } from '@loa/orchestrator';
import type { InboundMessage, InboxReaderPort } from '../adapters/observe-live.js';
import { matchesIdentity } from './match-target.js';

type TargetProgressRow = shared.TargetProgressRow;
type TargetRow = shared.TargetRow;

/** How many recent threads to pull from each active account's inbox per tick. */
const DEFAULT_INBOX_LIMIT = 20;

/** How one inbound message resolved in a tick. Returned for observability + tests. */
export type ReplyOutcome =
  | { kind: 'routed'; targetId: string; threadUrn: string; intent: Intent }
  | { kind: 'unmatched'; threadUrn: string } // sender not an enrolled target
  | { kind: 'seen'; threadUrn: string }; // already processed on a prior tick

export interface ReplyTickResult {
  /** Accounts whose inbox was read this pass. */
  accounts: number;
  outcomes: ReplyOutcome[];
}

/**
 * Enumerate the active enrollment cursors to scan for replies. Kept as a port so
 * the tick does not depend on a specific store method: compose supplies an impl
 * over the runtime store, tests supply a fake. Should return in_progress cursors
 * (the prospects still in a funnel), across all campaigns/accounts.
 */
export interface ActiveEnrollmentsPort {
  activeEnrollments(): Promise<TargetProgressRow[]>;
}

/** Load a target row by id (linkedinUrn is the mapping key). */
type TargetLookup = Pick<TargetRepoPort, 'findById'>;

export interface ReplyTickDeps {
  inbox: InboxReaderPort;
  enrollments: ActiveEnrollmentsPort;
  targets: TargetLookup;
  router: ReplyRouter;
  llm: LLMProvider;
  now?: () => Date;
  /** How many threads to read per account per tick. */
  inboxLimit?: number;
  /** Optional sink for per-outcome logging (audit / metrics). */
  onOutcome?: (o: ReplyOutcome) => void;
}

/**
 * True if an inbound message's sender is this target. Delegates to the shared
 * identity matcher (the acceptance tick uses the same one against accepted
 * connections) so reply-mapping and accept-mapping stay identical.
 */
export function matchesTarget(msg: InboundMessage, target: TargetRow): boolean {
  return matchesIdentity(msg.senderUrn, msg.profileUrl, target);
}

/** Stable identity for a single inbound message, for the seen-set. */
function messageKey(msg: InboundMessage): string {
  return `${msg.threadUrn}#${msg.receivedAt.getTime()}#${msg.text}`;
}

/** Shape a classified inbound into the Message the LLM classifier reads. Only
 * the body is used by classifyReply, but the full shape keeps the contract. */
function toClassifierMessage(msg: InboundMessage, target: TargetRow): Message {
  const now = new Date();
  return {
    id: messageKey(msg),
    direction: 'inbound',
    body: msg.text,
    threadRef: msg.threadUrn,
    intent: null,
    status: 'sent',
    accountId: '',
    targetId: target.id,
    createdAt: msg.receivedAt,
    updatedAt: now,
  };
}

export class ReplyTick {
  private readonly inbox: InboxReaderPort;
  private readonly enrollments: ActiveEnrollmentsPort;
  private readonly targets: TargetLookup;
  private readonly router: ReplyRouter;
  private readonly llm: LLMProvider;
  private readonly now: () => Date;
  private readonly inboxLimit: number;
  private readonly onOutcome?: (o: ReplyOutcome) => void;
  /** Messages already routed; keeps a reply from re-routing each tick. */
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: ReplyTickDeps) {
    this.inbox = deps.inbox;
    this.enrollments = deps.enrollments;
    this.targets = deps.targets;
    this.router = deps.router;
    this.llm = deps.llm;
    this.now = deps.now ?? (() => new Date());
    this.inboxLimit = deps.inboxLimit ?? DEFAULT_INBOX_LIMIT;
    this.onOutcome = deps.onOutcome;
  }

  /** One pass: read every active account's inbox and route new replies. */
  async runTick(): Promise<ReplyTickResult> {
    // Group active enrollments by account, so each inbox is read once and a
    // reply maps only against that account's own enrolled prospects.
    const active = await this.enrollments.activeEnrollments();
    const byAccount = new Map<string, TargetProgressRow[]>();
    for (const p of active) {
      const list = byAccount.get(p.accountId);
      if (list) list.push(p);
      else byAccount.set(p.accountId, [p]);
    }

    const outcomes: ReplyOutcome[] = [];
    for (const [accountId, enrolled] of byAccount) {
      const inbound = await this.inbox.readInbox(accountId, this.inboxLimit);
      for (const msg of inbound) {
        const outcome = await this.handle(accountId, enrolled, msg);
        outcomes.push(outcome);
        this.onOutcome?.(outcome);
      }
    }
    return { accounts: byAccount.size, outcomes };
  }

  /** Map, dedupe, classify, and route one inbound message. */
  private async handle(
    accountId: string,
    enrolled: TargetProgressRow[],
    msg: InboundMessage,
  ): Promise<ReplyOutcome> {
    // Map the sender to one of this account's enrolled targets. Load each
    // target row (the linkedinUrn is the match key) and take the first hit.
    let progress: TargetProgressRow | undefined;
    let target: TargetRow | undefined;
    for (const p of enrolled) {
      const row = await this.targets.findById(p.targetId);
      if (row && matchesTarget(msg, row)) {
        progress = p;
        target = row;
        break;
      }
    }
    if (!progress || !target) return { kind: 'unmatched', threadUrn: msg.threadUrn };

    const key = messageKey(msg);
    if (this.seen.has(key)) return { kind: 'seen', threadUrn: msg.threadUrn };
    // Mark seen BEFORE routing so a router throw does not loop the same message
    // every tick; a lost reply is safer than a hot loop (the seen-set note
    // above covers the restart case).
    this.seen.add(key);

    const intent = await this.llm.classifyReply(toClassifierMessage(msg, target));
    await this.router.route({
      targetId: target.id,
      campaignId: progress.campaignId,
      intent,
      now: this.now(),
    });
    return { kind: 'routed', targetId: target.id, threadUrn: msg.threadUrn, intent };
  }

  /** Start a restartable interval loop. No-op if already started. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // skip if the previous tick is still in flight
      this.running = true;
      void this.runTick()
        .catch(() => {
          // A tick must never crash the loop; swallow so the interval keeps
          // running. A failed inbox read just retries next tick.
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
