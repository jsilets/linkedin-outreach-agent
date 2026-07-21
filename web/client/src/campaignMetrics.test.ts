import { describe, expect, it } from 'vitest';
import type { CampaignPerformance } from './api';
import { aggregate, buildFunnel, summarizeWork } from './campaignMetrics';

const perf = (over: Partial<CampaignPerformance> = {}): CampaignPerformance => ({
  invitesSent: 0,
  invitedTargets: 0,
  invitesAccepted: 0,
  messagesSent: 0,
  messagedTargets: 0,
  replies: 0,
  ...over,
});

describe('summarizeWork', () => {
  it('removes skipped from the denominator and counts terminal states as finished', () => {
    const w = summarizeWork(
      { replied: 5, completed: 10, failed: 3, awaiting_connection: 20, skipped: 31 },
      134,
    );
    expect(w.eligible).toBe(103);
    expect(w.skipped).toBe(31);
    expect(w.finished).toBe(18); // 5 + 10 + 3
    expect(w.finishedPct).toBe(17);
    expect(w.failed).toBe(3);
  });

  it('keeps withdrawn leads in the denominator but drops the never-invited', () => {
    // The invariant: a lead leaves the denominator only if this campaign never
    // invited them. 'withdrawn' means we DID invite and later took it back — a
    // real outcome — while 'already_invited' means an invite was already pending
    // so we sent none.
    const w = summarizeWork(
      { awaiting_connection: 20, withdrawn: 2, already_invited: 3, skipped: 5 },
      40,
    );
    expect(w.eligible).toBe(32); // 40 - 5 skipped - 3 already_invited
    expect(w.withdrawn).toBe(2);
    expect(w.alreadyInvited).toBe(3);
    expect(w.finished).toBe(2); // a withdrawn lead has no work left
  });

  it('never reports a stage above 100%: the invited numerator cannot exceed eligible', () => {
    // The regression. Two leads were invited and later had their (months-old)
    // invites withdrawn by the stale sweep. Reported as 'skipped' they left the
    // denominator while staying in invitedTargets, and the funnel read
    // "Invited 38 — 103% of 37 leads".
    const w = summarizeWork({ awaiting_connection: 22, withdrawn: 2, in_progress: 14 }, 38);
    const [invited] = buildFunnel(perf({ invitedTargets: 38 }), w.eligible);
    expect(w.eligible).toBe(38);
    expect(invited.rate).toBe(100);
    expect(invited.rate).toBeLessThanOrEqual(100);
  });

  it('groups queue-side states together and keeps their composition as parts', () => {
    const w = summarizeWork(
      { pending: 2, in_progress: 4, invite_queued: 1, message_queued: 3 },
      10,
    );
    const queue = w.groups.find((g) => g.key === 'queue');
    expect(queue?.count).toBe(10);
    expect(queue?.parts.map((p) => p.key).sort()).toEqual([
      'in_progress',
      'invite_queued',
      'message_queued',
      'pending',
    ]);
  });

  it('folds unknown states into the queue group rather than dropping them', () => {
    const w = summarizeWork({ some_new_state: 4 }, 4);
    const queue = w.groups.find((g) => g.key === 'queue');
    expect(queue?.count).toBe(4);
    expect(queue?.parts[0]?.key).toBe('some_new_state');
  });

  it('accounts for never-enrolled targets as not_enrolled', () => {
    const w = summarizeWork({ in_progress: 6 }, 10);
    const ne = w.groups.find((g) => g.key === 'not_enrolled');
    expect(ne?.count).toBe(4);
    // Bar always sums to the eligible population.
    expect(w.groups.reduce((a, g) => a + g.count, 0)).toBe(w.eligible);
  });

  it('handles the empty campaign without NaN or phantom groups', () => {
    const w = summarizeWork({}, 0);
    expect(w.eligible).toBe(0);
    expect(w.finishedPct).toBeNull();
    expect(w.groups).toEqual([]);
  });

  it('surfaces awaiting_approval as its own group', () => {
    const w = summarizeWork({ awaiting_approval: 28, in_progress: 2 }, 30);
    expect(w.needsApproval).toBe(28);
    expect(w.groups.find((g) => g.key === 'approval')?.count).toBe(28);
  });
});

describe('buildFunnel', () => {
  it('uses people counts and stage-over-stage conversion rates', () => {
    const stages = buildFunnel(
      perf({
        invitesSent: 62,
        invitedTargets: 60,
        invitesAccepted: 29,
        messagesSent: 39,
        messagedTargets: 19,
        replies: 5,
      }),
      103,
    );
    const by = Object.fromEntries(stages.map((s) => [s.key, s]));
    expect(by.invited?.count).toBe(60); // people, not the 62 send volume
    expect(by.invited?.rate).toBe(58); // 60/103
    expect(by.accepted?.rate).toBe(48); // 29/60 invited people
    expect(by.messaged?.sub).toBe('39 messages sent'); // volume demoted to a sub-line
    expect(by.replied?.rate).toBe(26); // 5/19 messaged people
  });

  it('renders null rates (em dash) instead of 0% when a denominator is 0', () => {
    const stages = buildFunnel(perf(), 0);
    for (const s of stages) expect(s.rate).toBeNull();
  });

  it('omits the volume sub-line when volume equals people', () => {
    const stages = buildFunnel(perf({ messagesSent: 4, messagedTargets: 4 }), 10);
    expect(stages.find((s) => s.key === 'messaged')?.sub).toBeNull();
  });

  it('tolerates a missing performance blob', () => {
    const stages = buildFunnel(undefined, 10);
    expect(stages.map((s) => s.count)).toEqual([0, 0, 0, 0]);
  });

  it('adds invited-then-removed leads back into the invited denominator', () => {
    // eligible (40) is the active pool with all skipped already removed. Ten of
    // those skipped had been invited, so honest coverage is 40 invited of 50, not
    // 40 of 40. Without this the removed-after-invite would vanish from the
    // denominator while staying in the numerator — the "94% invited" illusion.
    const stages = buildFunnel(
      perf({
        invitedTargets: 40,
        removedByStage: { atInvited: 10, atAccepted: 0, atMessaged: 0, atReplied: 0 },
      }),
      40,
    );
    const invited = stages.find((s) => s.key === 'invited');
    expect(invited?.rate).toBe(80); // 40 / (40 + 10)
    expect(invited?.rateOf).toBe('of 50 leads');
  });

  it('does not let a lead removed at a stage drag the next stage rate (exit)', () => {
    // 30 invited, 10 of them removed before they could accept. Their non-accept
    // was our choice, so the accept rate is 20/20 = 100%, not 20/30 = 67%.
    const stages = buildFunnel(
      perf({
        invitedTargets: 30,
        invitesAccepted: 20,
        removedByStage: { atInvited: 10, atAccepted: 0, atMessaged: 0, atReplied: 0 },
      }),
      20,
    );
    expect(stages.find((s) => s.key === 'accepted')?.rate).toBe(100);
  });

  it('applies exit semantics at the accepted and messaged rungs too', () => {
    const stages = buildFunnel(
      perf({
        invitedTargets: 30,
        invitesAccepted: 20,
        messagedTargets: 12,
        replies: 4,
        removedByStage: { atInvited: 0, atAccepted: 5, atMessaged: 4, atReplied: 0 },
      }),
      30,
    );
    const by = Object.fromEntries(stages.map((s) => [s.key, s]));
    expect(by.messaged?.rate).toBe(80); // 12 / (20 accepted - 5 removed-at-accepted)
    expect(by.replied?.rate).toBe(50); // 4 / (12 messaged - 4 removed-at-messaged)
  });

  it('never divides by a negative denominator', () => {
    const stages = buildFunnel(
      perf({
        invitedTargets: 3,
        invitesAccepted: 1,
        removedByStage: { atInvited: 5, atAccepted: 0, atMessaged: 0, atReplied: 0 },
      }),
      3,
    );
    // atInvited (5) exceeds invitedTargets (3) only in impossible data; the rate
    // must clamp to a null denominator rather than go negative.
    expect(stages.find((s) => s.key === 'accepted')?.rate).toBeNull();
  });
});

describe('aggregate', () => {
  it('sums histograms, target counts, and performance across campaigns', () => {
    const a = aggregate([
      {
        byProgressState: { replied: 1, skipped: 2 },
        targetCount: 10,
        performance: perf({ invitedTargets: 5, replies: 1 }),
      },
      {
        byProgressState: { replied: 2, in_progress: 3 },
        targetCount: 20,
        performance: perf({ invitedTargets: 8, replies: 2 }),
      },
      // performance may be absent on the wire.
      { byProgressState: { pending: 1 }, targetCount: 1 },
    ]);
    expect(a.targetCount).toBe(31);
    expect(a.byProgressState.replied).toBe(3);
    expect(a.performance.invitedTargets).toBe(13);
    expect(a.performance.replies).toBe(3);
  });
});
