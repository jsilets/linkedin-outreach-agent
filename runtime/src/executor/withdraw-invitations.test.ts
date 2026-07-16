import type { SentInvitation } from '@loa/account-runner';
import type { db as shared } from '@loa/shared';
import { describe, expect, it, vi } from 'vitest';
import { StaleInvitationSweeper, type StaleInvitationSweeperDeps } from './withdraw-invitations.js';

// All fixtures use FICTIONAL names / slugs / urns — the repo is public.

const DAY = 86_400_000;
const NOW = new Date('2026-07-15T12:00:00.000Z');

function inv(overrides: Partial<SentInvitation> & { id: string }): SentInvitation {
  return {
    invitationUrn: `urn:li:fsd_invitation:${overrides.id}`,
    ...overrides,
  };
}

/** Records every withdraw POST; returns a canned status per call. */
class FakeWithdrawPage {
  readonly posts: string[] = [];
  constructor(private readonly status: number | number[] = 200) {}
  async voyagerPost(path: string): Promise<{ status: number; body: unknown }> {
    const idx = this.posts.length;
    this.posts.push(path);
    const status = Array.isArray(this.status) ? (this.status[idx] ?? 200) : this.status;
    return { status, body: null };
  }
}

function makeTarget(id: string, profileUrl: string): shared.TargetRow {
  return {
    id,
    linkedinUrn: `urn:li:fsd_profile:${id}`,
    externalContext: { profileUrl },
  } as unknown as shared.TargetRow;
}

function makeParked(
  progressId: string,
  targetId: string,
  accountId: string,
): shared.TargetProgressRow {
  return {
    id: progressId,
    targetId,
    accountId,
    campaignId: 'camp-1',
    currentStep: 0,
    state: 'awaiting_connection',
  } as unknown as shared.TargetProgressRow;
}

function makeDeps(opts: {
  invites: SentInvitation[];
  page: FakeWithdrawPage;
  parked?: shared.TargetProgressRow[];
  targets?: Record<string, shared.TargetRow>;
  pacing?: StaleInvitationSweeperDeps['pacing'];
}) {
  const appended: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const advanced: Array<{ id: string; patch: unknown }> = [];
  const staged: Array<{ id: string; stage: string }> = [];
  const release = vi.fn();
  const record = vi.fn();
  const targets = opts.targets ?? {};
  const sweeper = new StaleInvitationSweeper({
    reader: { read: async () => opts.invites },
    pages: { pageFor: async () => opts.page },
    sequence: {
      awaitingConnectionEnrollments: async () => opts.parked ?? [],
      advanceTargetProgress: async (id, patch) => {
        advanced.push({ id, patch });
      },
    },
    targets: {
      findById: async (id: string) => targets[id],
      setStage: async (id: string, stage: shared.TargetRow['stage']) => {
        staged.push({ id, stage });
        return targets[id]!;
      },
    },
    events: {
      append: async (row) => {
        appended.push({ kind: row.kind, payload: row.payload as Record<string, unknown> });
        return {} as shared.EventRow;
      },
    },
    outstanding: { release } as never,
    pacer: { record } as never,
    now: () => NOW,
    sleep: async () => {},
    // Zero-length cooldowns/backoffs so the throttle-safe pacing runs instantly
    // in tests; a no-op sleep means these never actually wait either way.
    pacing: {
      batchCooldownMs: () => 0,
      throttleBackoffMs: 0,
      maxBackoffMs: 0,
      gapMs: () => 0,
      ...opts.pacing,
    },
  });
  return { sweeper, appended, advanced, staged, release, record };
}

describe('StaleInvitationSweeper.withdrawStale', () => {
  it('withdraws only aged invites, oldest first, skipping unknown-sentAt', async () => {
    const invites = [
      inv({ id: '1', publicIdentifier: 'aa', sentAt: new Date(NOW.getTime() - 40 * DAY) }),
      inv({ id: '2', publicIdentifier: 'bb', sentAt: new Date(NOW.getTime() - 5 * DAY) }), // too new
      inv({ id: '3', publicIdentifier: 'cc', sentAt: new Date(NOW.getTime() - 60 * DAY) }),
      inv({ id: '4', publicIdentifier: 'dd' }), // unknown sentAt: never swept
    ];
    const page = new FakeWithdrawPage(200);
    const { sweeper, appended } = makeDeps({ invites, page });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });

    // Only #1 and #3 are old enough; #3 is oldest so it goes first.
    expect(res.considered).toBe(2);
    expect(res.withdrawn.map((w) => w.publicIdentifier)).toEqual(['cc', 'aa']);
    expect(res.failed).toBe(0);
    expect(page.posts[0]).toContain(encodeURIComponent('urn:li:fsd_invitation:3'));
    expect(appended.every((e) => e.kind === 'invite_withdrawn')).toBe(true);
    expect(appended[0]!.payload.via).toBe('stale_sweep');
  });

  it('caps the batch at MAX_PER_SWEEP (100) and reports the overflow as remaining', async () => {
    const invites = Array.from({ length: 120 }, (_v, i) =>
      inv({ id: `${i}`, sentAt: new Date(NOW.getTime() - (100 + i) * DAY) }),
    );
    const { sweeper } = makeDeps({ invites, page: new FakeWithdrawPage(200) });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 500 });
    expect(res.withdrawn).toHaveLength(100);
    expect(res.stopped).toBe('max_reached');
    expect(res.remaining).toBe(20);
  });

  it('releases a matching parked cursor and decrements outstanding, once', async () => {
    const profileUrl = 'https://www.linkedin.com/in/nora-quill/';
    const invites = [
      inv({
        id: '9',
        publicIdentifier: 'nora-quill',
        profileUrl,
        inviteeUrn: 'urn:li:fsd_profile:t-nora',
        sentAt: new Date(NOW.getTime() - 30 * DAY),
      }),
    ];
    const parked = [makeParked('prog-1', 't-nora', 'acct')];
    const targets = { 't-nora': makeTarget('t-nora', profileUrl) };
    const { sweeper, advanced, staged, release } = makeDeps({
      invites,
      page: new FakeWithdrawPage(200),
      parked,
      targets,
    });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });

    expect(res.releasedCursors).toBe(1);
    expect(staged).toEqual([{ id: 't-nora', stage: 'lost' }]);
    expect(advanced).toEqual([{ id: 'prog-1', patch: { state: 'skipped', nextStepAt: null } }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips a permanent per-invite failure (404) and keeps going', async () => {
    // 404 = already withdrawn/accepted. Skip it (count failed), do not retry, and
    // withdraw the next invite. A permanent failure is not throttle and not a stop.
    const invites = [
      inv({ id: '7', publicIdentifier: 'gone', sentAt: new Date(NOW.getTime() - 60 * DAY) }),
      inv({ id: '8', publicIdentifier: 'live', sentAt: new Date(NOW.getTime() - 30 * DAY) }),
    ];
    const { sweeper, appended } = makeDeps({ invites, page: new FakeWithdrawPage([404, 200]) });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });
    expect(res.failed).toBe(1);
    expect(res.withdrawn.map((w) => w.publicIdentifier)).toEqual(['live']);
    expect(res.throttled).toBe(0);
    expect(res.stopped).toBe('completed');
    expect(appended).toHaveLength(1); // only the successful one journals
  });

  it('backs off and RETRIES the same invite on a throttle (429), then succeeds', async () => {
    // First POST throttles, the retry after backoff succeeds — the invite is
    // withdrawn, not lost, and the throttle is counted.
    const invites = [
      inv({ id: '9', publicIdentifier: 'ok', sentAt: new Date(NOW.getTime() - 30 * DAY) }),
    ];
    const page = new FakeWithdrawPage([429, 200]);
    const { sweeper } = makeDeps({ invites, page });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });
    expect(res.withdrawn).toHaveLength(1);
    expect(res.throttled).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.stopped).toBe('completed');
    expect(page.posts).toHaveLength(2); // one throttled, one retried
  });

  it('STOPS on a sustained throttle instead of hammering, reporting the remainder', async () => {
    // A page that always throttles: after maxConsecutiveThrottles retries the
    // sweep must stop, leave the rest untouched, and report them as remaining.
    const invites = Array.from({ length: 4 }, (_v, i) =>
      inv({ id: `${i}`, sentAt: new Date(NOW.getTime() - (60 + i) * DAY) }),
    );
    const { sweeper, appended } = makeDeps({
      invites,
      page: new FakeWithdrawPage(429),
      pacing: { maxConsecutiveThrottles: 2 },
    });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });
    expect(res.stopped).toBe('throttled');
    expect(res.withdrawn).toHaveLength(0);
    expect(res.throttled).toBeGreaterThan(0);
    expect(res.remaining).toBe(4); // nothing cleared, all 4 still pending
    expect(appended).toHaveLength(0);
  });

  it('treats a thrown fetch ("Failed to fetch") as a throttle, not a skip', async () => {
    const invites = [inv({ id: '5', sentAt: new Date(NOW.getTime() - 30 * DAY) })];
    const throwingPage = {
      posts: [] as string[],
      async voyagerPost(path: string): Promise<{ status: number; body: unknown }> {
        this.posts.push(path);
        throw new Error('Failed to fetch');
      },
    };
    const { sweeper } = makeDeps({
      invites,
      page: throwingPage as unknown as FakeWithdrawPage,
      pacing: { maxConsecutiveThrottles: 1 },
    });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });
    expect(res.stopped).toBe('throttled');
    expect(res.throttled).toBeGreaterThan(0);
    expect(res.failed).toBe(0);
  });
});
