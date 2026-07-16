// StaleInvitationSweeper: the operator remedy behind withdraw_sent_invitations.
// It reads the account's full pending-invite pile over the live Voyager endpoint,
// withdraws the OLDEST ones (paced apart), and — for any withdrawn invite that
// matches a campaign target still parked in 'awaiting_connection' — releases that
// cursor to terminal and decrements the outstanding-invite counter, mirroring the
// gated single-withdraw path.
//
// This is an operator remedy, not outreach: it fires no gated action row (the
// events journal is the trail, since an actions row's FKs require target +
// campaign, which a manual invite has neither of) and it does NOT charge the
// daily caps. It still records the pacer per withdrawal so the account's next
// real action stays spaced apart.

import type { PagePort } from '@loa/account-runner';
import {
  actionGapMs,
  invitationIdFromUrn,
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

/** Hard cap on how many invites one sweep may withdraw, whatever the caller asks. */
const MAX_PER_SWEEP = 25;

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
  }

  async withdrawStale(
    accountId: string,
    opts: { olderThanDays: number; max: number },
  ): Promise<WithdrawStaleResult> {
    const invites = await this.reader.read(accountId, 1000);
    const cutoff = this.now().getTime() - opts.olderThanDays * 86_400_000;
    // An invite with an unknown sentAt cannot be aged, so it is never swept.
    const stale = invites
      .filter((inv): inv is SentInvitation & { sentAt: Date } => !!inv.sentAt)
      .filter((inv) => inv.sentAt.getTime() <= cutoff)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .slice(0, Math.min(opts.max, MAX_PER_SWEEP));

    const page = await this.pages.pageFor(accountId);
    const post = page.voyagerPost?.bind(page);
    const withdrawn: WithdrawStaleResult['withdrawn'] = [];
    let failed = 0;
    let releasedCursors = 0;

    for (let i = 0; i < stale.length; i += 1) {
      const inv = stale[i]!;
      // Pace between withdrawals (not before the first): real randomized seconds.
      if (i > 0) await this.sleep(actionGapMs(this.rng));

      let ok = false;
      if (post) {
        try {
          const { status } = await post(
            withdrawInvitationPath(invitationIdFromUrn(inv.invitationUrn)),
            WITHDRAW_INVITATION_BODY,
          );
          ok = status >= 200 && status < 300;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        failed += 1;
        continue;
      }

      // The session was driven; keep the pacer warm so the next action spaces off it.
      this.pacer?.record(accountId, this.now());
      // Release a parked campaign cursor this invite belongs to, if any. Only a
      // matched cursor decrements the outstanding counter (a manual invite has none).
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
    }

    return { considered: stale.length, withdrawn, failed, releasedCursors };
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
