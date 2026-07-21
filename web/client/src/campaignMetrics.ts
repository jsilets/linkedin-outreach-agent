// Pure derivations behind the campaign progress + funnel displays. Two distinct
// questions, kept deliberately separate (conflating them is what made the old
// cards unreadable):
//
//   1. WORK — how far along is the campaign, and who holds the next move?
//      Derived from the progress-state histogram, grouped into a handful of
//      operator-meaningful buckets ("in queue" = we act next, "awaiting
//      acceptance" = they act next, ...).
//   2. OUTCOMES — is it working? A people-count funnel (invited → accepted →
//      messaged → replied) with a conversion rate at each stage.
//
// The denominator rule, and the invariant it rests on: a lead leaves every
// denominator only if THIS CAMPAIGN NEVER INVITED THEM. Anyone we invited is a
// campaign outcome and stays, however it ended.
//
//   skipped         — out. A sourcing failure; we never contacted them.
//   already_invited — out. An invite to them was already pending, so connect sent
//                     nothing and this campaign never invited them.
//   withdrawn       — IN. We invited them and later withdrew it. A real outcome.
//   failed          — IN, counts as finished (no work remains), always surfaced
//                     separately: a failure is a signal, never hidden.
//
// Get this wrong and the funnel divides by a population the numerator does not
// share. It did: withdrawn leads were reported as 'skipped', so the invited
// numerator counted them (they were invited) while the denominator dropped them,
// and a campaign read "Invited 38 — 103% of 37 leads" the morning the stale
// invitation sweep first withdrew two live cursors.

import type { CampaignPerformance } from './api';

type Counts = Record<string, number>;

/** One grouped slice of the work bar. `keys` are the raw progress-state buckets
 * folded into it, retained so a tooltip can show the exact composition. */
interface WorkGroup {
  key:
    | 'replied'
    | 'completed'
    | 'failed'
    | 'withdrawn'
    | 'waiting'
    | 'approval'
    | 'queue'
    | 'not_enrolled';
  label: string;
  /** What the group means, in operator terms — the tooltip body. */
  detail: string;
  varName: string;
  count: number;
  parts: Array<{ key: string; label: string; count: number }>;
}

export interface WorkSummary {
  /** targetCount minus the never-invited (skipped + already_invited): the
   * denominator everywhere. See the invariant at the top of this file. */
  eligible: number;
  skipped: number;
  /** Leads an invite was already outstanding for, so this campaign sent none. */
  alreadyInvited: number;
  /** Leads we invited and then withdrew. In the denominator: they were invited. */
  withdrawn: number;
  /** Terminal leads (replied + completed + failed): no work remains. */
  finished: number;
  /** finished / eligible, 0..100, or null when eligible is 0. */
  finishedPct: number | null;
  failed: number;
  needsApproval: number;
  /** Non-empty groups in bar order (finished outcomes first, then waiting,
   * approval, queue, not-enrolled). */
  groups: WorkGroup[];
}

const RAW_LABELS: Record<string, string> = {
  pending: 'Enrolled, not started',
  in_progress: 'Stepping through the sequence',
  invite_queued: 'Invite queued to send',
  message_queued: 'Message queued to send',
  awaiting_connection: 'Invite sent, awaiting acceptance',
  awaiting_approval: 'Draft waiting on your approval',
  replied: 'Replied',
  completed: 'Sequence finished, no reply',
  failed: 'Failed',
  skipped: 'Skipped',
  withdrawn: 'Invite withdrawn',
  already_invited: 'Invite already pending — none sent',
};

function rawLabel(key: string): string {
  return RAW_LABELS[key] ?? key.replace(/_/g, ' ');
}

// Raw progress-state keys folded into each group. Any histogram key not claimed
// here (and not `skipped`) falls into `queue`: an unknown state is still "the
// system holds the next move", which fails legible rather than invisible.
const GROUP_DEFS: Array<{
  key: WorkGroup['key'];
  label: string;
  detail: string;
  varName: string;
  keys: string[];
}> = [
  {
    key: 'replied',
    label: 'Replied',
    detail: 'The lead wrote back — the campaign goal.',
    varName: '--st-replied',
    keys: ['replied'],
  },
  {
    key: 'completed',
    label: 'Finished',
    detail: 'Every step ran; no reply came.',
    varName: '--st-done',
    keys: ['completed'],
  },
  {
    key: 'failed',
    label: 'Failed',
    detail: 'An action errored and the lead stopped. Worth a look.',
    varName: '--st-failed',
    keys: ['failed'],
  },
  {
    key: 'withdrawn',
    label: 'Withdrawn',
    detail: 'We invited them, then withdrew the invite before they accepted.',
    varName: '--st-done',
    keys: ['withdrawn'],
  },
  {
    key: 'waiting',
    label: 'Awaiting acceptance',
    detail: 'Invite is out; the next move is theirs.',
    varName: '--st-waiting',
    keys: ['awaiting_connection'],
  },
  {
    key: 'approval',
    label: 'Needs approval',
    detail: 'A draft is waiting on you before it can send.',
    varName: '--st-approval',
    keys: ['awaiting_approval'],
  },
  {
    key: 'queue',
    label: 'In queue',
    detail: 'The system acts next: sends pacing out under the daily caps.',
    varName: '--st-active',
    keys: ['pending', 'in_progress', 'invite_queued', 'message_queued'],
  },
];

/** Progress states of leads this campaign never invited. Removed from every
 * denominator; never rendered as a work group. */
const NEVER_INVITED_KEYS = ['skipped', 'already_invited'] as const;

const CLAIMED_KEYS = new Set(GROUP_DEFS.flatMap((g) => g.keys).concat(NEVER_INVITED_KEYS));

/**
 * Group a campaign's progress-state histogram into the work summary. Leads that
 * exist as targets but were never enrolled show as `not_enrolled` so the bar
 * always accounts for the full eligible population (targetCount minus the
 * never-invited).
 */
export function summarizeWork(byProgressState: Counts, targetCount: number): WorkSummary {
  const counts = byProgressState ?? {};
  const skipped = counts.skipped ?? 0;
  const alreadyInvited = counts.already_invited ?? 0;
  const withdrawn = counts.withdrawn ?? 0;
  const eligible = Math.max(0, targetCount - skipped - alreadyInvited);

  const groups: WorkGroup[] = [];
  let accounted = 0;
  for (const def of GROUP_DEFS) {
    const parts = def.keys
      .map((k) => ({ key: k, label: rawLabel(k), count: counts[k] ?? 0 }))
      .filter((p) => p.count > 0);
    // Unclaimed states fold into the queue group (see GROUP_DEFS note).
    if (def.key === 'queue') {
      for (const [k, n] of Object.entries(counts)) {
        if (n > 0 && !CLAIMED_KEYS.has(k)) parts.push({ key: k, label: rawLabel(k), count: n });
      }
    }
    const count = parts.reduce((a, p) => a + p.count, 0);
    accounted += count;
    if (count > 0) {
      groups.push({
        key: def.key,
        label: def.label,
        detail: def.detail,
        varName: def.varName,
        count,
        parts,
      });
    }
  }

  const notEnrolled = Math.max(0, eligible - accounted);
  if (notEnrolled > 0) {
    groups.push({
      key: 'not_enrolled',
      label: 'Not enrolled',
      detail: 'Targets not yet launched into the sequence.',
      varName: '--st-idle',
      count: notEnrolled,
      parts: [{ key: 'not_enrolled', label: 'Not enrolled', count: notEnrolled }],
    });
  }

  // Withdrawn is finished: they were invited, we took it back, no work remains.
  const finished =
    (counts.replied ?? 0) + (counts.completed ?? 0) + (counts.failed ?? 0) + withdrawn;
  return {
    eligible,
    skipped,
    alreadyInvited,
    withdrawn,
    finished,
    finishedPct: eligible > 0 ? Math.round((finished / eligible) * 100) : null,
    failed: counts.failed ?? 0,
    needsApproval: counts.awaiting_approval ?? 0,
    groups,
  };
}

/** One stage of the outcome funnel. Counts are PEOPLE (distinct targets); the
 * only volume number in the display is the messages-sent sub-line. */
export interface FunnelStage {
  key: 'invited' | 'accepted' | 'messaged' | 'replied';
  label: string;
  count: number;
  /** Conversion vs the previous stage (invited converts vs eligible), 0..100,
   * or null when the denominator is 0 — render an em dash, never "0%". */
  rate: number | null;
  /** What the rate is a share of, for the sub-label ("of 103 leads"). */
  rateOf: string;
  /** Extra context line (e.g. "39 messages sent" under messaged). */
  sub: string | null;
}

function pct(num: number, denom: number): number | null {
  return denom > 0 ? Math.round((num / denom) * 100) : null;
}

/**
 * The people-count outcome funnel. Each stage's rate is conversion from the
 * stage before it, so the numbers answer "where do leads drop off": invited
 * coverage of the eligible pool, acceptance of invites, replies per person
 * messaged.
 */
export function buildFunnel(
  performance: CampaignPerformance | undefined,
  eligible: number,
): FunnelStage[] {
  const p = performance;
  const invited = p?.invitedTargets ?? 0;
  const accepted = p?.invitesAccepted ?? 0;
  const messaged = p?.messagedTargets ?? 0;
  const messagesSent = p?.messagesSent ?? 0;
  const replied = p?.replies ?? 0;

  // Exit semantics for removed leads. A lead we pulled after inviting it is
  // counted through the furthest stage it reached (its invite/accept/message are
  // real, persisted facts, already in the numerators above), then it leaves the
  // funnel. So each removed lead is added back to the invited-coverage
  // denominator — we DID invite it — but dropped from the denominator of every
  // stage past where it exited, so a lead we deliberately removed is never scored
  // as a prospect who declined. `eligible` here is the active pool (all skipped
  // already removed), so we only add the invited-then-removed back on.
  const rm = p?.removedByStage;
  const atInvited = rm?.atInvited ?? 0;
  const atAccepted = rm?.atAccepted ?? 0;
  const atMessaged = rm?.atMessaged ?? 0;
  const removedAfterInvite = atInvited + atAccepted + atMessaged + (rm?.atReplied ?? 0);
  const invitedDenom = eligible + removedAfterInvite;
  const acceptDenom = Math.max(0, invited - atInvited);
  const messagedDenom = Math.max(0, accepted - atAccepted);
  const repliedDenom = Math.max(0, messaged - atMessaged);

  return [
    {
      key: 'invited',
      label: 'Invited',
      count: invited,
      rate: pct(invited, invitedDenom),
      rateOf: `of ${invitedDenom} lead${invitedDenom === 1 ? '' : 's'}`,
      sub: null,
    },
    {
      key: 'accepted',
      label: 'Accepted',
      count: accepted,
      rate: pct(accepted, acceptDenom),
      rateOf: 'of invited',
      sub: null,
    },
    {
      key: 'messaged',
      label: 'Messaged',
      count: messaged,
      rate: pct(messaged, messagedDenom),
      rateOf: 'of accepted',
      sub: messagesSent > messaged ? `${messagesSent} messages sent` : null,
    },
    {
      key: 'replied',
      label: 'Replied',
      count: replied,
      rate: pct(replied, repliedDenom),
      rateOf: 'of messaged',
      sub: null,
    },
  ];
}

/** Sum histograms/performance across campaigns for the dashboard roll-up. */
export function aggregate(
  campaigns: Array<{
    byProgressState: Counts;
    targetCount: number;
    performance?: CampaignPerformance;
  }>,
): { byProgressState: Counts; targetCount: number; performance: CampaignPerformance } {
  const byProgressState: Counts = {};
  let targetCount = 0;
  const performance: CampaignPerformance = {
    invitesSent: 0,
    invitedTargets: 0,
    invitesAccepted: 0,
    messagesSent: 0,
    messagedTargets: 0,
    replies: 0,
    removedByStage: { atInvited: 0, atAccepted: 0, atMessaged: 0, atReplied: 0 },
  };
  const rbs = performance.removedByStage!;
  for (const c of campaigns) {
    targetCount += c.targetCount;
    for (const [k, n] of Object.entries(c.byProgressState ?? {})) {
      byProgressState[k] = (byProgressState[k] ?? 0) + n;
    }
    const p = c.performance;
    if (!p) continue;
    performance.invitesSent += p.invitesSent ?? 0;
    performance.invitedTargets += p.invitedTargets ?? 0;
    performance.invitesAccepted += p.invitesAccepted ?? 0;
    performance.messagesSent += p.messagesSent ?? 0;
    performance.messagedTargets += p.messagedTargets ?? 0;
    performance.replies += p.replies ?? 0;
    if (p.removedByStage) {
      rbs.atInvited += p.removedByStage.atInvited;
      rbs.atAccepted += p.removedByStage.atAccepted;
      rbs.atMessaged += p.removedByStage.atMessaged;
      rbs.atReplied += p.removedByStage.atReplied;
    }
  }
  return { byProgressState, targetCount, performance };
}
