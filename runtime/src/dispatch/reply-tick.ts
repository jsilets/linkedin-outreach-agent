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
//   5. persist every NEW inbound to the local transcript, then classify the
//      NEWEST one per thread via LLMProvider.classifyReply and route it through
//      ReplyRouter.route, which pulls the target from the funnel (terminal
//      'replied' progress state) and does per-intent follow-up.
//
// ROUTING IS NEWEST-ONLY: ReplyRouter.route acts per intent with no notion of a
// thread — it sets the stage and, for NotNow/OutOfOffice, unconditionally
// enqueues a paced follow-up. Routing every unseen message in a history read
// would therefore let an older "ping me in Q3" schedule a follow-up to someone
// whose newer message says they are interested. Older messages are still
// persisted: they are real conversation the operator must see in the Inbox.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How one inbound message resolved in a tick. Returned for observability + tests. */
export type ReplyOutcome =
  | { kind: 'routed'; targetId: string; threadUrn: string; intent: Intent }
  | { kind: 'recorded'; targetId: string; threadUrn: string } // transcript only; a newer message routes
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
      /** Enrollments whose thread history was NOT read because the list row
       * showed no new activity since the last pass. Counted per enrollment, as
       * historyReads is, so the two sum to the enrollments that mapped to a
       * thread; mappedThreads dedupes by urn and can be lower when one person is
       * enrolled twice. A quiet steady state reads no history at all. */
      skippedThreads: number;
      inboundMessages: number;
      routed: number;
      recorded: number;
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
  /** Minimum gap between per-thread history reads for one account. */
  historyReadDelayMs?: number;
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

/** readThreadHistory returns newest-first and its callers keep that contract.
 * Sorting here gives both a chronological transcript and a last element that is
 * the newest message — the only one allowed to route. */
function oldestFirst(history: InboundMessage[]): InboundMessage[] {
  return [...history].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
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
  private readonly historyReadDelayMs: number;
  private readonly onOutcome?: (o: ReplyOutcome) => void;
  private readonly onScan?: (scan: ReplyScan) => void | Promise<void>;
  /** Messages already routed; keeps a reply from re-routing each tick. */
  private readonly seen = new Set<string>();
  /** Per-account inbox read cache (short TTL), shared by runTick + probeTarget. */
  private readonly inboxCache = new Map<string, { at: number; messages: InboundMessage[] }>();
  /** Conversation identities are cached with the same short TTL as snippets so
   * a burst of pre-send probes shares one mailbox-list read. */
  private readonly threadCache = new Map<string, { at: number; threads: InboxThread[] }>();
  /**
   * Newest activity already accounted for, per thread urn. A mapped thread whose
   * list row reports nothing newer than this has its (expensive) history read
   * skipped.
   *
   * In-memory and per-process, like the seen-set: a restart forgets every mark
   * and the next pass reads all histories again. That is the safe direction to
   * forget in — it costs one full pass and cannot lose a reply.
   */
  private readonly threadWatermarks = new Map<string, number>();
  /** Per-account pacing for conversation-detail reads. */
  private readonly lastHistoryReadAt = new Map<string, number>();
  private readonly historyReadPace = new Map<string, Promise<void>>();
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
    this.historyReadDelayMs = Math.max(0, deps.historyReadDelayMs ?? 0);
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
    let skippedThreads = 0;
    let inboundMessages = 0;
    // Frozen for the whole pass: marks written as this tick proceeds must not
    // change a skip decision inside the same tick.
    const watermarksAtStart = new Map(this.threadWatermarks);
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
            // The list row already told us whether this conversation moved. If it
            // did not, its history cannot have changed either, and reading it is
            // the single most expensive thing this tick does. Decided against a
            // snapshot taken before this pass so that two enrollments sharing one
            // thread still both route, exactly as they did before watermarking.
            if (this.isUnchanged(thread, watermarksAtStart)) {
              skippedThreads += 1;
              continue;
            }
            failurePhase = 'thread_history';
            const history = await this.readThreadHistoryPaced(accountId, thread.threadUrn);
            historyReads += 1;
            inboundMessages += history.length;
            failurePhase = 'route';
            const chronological = oldestFirst(history);
            for (const [index, msg] of chronological.entries()) {
              const outcome = await this.handle(
                accountId,
                [progress],
                msg,
                index === chronological.length - 1,
              );
              outcomes.push(outcome);
              this.onOutcome?.(outcome);
            }
            // Only now: a throw between the read and the last route must leave the
            // thread unmarked so the next pass reads it again.
            this.markThreadSeen(thread);
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
        skippedThreads,
        inboundMessages,
        routed: outcomes.filter((outcome) => outcome.kind === 'routed').length,
        recorded: outcomes.filter((outcome) => outcome.kind === 'recorded').length,
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
  /**
   * Whether the list row proves this conversation has not moved since the last
   * pass that read it.
   *
   * Fails toward reading, always: a thread we have never marked, or one whose row
   * carries no usable timestamp, is NOT unchanged. The cost of a wrong "read" is
   * one request; the cost of a wrong "skip" is a missed reply.
   */
  private isUnchanged(thread: InboxThread, watermarks: Map<string, number>): boolean {
    const at = thread.lastActivityAt?.getTime();
    if (at === undefined || !Number.isFinite(at)) return false;
    const seen = watermarks.get(thread.threadUrn);
    return seen !== undefined && at <= seen;
  }

  /**
   * Record the activity this pass has now accounted for. No timestamp means no
   * mark, so the thread keeps being read until the row carries one.
   *
   * Marks the LIST ROW's timestamp, not the newest message the history returned.
   * The row is the same value the next pass compares against, and it can only be
   * older than or equal to what we just read, so the error is always toward
   * re-reading. Marking the history's newest instead could sit above a row value
   * that never reaches it and skip a thread forever.
   */
  private markThreadSeen(thread: InboxThread): void {
    const at = thread.lastActivityAt?.getTime();
    if (at === undefined || !Number.isFinite(at)) return;
    this.threadWatermarks.set(thread.threadUrn, at);
  }

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

  private async paceHistoryRead(accountId: string): Promise<void> {
    const prior = this.historyReadPace.get(accountId) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        const last = this.lastHistoryReadAt.get(accountId);
        if (last !== undefined && this.historyReadDelayMs > 0) {
          const waitMs = Math.max(0, this.historyReadDelayMs - (Date.now() - last));
          if (waitMs > 0) await sleep(waitMs);
        }
        this.lastHistoryReadAt.set(accountId, Date.now());
      });
    this.historyReadPace.set(accountId, next);
    await next;
  }

  private async readThreadHistoryPaced(
    accountId: string,
    threadUrn: string,
  ): Promise<InboundMessage[]> {
    await this.paceHistoryRead(accountId);
    return this.inbox.readThreadHistory!(accountId, threadUrn);
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
        const matches = await this.readThreadHistoryPaced(accountId, thread.threadUrn);
        if (matches.length === 0) return false;
        const chronological = oldestFirst(matches);
        for (const [index, msg] of chronological.entries()) {
          const key = messageKey(msg);
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          if (index === chronological.length - 1)
            await this.classifyAndRoute(accountId, target, target.campaignId, msg);
          else await this.record(accountId, target, msg);
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

  /** Map, dedupe, and persist one inbound message, routing it only when it is the
   * newest in its thread (see the newest-only note in the header). */
  private async handle(
    _accountId: string,
    enrolled: TargetProgressRow[],
    msg: InboundMessage,
    route = true,
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

    if (!route) {
      await this.record(_accountId, target, msg);
      return { kind: 'recorded', targetId: target.id, threadUrn: msg.threadUrn };
    }
    const intent = await this.classifyAndRoute(_accountId, target, progress.campaignId, msg);
    return { kind: 'routed', targetId: target.id, threadUrn: msg.threadUrn, intent };
  }

  /** Persist one observed inbound in the local transcript. This is an
   * observation, never a send: it belongs in the same local audit trail as
   * outbound messages so the unified inbox has the actual incoming text rather
   * than merely a lifecycle state. The caller's seen-set ensures a running
   * process records a given message once. */
  private async record(accountId: string, target: TargetRow, msg: InboundMessage): Promise<void> {
    const recorded = this.messages ? await this.messages.listByThread(msg.threadUrn) : [];
    // LinkedIn does not expose a stable event id in every response shape. This
    // conservative local key prevents a runtime restart from duplicating the
    // same observed body in the unified inbox; the in-memory seen-set still
    // handles the normal, same-process case precisely.
    if (recorded.some((row) => row.direction === 'inbound' && row.body === msg.text)) return;
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
  }

  /** Persist one inbound message, then classify and route it (pulling the funnel
   * + cancelling outstanding messages via the router). Shared by handle() and
   * probeTarget(). Returns the classified intent. */
  private async classifyAndRoute(
    accountId: string,
    target: TargetRow,
    campaignId: string,
    msg: InboundMessage,
  ): Promise<Intent> {
    await this.record(accountId, target, msg);
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
