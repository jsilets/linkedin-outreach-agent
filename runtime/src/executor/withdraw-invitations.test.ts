import type { SentInvitation } from '@loa/account-runner';
import type { db as shared } from '@loa/shared';
import { describe, expect, it, vi } from 'vitest';
import { StaleInvitationSweeper } from './withdraw-invitations.js';

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

  it('caps the batch at 25 even when max is higher', async () => {
    const invites = Array.from({ length: 30 }, (_v, i) =>
      inv({ id: `${i}`, sentAt: new Date(NOW.getTime() - (100 + i) * DAY) }),
    );
    const { sweeper } = makeDeps({ invites, page: new FakeWithdrawPage(200) });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 100 });
    expect(res.withdrawn).toHaveLength(25);
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

  it('counts a non-2xx withdraw as failed and appends no event', async () => {
    const invites = [inv({ id: '7', sentAt: new Date(NOW.getTime() - 30 * DAY) })];
    const { sweeper, appended } = makeDeps({ invites, page: new FakeWithdrawPage(429) });
    const res = await sweeper.withdrawStale('acct', { olderThanDays: 21, max: 25 });
    expect(res).toMatchObject({ considered: 1, failed: 1, releasedCursors: 0 });
    expect(res.withdrawn).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });
});
