// StaleInvitationSweeper: the operator remedy behind withdraw_sent_invitations.
// It reads the account's full pending-invite pile over the live Voyager endpoint,
// withdraws the OLDEST ones, and — for any withdrawn invite that matches a
// campaign target still parked in 'awaiting_connection' — releases that cursor to
// terminal and decrements the outstanding-invite counter, mirroring the gated
// single-withdraw path.
//
// This is an operator remedy, not outreach: it fires no gated action row (the
// events journal is the trail, since an actions row's FKs require target +
// campaign, which a manual invite has neither of) and it does NOT charge the
// daily caps. It still records the pacer per withdrawal so the account's next
// real action stays spaced apart.
//
// Throttle safety (the point of this loop). LinkedIn rate-limits withdrawals:
// verified live 2026-07-16, ~25 back-to-back were fine but failures began past
// ~40 in a short window. So the loop is built to stay UNDER the limit and to stop
// rather than hammer if it hits it:
//   1. a randomized gap between every withdrawal (never machine-speed);
//   2. a proactive cooldown every BATCH_SIZE successful withdrawals, to keep the
//      sustained rate well below what tripped the limit;
//   3. throttle detection (HTTP 429/999/403, or a thrown "Failed to fetch") →
//      exponential backoff and retry the same invite; if it keeps throttling past
//      MAX_CONSECUTIVE_THROTTLES, STOP the sweep (never fire into a hard
//      restriction) and report how many are left for a later pass.

import type { PagePort } from '@loa/account-runner';
import {
  actionGapMs,
  invitationIdFromUrn,
  randInt,
  realSleep,
  type SentInvitation,
  type Sleeper,
  WITHDRAW_INVITATION_BODY,
  withdrawInvitationPath,
} from '@loa/account-runner';
import type { WithdrawStaleResult } from '@loa/mcp';
import type { TargetRepoPort } from '@loa/orchestrator';
import type {
  StoreBackedActionPacer,
  StoreBackedOutstandingInvites,
} from '../adapters/safety-state.js';
import { matchesIdentity } from '../dispatch/match-target.js';
import type { SequenceStorePort } from '../store/index.js';
import type { EventReadPort } from '../store/types.js';

/** Hard cap on how many invites one sweep may withdraw, whatever the caller asks.
 * Bounds a single call's wall-clock (backoff + cooldowns make it minutes, not
 * seconds); clear a larger backlog across several spaced calls. */
const MAX_PER_SWEEP = 100;

/** Withdraw this many, then cool down, to keep the sustained rate under the limit. */
const DEFAULT_BATCH_SIZE = 20;
/** Proactive cooldown window (ms) after each batch, jittered in this range. */
const DEFAULT_BATCH_COOLDOWN = [90_000, 150_000] as const;
/** First backoff after a throttle signal (ms); doubles each retry up to the cap. */
const DEFAULT_THROTTLE_BACKOFF_MS = 60_000;
/** Ceiling on a single backoff sleep (ms). */
const DEFAULT_MAX_BACKOFF_MS = 300_000;
/** Stop the sweep after this many throttles with no success in between. */
const DEFAULT_MAX_CONSECUTIVE_THROTTLES = 4;

/** One withdraw attempt's classification. */
type AttemptOutcome = 'ok' | 'throttle' | 'skip';

/** The paginated sent-invitations read the sweep consumes (LiveSentInvitationsReader). */
interface SentInvitationsReadPort {
  read(accountId: string, limit: number): Promise<SentInvitation[]>;
}

/** Only the voyagerPost the withdraw needs off a live page. */
interface WithdrawPageProvider {
  pageFor(accountId: string): Promise<Pick<PagePort, 'voyagerPost'>>;
}

/** Narrow target surface the sweep needs: read the parked target and, on a
 * matched withdrawal, mark it lost (mirrors operator removal). */
type TargetStagePort = Pick<TargetRepoPort, 'findById' | 'setStage'>;

/** Narrow cursor surface: read parked cursors and advance the matched one out. */
type SweepSequencePort = Pick<
  SequenceStorePort,
  'awaitingConnectionEnrollments' | 'advanceTargetProgress'
>;

/** Tuning for the throttle-safe pacing. All optional; defaults are conservative.
 * Tests inject tiny/zero values (with a no-op sleep) to run without waiting.
 * Reachable through the exported StaleInvitationSweeperDeps['pacing']. */
interface WithdrawPacing {
  batchSize?: number;
  batchCooldownMs?: () => number;
  throttleBackoffMs?: number;
  maxBackoffMs?: number;
  maxConsecutiveThrottles?: number;
  /** Between-withdrawal gap; defaults to the human 8-20s action gap. */
  gapMs?: () => number;
}

export interface StaleInvitationSweeperDeps {
  reader: SentInvitationsReadPort;
  pages: WithdrawPageProvider;
  sequence: SweepSequencePort;
  targets: TargetStagePort;
  events: Pick<EventReadPort, 'append'>;
  outstanding?: StoreBackedOutstandingInvites;
  pacer?: StoreBackedActionPacer;
  now?: () => Date;
  /** Between-withdrawal sleeper; real randomized gaps by default, no-op in tests. */
  sleep?: Sleeper;
  /** RNG for the pacing gap; defaults to Math.random. */
  rng?: () => number;
  /** Throttle/pacing tuning; conservative defaults when omitted. */
  pacing?: WithdrawPacing;
}

export class StaleInvitationSweeper {
  private readonly reader: SentInvitationsReadPort;
  private readonly pages: WithdrawPageProvider;
  private readonly sequence: SweepSequencePort;
  private readonly targets: TargetStagePort;
  private readonly events: Pick<EventReadPort, 'append'>;
  private readonly outstanding?: StoreBackedOutstandingInvites;
  private readonly pacer?: StoreBackedActionPacer;
  private readonly now: () => Date;
  private readonly sleep: Sleeper;
  private readonly rng?: () => number;
  private readonly batchSize: number;
  private readonly batchCooldownMs: () => number;
  private readonly throttleBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxConsecutiveThrottles: number;
  private readonly gapMs: () => number;

  constructor(deps: StaleInvitationSweeperDeps) {
    this.reader = deps.reader;
    this.pages = deps.pages;
    this.sequence = deps.sequence;
    this.targets = deps.targets;
    this.events = deps.events;
    this.outstanding = deps.outstanding;
    this.pacer = deps.pacer;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.rng = deps.rng;
    const p = deps.pacing ?? {};
    this.batchSize = p.batchSize ?? DEFAULT_BATCH_SIZE;
    this.batchCooldownMs =
      p.batchCooldownMs ??
      (() => randInt(DEFAULT_BATCH_COOLDOWN[0], DEFAULT_BATCH_COOLDOWN[1], this.rng));
    this.throttleBackoffMs = p.throttleBackoffMs ?? DEFAULT_THROTTLE_BACKOFF_MS;
    this.maxBackoffMs = p.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxConsecutiveThrottles = p.maxConsecutiveThrottles ?? DEFAULT_MAX_CONSECUTIVE_THROTTLES;
    this.gapMs = p.gapMs ?? (() => actionGapMs(this.rng));
  }

  async withdrawStale(
    accountId: string,
    opts: { olderThanDays: number; max: number },
  ): Promise<WithdrawStaleResult> {
    const invites = await this.reader.read(accountId, 1000);
    const cutoff = this.now().getTime() - opts.olderThanDays * 86_400_000;
    // An invite with an unknown sentAt cannot be aged, so it is never swept.
    const aged = invites
      .filter((inv): inv is SentInvitation & { sentAt: Date } => !!inv.sentAt)
      .filter((inv) => inv.sentAt.getTime() <= cutoff)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    const agedTotal = aged.length;
    const stale = aged.slice(0, Math.min(opts.max, MAX_PER_SWEEP));

    const page = await this.pages.pageFor(accountId);
    const post = page.voyagerPost?.bind(page);
    const withdrawn: WithdrawStaleResult['withdrawn'] = [];
    let failed = 0;
    let releasedCursors = 0;
    let throttled = 0;
    let sinceCooldown = 0;
    let stopped: WithdrawStaleResult['stopped'] = 'completed';

    for (let i = 0; i < stale.length; i += 1) {
      const inv = stale[i]!;
      // Human gap before every withdrawal after the first.
      if (i > 0) await this.sleep(this.gapMs());
      // Proactive cooldown after a batch, to stay under the sustained-rate limit.
      if (sinceCooldown >= this.batchSize) {
        await this.sleep(this.batchCooldownMs());
        sinceCooldown = 0;
      }

      // Attempt, backing off on a throttle and retrying the SAME invite. Stop the
      // whole sweep if it keeps throttling: never hammer into a hard restriction.
      let outcome = await this.attempt(post, inv);
      let consecutive = 0;
      let backoff = this.throttleBackoffMs;
      while (outcome === 'throttle' && consecutive < this.maxConsecutiveThrottles) {
        throttled += 1;
        consecutive += 1;
        await this.sleep(Math.min(backoff, this.maxBackoffMs));
        backoff *= 2;
        outcome = await this.attempt(post, inv);
      }
      if (outcome === 'throttle') {
        throttled += 1;
        stopped = 'throttled';
        break;
      }
      if (outcome === 'skip') {
        failed += 1;
        continue;
      }

      // Success. The session was driven; keep the pacer warm so the next action
      // spaces off it. Release a parked campaign cursor this invite belongs to, if
      // any — only a matched cursor decrements the outstanding counter.
      this.pacer?.record(accountId, this.now());
      const released = await this.releaseParkedCursor(accountId, inv);
      if (released) {
        releasedCursors += 1;
        this.outstanding?.release(accountId);
      }
      await this.events.append({
        accountId,
        kind: 'invite_withdrawn',
        payload: {
          ...(inv.publicIdentifier ? { publicIdentifier: inv.publicIdentifier } : {}),
          invitationUrn: inv.invitationUrn,
          sentAt: inv.sentAt.toISOString(),
          releasedCursor: released,
          via: 'stale_sweep',
        },
      });
      withdrawn.push({
        ...(inv.publicIdentifier ? { publicIdentifier: inv.publicIdentifier } : {}),
        sentAt: inv.sentAt.toISOString(),
      });
      sinceCooldown += 1;
    }

    // 'max_reached' means the cap left aged invites unattempted; a permanent
    // per-invite failure (already gone) is NOT that. `remaining` excludes those
    // failures (they won't reappear on a re-read) but includes everything left
    // unattempted, so a re-run clears exactly what it reports.
    if (stopped !== 'throttled') {
      stopped = stale.length < agedTotal ? 'max_reached' : 'completed';
    }
    return {
      considered: stale.length,
      withdrawn,
      failed,
      releasedCursors,
      throttled,
      remaining: agedTotal - withdrawn.length - failed,
      stopped,
    };
  }

  /**
   * Fire one withdraw and classify the result. A 2xx is success; 429/999/403 or a
   * thrown fetch ("Failed to fetch" is how LinkedIn blocks the request outright)
   * is a throttle the caller should back off on; any other status is a permanent
   * per-invite failure (already withdrawn/accepted) that is skipped, not retried.
   */
  private async attempt(
    post: PagePort['voyagerPost'] | undefined,
    inv: SentInvitation,
  ): Promise<AttemptOutcome> {
    if (!post) return 'skip';
    try {
      const { status } = await post(
        withdrawInvitationPath(invitationIdFromUrn(inv.invitationUrn)),
        WITHDRAW_INVITATION_BODY,
      );
      if (status >= 200 && status < 300) return 'ok';
      if (status === 429 || status === 999 || status === 403 || status === 0) return 'throttle';
      return 'skip';
    } catch {
      return 'throttle';
    }
  }

  /** Move the campaign target this invite belongs to out of 'awaiting_connection'
   * (stage 'lost', cursor terminal 'skipped') so a ~3-week re-invite lockout never
   * re-enqueues it. Returns true when a parked cursor matched. */
  private async releaseParkedCursor(accountId: string, inv: SentInvitation): Promise<boolean> {
    const parked = await this.sequence.awaitingConnectionEnrollments();
    for (const p of parked) {
      if (p.accountId !== accountId) continue;
      const target = await this.targets.findById(p.targetId);
      if (!target) continue;
      if (!matchesIdentity(inv.inviteeUrn ?? '', inv.profileUrl, target)) continue;
      await this.targets.setStage(p.targetId, 'lost');
      await this.sequence.advanceTargetProgress(p.id, { state: 'skipped', nextStepAt: null });
      return true;
    }
    return false;
  }
}
