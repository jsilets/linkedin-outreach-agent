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

import type { MessageRepoPort, ReplyRouter, TargetRepoPort } from '@loa/orchestrator';
import type { Intent, LLMProvider, Message, db as shared } from '@loa/shared';
import type { InboundMessage, InboxReaderPort, InboxThread } from '../adapters/observe-live.js';
import { matchesIdentity } from './match-target.js';

type TargetProgressRow = shared.TargetProgressRow;
type TargetRow = shared.TargetRow;

/** How many recent threads to pull from each active account's inbox per tick. */
const DEFAULT_INBOX_LIMIT = 20;

/** How long a per-account inbox read is reused. Both the reply tick and the
 * dispatch send-time probe read the same inbox; caching keeps a tick pass with
 * several due sends from hammering the messaging endpoint. */
const INBOX_CACHE_TTL_MS = 60_000;

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

/** A durable operational outcome for one detector pass. These are intentionally
 * about observation, not delivery: a paused account may have a healthy detector. */
export type ReplyScan =
  | {
      kind: 'succeeded';
      at: Date;
      durationMs: number;
      accounts: number;
      enrollments: number;
      listedThreads: number;
      mappedThreads: number;
      unmatchedThreads: number;
      historyReads: number;
      inboundMessages: number;
      routed: number;
      seen: number;
      unmatchedInboundMessages: number;
    }
  | {
      kind: 'failed';
      at: Date;
      durationMs: number;
      phase: 'active_enrollments' | 'thread_list' | 'thread_history' | 'inbox_list' | 'route';
      accountId?: string;
      error: string;
    };

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
  /** Durable local inbox history. When supplied, every newly observed inbound
   * reply is written before it is routed so the web inbox can show exactly what
   * caused automation to stop. Optional for focused offline tests. */
  messages?: Pick<MessageRepoPort, 'create' | 'listByThread'>;
  now?: () => Date;
  /** How many threads to read per account per tick. */
  inboxLimit?: number;
  /** Optional sink for per-outcome logging (audit / metrics). */
  onOutcome?: (o: ReplyOutcome) => void;
  /** Durable health sink. Failures here are reported to stderr but never alter
   * the detector result: the scan result is the source of truth. */
  onScan?: (scan: ReplyScan) => void | Promise<void>;
}

/**
 * True if an inbound message's sender is this target. Delegates to the shared
 * identity matcher (the acceptance tick uses the same one against accepted
 * connections) so reply-mapping and accept-mapping stay identical.
 */
function matchesTarget(msg: InboundMessage, target: TargetRow): boolean {
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
  private readonly messages?: Pick<MessageRepoPort, 'create' | 'listByThread'>;
  private readonly now: () => Date;
  private readonly inboxLimit: number;
  private readonly onOutcome?: (o: ReplyOutcome) => void;
  private readonly onScan?: (scan: ReplyScan) => void | Promise<void>;
  /** Messages already routed; keeps a reply from re-routing each tick. */
  private readonly seen = new Set<string>();
  /** Per-account inbox read cache (short TTL), shared by runTick + probeTarget. */
  private readonly inboxCache = new Map<string, { at: number; messages: InboundMessage[] }>();
  /** Conversation identities are cached with the same short TTL as snippets so
   * a burst of pre-send probes shares one mailbox-list read. */
  private readonly threadCache = new Map<string, { at: number; threads: InboxThread[] }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: ReplyTickDeps) {
    this.inbox = deps.inbox;
    this.enrollments = deps.enrollments;
    this.targets = deps.targets;
    this.router = deps.router;
    this.llm = deps.llm;
    this.messages = deps.messages;
    this.now = deps.now ?? (() => new Date());
    this.inboxLimit = deps.inboxLimit ?? DEFAULT_INBOX_LIMIT;
    this.onOutcome = deps.onOutcome;
    this.onScan = deps.onScan;
  }

  /** One pass: read every active account's inbox and route new replies. */
  async runTick(): Promise<ReplyTickResult> {
    const startedAt = this.now();
    // Keep phase/account local to this pass so an error tells the operator what
    // actually failed rather than masquerading as an empty inbox.
    let failurePhase: Extract<ReplyScan, { kind: 'failed' }>['phase'] = 'active_enrollments';
    let failureAccountId: string | undefined;
    let listedThreads = 0;
    let mappedThreads = 0;
    let unmatchedThreads = 0;
    let historyReads = 0;
    let inboundMessages = 0;
    try {
      // Group active enrollments by account, so each inbox is read once and a
      // reply maps only against that account's own enrolled prospects.
      failurePhase = 'active_enrollments';
      const active = await this.enrollments.activeEnrollments();
      const byAccount = new Map<string, TargetProgressRow[]>();
      for (const p of active) {
        const list = byAccount.get(p.accountId);
        if (list) list.push(p);
        else byAccount.set(p.accountId, [p]);
      }

      const outcomes: ReplyOutcome[] = [];
      for (const [accountId, enrolled] of byAccount) {
        failureAccountId = accountId;
        if (this.inbox.readThreads && this.inbox.readThreadHistory) {
          // History path: list rows map targets by participant, then each matched
          // thread is read in full. An outbound latest snippet can no longer hide
          // an earlier inbound reply.
          failurePhase = 'thread_list';
          const threads = await this.readThreadsCached(accountId);
          listedThreads += threads.length;
          const threadUrnsMappedThisAccount = new Set<string>();
          for (const progress of enrolled) {
            const target = await this.targets.findById(progress.targetId);
            if (!target) continue;
            const thread = threads.find((candidate) =>
              matchesIdentity(candidate.participantUrn, candidate.profileUrl, target),
            );
            if (!thread) continue;
            if (!threadUrnsMappedThisAccount.has(thread.threadUrn)) {
              mappedThreads += 1;
              threadUrnsMappedThisAccount.add(thread.threadUrn);
            }
            failurePhase = 'thread_history';
            const history = await this.inbox.readThreadHistory(accountId, thread.threadUrn);
            historyReads += 1;
            inboundMessages += history.length;
            failurePhase = 'route';
            for (const msg of history) {
              const outcome = await this.handle(accountId, [progress], msg);
              outcomes.push(outcome);
              this.onOutcome?.(outcome);
            }
          }
          unmatchedThreads += threads.filter(
            (thread) => !threadUrnsMappedThisAccount.has(thread.threadUrn),
          ).length;
          // Retain the lightweight list pass as a compatibility safety net for a
          // future Voyager shape that omits participant data. The seen-set keeps
          // any history result from routing twice; the history path remains the
          // authoritative answer for mapped threads.
          failurePhase = 'inbox_list';
          const inbox = await this.readInboxCached(accountId);
          inboundMessages += inbox.length;
          failurePhase = 'route';
          for (const msg of inbox) {
            const outcome = await this.handle(accountId, enrolled, msg);
            outcomes.push(outcome);
            this.onOutcome?.(outcome);
          }
        } else {
          // Compatibility fallback for test doubles and older reader adapters.
          failurePhase = 'inbox_list';
          const inbound = await this.readInboxCached(accountId);
          inboundMessages += inbound.length;
          failurePhase = 'route';
          for (const msg of inbound) {
            const outcome = await this.handle(accountId, enrolled, msg);
            outcomes.push(outcome);
            this.onOutcome?.(outcome);
          }
        }
      }
      const result = { accounts: byAccount.size, outcomes };
      await this.emitScan({
        kind: 'succeeded',
        at: this.now(),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        accounts: result.accounts,
        enrollments: active.length,
        listedThreads,
        mappedThreads,
        unmatchedThreads,
        historyReads,
        inboundMessages,
        routed: outcomes.filter((outcome) => outcome.kind === 'routed').length,
        seen: outcomes.filter((outcome) => outcome.kind === 'seen').length,
        unmatchedInboundMessages: outcomes.filter((outcome) => outcome.kind === 'unmatched').length,
      });
      return result;
    } catch (error) {
      await this.emitScan({
        kind: 'failed',
        at: this.now(),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        phase: failurePhase,
        ...(failureAccountId ? { accountId: failureAccountId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async emitScan(scan: ReplyScan): Promise<void> {
    try {
      await this.onScan?.(scan);
    } catch (error) {
      console.error('[@loa/runtime] reply detector could not record scan health:', error);
    }
  }

  /** Read an account's inbox, reusing a recent read within the TTL. */
  private async readInboxCached(accountId: string): Promise<InboundMessage[]> {
    const cached = this.inboxCache.get(accountId);
    const now = Date.now();
    if (cached && now - cached.at < INBOX_CACHE_TTL_MS) return cached.messages;
    const messages = await this.inbox.readInbox(accountId, this.inboxLimit);
    this.inboxCache.set(accountId, { at: now, messages });
    return messages;
  }

  private async readThreadsCached(accountId: string): Promise<InboxThread[]> {
    const cached = this.threadCache.get(accountId);
    const now = Date.now();
    if (cached && now - cached.at < INBOX_CACHE_TTL_MS) return cached.threads;
    // The caller checks readThreads exists before entering the history path.
    const threads = await this.inbox.readThreads!(accountId, this.inboxLimit);
    this.threadCache.set(accountId, { at: now, threads });
    return threads;
  }

  /**
   * Send-time reply probe for the dispatch tick: has this target sent an inbound
   * message newer than `since`? Reads the same (cached) inbox as runTick, routes
   * any new match through the SAME classify+route flow (which pulls the funnel and
   * cancels outstanding messages), and returns true if any matching reply exists —
   * routed now or already seen. The target's own campaign is read off the row, so
   * no extra lookup is needed. A throw propagates so the caller can fail closed.
   */
  async probeTarget(accountId: string, target: TargetRow, since: Date | null): Promise<boolean> {
    if (this.inbox.readThreads && this.inbox.readThreadHistory) {
      const thread = (await this.readThreadsCached(accountId)).find((candidate) =>
        matchesIdentity(candidate.participantUrn, candidate.profileUrl, target),
      );
      if (!thread) {
        // A participant-less list shape cannot safely use history yet; preserve
        // the existing current-reply guard while the list parser is updated.
      } else {
        // Deliberately ignore `since`: the safety question is not "did they reply
        // after our last scheduled send?" but "has this person replied at all?".
        // A human may have replied after them, leaving the prospect's message
        // behind a later outbound. Any inbound in this mapped thread ends the
        // automated funnel and blocks the send.
        const matches = await this.inbox.readThreadHistory(accountId, thread.threadUrn);
        if (matches.length === 0) return false;
        for (const msg of matches) {
          const key = messageKey(msg);
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          await this.classifyAndRoute(accountId, target, target.campaignId, msg);
        }
        return true;
      }
    }
    const inbound = await this.readInboxCached(accountId);
    const matches = inbound.filter(
      (m) =>
        matchesTarget(m, target) && (since == null || m.receivedAt.getTime() > since.getTime()),
    );
    if (matches.length === 0) return false;
    for (const msg of matches) {
      const key = messageKey(msg);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      await this.classifyAndRoute(accountId, target, target.campaignId, msg);
    }
    return true;
  }

  /** Map, dedupe, classify, and route one inbound message. */
  private async handle(
    _accountId: string,
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

    const intent = await this.classifyAndRoute(_accountId, target, progress.campaignId, msg);
    return { kind: 'routed', targetId: target.id, threadUrn: msg.threadUrn, intent };
  }

  /** Classify one inbound message and route it (pulling the funnel + cancelling
   * outstanding messages via the router). Shared by handle() and probeTarget().
   * Returns the classified intent. */
  private async classifyAndRoute(
    accountId: string,
    target: TargetRow,
    campaignId: string,
    msg: InboundMessage,
  ): Promise<Intent> {
    // This is an observation, never a send: persist it in the same local audit
    // trail as outbound messages so the unified inbox has the actual incoming
    // text rather than merely a lifecycle state. The caller's seen-set ensures
    // a running process records a given message once.
    const recorded = this.messages ? await this.messages.listByThread(msg.threadUrn) : [];
    // LinkedIn does not expose a stable event id in every response shape. This
    // conservative local key prevents a runtime restart from duplicating the
    // same observed body in the unified inbox; the in-memory seen-set still
    // handles the normal, same-process case precisely.
    if (recorded.some((row) => row.direction === 'inbound' && row.body === msg.text))
      return this.classifyAndRouteOnly(target, campaignId, msg);
    await this.messages?.create({
      accountId,
      targetId: target.id,
      direction: 'inbound',
      body: msg.text,
      threadRef: msg.threadUrn,
      intent: null,
      status: 'sent',
      // The Inbox is a transcript. Preserve LinkedIn's event time rather than
      // the detector's scan time, otherwise a newest-first history read renders
      // in reverse after rows are persisted.
      createdAt: msg.receivedAt,
    });
    return this.classifyAndRouteOnly(target, campaignId, msg);
  }

  private async classifyAndRouteOnly(
    target: TargetRow,
    campaignId: string,
    msg: InboundMessage,
  ): Promise<Intent> {
    const intent = await this.llm.classifyReply(toClassifierMessage(msg, target));
    await this.router.route({
      targetId: target.id,
      campaignId,
      intent,
      now: this.now(),
    });
    return intent;
  }

  /** Start a restartable interval loop. No-op if already started. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // skip if the previous tick is still in flight
      this.running = true;
      void this.runTick()
        .catch((error) => {
          // Keep the interval alive, but never make a failed read indistinguishable
          // from no replies. runTick already emitted a durable failure event.
          console.error('[@loa/runtime] reply detector scan failed:', error);
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
