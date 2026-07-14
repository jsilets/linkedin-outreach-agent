// The volume query is asserted at the SQL level: postgres.js does not open a
// connection until a query actually runs, and drizzle's .toSQL() only builds
// the statement, so no live DB is needed here.
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://loa:loa@localhost:5432/loa';

// Import lazily so the dummy DATABASE_URL is in place first.
let buildVolumeQuery: typeof import('./queries.js').buildVolumeQuery;
let campaignDeleteStatements: typeof import('./queries.js').campaignDeleteStatements;
let buildErrorEventsQuery: typeof import('./queries.js').buildErrorEventsQuery;
let buildFailedActionsQuery: typeof import('./queries.js').buildFailedActionsQuery;
let buildApprovedMessagesQuery: typeof import('./queries.js').buildApprovedMessagesQuery;
let buildApprovedQueuedCountsQuery: typeof import('./queries.js').buildApprovedQueuedCountsQuery;
let splitApprovedQueued: typeof import('./queries.js').splitApprovedQueued;
let leadFunnelBucket: typeof import('./queries.js').leadFunnelBucket;
let buildActivityActionsQuery: typeof import('./queries.js').buildActivityActionsQuery;
let buildReplyActivityQuery: typeof import('./queries.js').buildReplyActivityQuery;
let buildCampaignPerformanceActionsQuery: typeof import('./queries.js').buildCampaignPerformanceActionsQuery;
let deriveApprovedQueued: typeof import('./queries.js').deriveApprovedQueued;
let readLeadContext: typeof import('./queries.js').readLeadContext;
let groupInboxRows: typeof import('./queries.js').groupInboxRows;
let deriveReplyDetectorHealth: typeof import('./queries.js').deriveReplyDetectorHealth;
let projectScheduledSends: typeof import('./queries.js').projectScheduledSends;
let db: typeof import('./db.js').db;

beforeAll(async () => {
  ({
    buildVolumeQuery,
    campaignDeleteStatements,
    buildErrorEventsQuery,
    buildFailedActionsQuery,
    buildApprovedMessagesQuery,
    buildApprovedQueuedCountsQuery,
    splitApprovedQueued,
    leadFunnelBucket,
    buildActivityActionsQuery,
    buildReplyActivityQuery,
    buildCampaignPerformanceActionsQuery,
    deriveApprovedQueued,
    readLeadContext,
    groupInboxRows,
    deriveReplyDetectorHealth,
    projectScheduledSends,
  } = await import('./queries.js'));
  ({ db } = await import('./db.js'));
});

describe('buildVolumeQuery', () => {
  it('filters to successful actions and groups by day + type', () => {
    const { sql, params } = buildVolumeQuery({ days: 30 }).toSQL();
    expect(sql).toContain('"actions"');
    expect(sql).toContain('date_trunc');
    expect(sql).toContain('group by');
    // result='success' is a bound param, not inlined.
    expect(params).toContain('success');
    // No account filter when accountId is omitted.
    expect(sql).not.toContain('"account_id" =');
  });

  it('adds an account filter when accountId is given', () => {
    const { sql, params } = buildVolumeQuery({
      accountId: '11111111-1111-1111-1111-111111111111',
      days: 7,
    }).toSQL();
    expect(sql).toContain('"account_id"');
    expect(params).toContain('11111111-1111-1111-1111-111111111111');
    expect(params).toContain(7);
  });

  it('honors the days window in the interval expression', () => {
    const { params } = buildVolumeQuery({ days: 90 }).toSQL();
    expect(params).toContain(90);
  });
});

describe('groupInboxRows', () => {
  const at = (value: string) => new Date(value);

  it('joins local pending and LinkedIn thread refs into one person-centric conversation', () => {
    const rows = [
      {
        messageId: 'draft',
        accountId: 'acct-1',
        targetId: 'target-1',
        externalContext: { name: 'Ada Lovelace', company: 'Analytical Engines' },
        campaignGoal: 'Intro meetings',
        direction: 'outbound' as const,
        body: 'Hi Ada',
        status: 'draft',
        intent: null,
        pendingReq: { type: 'message' },
        createdAt: at('2026-07-14T10:00:00.000Z'),
      },
      {
        messageId: 'reply',
        accountId: 'acct-1',
        targetId: 'target-1',
        externalContext: { name: 'Ada Lovelace', company: 'Analytical Engines' },
        campaignGoal: 'Intro meetings',
        direction: 'inbound' as const,
        body: 'Happy to chat.',
        status: 'sent',
        intent: 'Interested',
        pendingReq: null,
        createdAt: at('2026-07-14T11:00:00.000Z'),
      },
    ];
    const inbox = groupInboxRows(rows);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: 'acct-1:target-1',
      name: 'Ada Lovelace',
      needsApproval: true,
      hasInbound: true,
      latestPreview: 'Happy to chat.',
    });
    expect(inbox[0]?.messages.map((message) => message.id)).toEqual(['draft', 'reply']);
  });

  it('omits cancelled drafts from the operator inbox entirely', () => {
    const inbox = groupInboxRows([
      {
        messageId: 'cancelled',
        accountId: 'acct-1',
        targetId: 'target-1',
        externalContext: {},
        campaignGoal: null,
        direction: 'outbound' as const,
        body: 'Never send this',
        status: 'cancelled',
        intent: null,
        pendingReq: { type: 'message' },
        createdAt: at('2026-07-14T10:00:00.000Z'),
      },
    ]);
    expect(inbox).toEqual([]);
  });

  it('carries a pending follow-up eligibility time into the inbox', () => {
    const inbox = groupInboxRows([
      {
        messageId: 'draft',
        accountId: 'acct-1',
        targetId: 'target-1',
        externalContext: {},
        campaignGoal: null,
        direction: 'outbound' as const,
        body: 'Follow up',
        status: 'draft',
        intent: null,
        pendingReq: { type: 'message' },
        nextStepAt: at('2026-07-15T10:00:00.000Z'),
        createdAt: at('2026-07-14T10:00:00.000Z'),
      },
    ]);
    expect(inbox[0]?.messages[0]?.eligibleAt).toBe('2026-07-15T10:00:00.000Z');
  });
});

describe('deriveReplyDetectorHealth', () => {
  const now = new Date('2026-07-14T20:00:00.000Z');

  it('reports a completed scan and its unmatched-thread coverage', () => {
    const health = deriveReplyDetectorHealth(
      [
        {
          kind: 'reply_detector_started',
          ts: new Date('2026-07-14T19:00:00.000Z'),
          payload: { intervalMs: 1_800_000 },
        },
        {
          kind: 'reply_scan_succeeded',
          ts: new Date('2026-07-14T19:45:00.000Z'),
          payload: {
            accounts: 1,
            listedThreads: 20,
            mappedThreads: 3,
            unmatchedThreads: 17,
            unmatchedInboundMessages: 2,
          },
        },
      ],
      now,
    );
    expect(health).toMatchObject({
      status: 'healthy',
      lastSuccessfulScanAt: '2026-07-14T19:45:00.000Z',
      coverage: { unmatchedThreads: 17, unmatchedInboundMessages: 2 },
    });
  });

  it('makes a failed LinkedIn read visible even if no inbound messages were persisted', () => {
    const health = deriveReplyDetectorHealth(
      [
        {
          kind: 'reply_scan_failed',
          ts: new Date('2026-07-14T19:55:00.000Z'),
          payload: { phase: 'thread_history', error: 'HTTP 404' },
        },
      ],
      now,
    );
    expect(health).toEqual({
      status: 'failing',
      lastSuccessfulScanAt: null,
      error: { at: '2026-07-14T19:55:00.000Z', phase: 'thread_history', message: 'HTTP 404' },
      coverage: null,
    });
  });

  it('marks a once-working detector stale after two configured intervals', () => {
    const health = deriveReplyDetectorHealth(
      [
        {
          kind: 'reply_detector_started',
          ts: new Date('2026-07-14T18:00:00.000Z'),
          payload: { intervalMs: 1_000 },
        },
        {
          kind: 'reply_scan_succeeded',
          ts: new Date('2026-07-14T18:00:00.000Z'),
          payload: {},
        },
      ],
      now,
    );
    expect(health.status).toBe('stale');
  });
});

describe('campaignDeleteStatements', () => {
  const id = '22222222-2222-2222-2222-222222222222';

  it('clears dependents before the campaign, in FK-safe order', () => {
    const tables = campaignDeleteStatements(db, id).map((stmt) => {
      const sql = stmt.toSQL().sql;
      const match = /delete from "([a-z_]+)"/.exec(sql);
      return match?.[1];
    });
    expect(tables).toEqual([
      'target_progress',
      'actions',
      'messages',
      'targets',
      'campaign_steps',
      'campaigns',
    ]);
  });

  it('deletes messages via the campaign targets subquery', () => {
    const [, , messagesDelete] = campaignDeleteStatements(db, id);
    const { sql, params } = messagesDelete.toSQL();
    // messages have no campaign_id; they are removed by target_id in (targets of this campaign).
    expect(sql).toContain('"messages"');
    expect(sql).toMatch(/"target_id" in \(select .* from "targets"/i);
    expect(params).toContain(id);
  });

  it('scopes every dependent delete to the campaign id', () => {
    for (const stmt of campaignDeleteStatements(db, id)) {
      expect(stmt.toSQL().params).toContain(id);
    }
  });
});

describe('buildErrorEventsQuery', () => {
  it('filters events to failure-ish kinds by suffix with an escaped underscore', () => {
    const { sql, params } = buildErrorEventsQuery(24).toSQL();
    expect(sql).toContain('"events"');
    // Both shared suffixes become escaped LIKE patterns (underscore is a wildcard).
    expect(sql).toContain('LIKE');
    expect(sql).toContain("ESCAPE '\\'");
    expect(params).toContain('%\\_failed');
    expect(params).toContain('%\\_cancelled');
  });

  it('pulls campaign/target context out of the jsonb payload', () => {
    const { sql } = buildErrorEventsQuery(24).toSQL();
    expect(sql).toContain("->>'campaignId'");
    expect(sql).toContain("->>'targetId'");
  });

  it('honors the hours lookback in the interval expression', () => {
    const { params } = buildErrorEventsQuery(72).toSQL();
    expect(params).toContain(72);
  });
});

describe('buildFailedActionsQuery', () => {
  it('filters actions to result=failed within the window', () => {
    const { sql, params } = buildFailedActionsQuery(24).toSQL();
    expect(sql).toContain('"actions"');
    // result='failed' is a bound param.
    expect(params).toContain('failed');
    expect(params).toContain(24);
    // Windowed by executed-else-scheduled time.
    expect(sql).toContain('coalesce');
  });
});

describe('deriveApprovedQueued', () => {
  it('is true only at awaiting_approval with no pending draft and an approved message', () => {
    expect(deriveApprovedQueued('awaiting_approval', false, true)).toBe(true);
  });

  it('is false when a pending draft still awaits approval', () => {
    // A live draft binding means "needs approval", not "send queued".
    expect(deriveApprovedQueued('awaiting_approval', true, true)).toBe(false);
  });

  it('is false without an approved message', () => {
    expect(deriveApprovedQueued('awaiting_approval', false, false)).toBe(false);
  });

  it('is false for any other cursor state', () => {
    expect(deriveApprovedQueued('in_progress', false, true)).toBe(false);
    expect(deriveApprovedQueued(null, false, true)).toBe(false);
  });
});

describe('buildApprovedMessagesQuery', () => {
  const campaignId = '63f1cd27-0000-0000-0000-000000000000';

  it('groups approved outbound messages by target for one campaign', () => {
    const { sql, params } = buildApprovedMessagesQuery(campaignId).toSQL();
    expect(sql).toContain('"messages"');
    // status='approved' and direction='outbound' are bound params.
    expect(params).toContain('approved');
    expect(params).toContain('outbound');
    expect(params).toContain(campaignId);
    expect(sql).toContain('group by');
  });

  it('projects the queued action type out of the pending_req blob', () => {
    const { sql } = buildApprovedMessagesQuery(campaignId).toSQL();
    expect(sql).toContain("->> 'type'");
  });
});

describe('buildApprovedQueuedCountsQuery', () => {
  it('finds awaiting_approval targets with an approved item and no pending draft', () => {
    const { sql, params } = buildApprovedQueuedCountsQuery().toSQL();
    expect(sql).toContain('"target_progress"');
    expect(sql).toContain('"messages"');
    // awaiting_approval cursor + approved outbound item are bound params.
    expect(params).toContain('awaiting_approval');
    expect(params).toContain('approved');
    expect(params).toContain('outbound');
    // A NOT EXISTS excludes targets that still have a draft awaiting approval.
    expect(sql.toLowerCase()).toContain('not exists');
    expect(sql).toContain("->> 'type'");
    expect(sql).toContain('group by');
  });

  it('scopes to one campaign when given', () => {
    const campaignId = '63f1cd27-2222-2222-2222-222222222222';
    const { params } = buildApprovedQueuedCountsQuery(campaignId).toSQL();
    expect(params).toContain(campaignId);
  });
});

describe('splitApprovedQueued', () => {
  it('moves message-typed approved-queued leads into message_queued', () => {
    const out = splitApprovedQueued({ awaiting_approval: 3, in_progress: 5 }, { message: 3 });
    expect(out.message_queued).toBe(3);
    expect(out.awaiting_approval).toBeUndefined();
    expect(out.in_progress).toBe(5);
  });

  it('buckets connect-typed leads as invite_queued and keeps true drafts', () => {
    const out = splitApprovedQueued({ awaiting_approval: 4 }, { connect: 1, message: 1 });
    expect(out.invite_queued).toBe(1);
    expect(out.message_queued).toBe(1);
    // Two of four moved out; two true drafts remain.
    expect(out.awaiting_approval).toBe(2);
  });

  it('defaults an unknown/missing type to message_queued', () => {
    const out = splitApprovedQueued({ awaiting_approval: 1 }, { message: 1 });
    expect(out.message_queued).toBe(1);
    expect(out.awaiting_approval).toBeUndefined();
  });

  it('is a no-op when nothing is approved-queued', () => {
    const out = splitApprovedQueued({ awaiting_approval: 2 }, {});
    expect(out).toEqual({ awaiting_approval: 2 });
  });
});

describe('leadFunnelBucket', () => {
  const base = { stage: 'invited', approvedQueued: false, queuedActionType: null };

  it('reports message_queued / invite_queued for approved-queued leads by action type', () => {
    expect(
      leadFunnelBucket({
        ...base,
        progressState: 'awaiting_approval',
        approvedQueued: true,
        queuedActionType: 'message',
      }),
    ).toBe('message_queued');
    expect(
      leadFunnelBucket({
        ...base,
        progressState: 'awaiting_approval',
        approvedQueued: true,
        queuedActionType: 'connect',
      }),
    ).toBe('invite_queued');
  });

  it('keeps a true-draft awaiting_approval lead in awaiting_approval', () => {
    expect(leadFunnelBucket({ ...base, progressState: 'awaiting_approval' })).toBe(
      'awaiting_approval',
    );
  });

  it('falls back to the stage when unenrolled', () => {
    expect(leadFunnelBucket({ ...base, progressState: null })).toBe('invited');
  });
});

describe('buildActivityActionsQuery', () => {
  it('projects the target name and profileUrl out of external_context', () => {
    const { sql } = buildActivityActionsQuery({ limit: 50 }).toSQL();
    expect(sql).toContain('"actions"');
    expect(sql).toContain("->>'name'");
    expect(sql).toContain("->>'profileUrl'");
  });

  it('scopes to one campaign when given', () => {
    const campaignId = '63f1cd27-1111-1111-1111-111111111111';
    const { sql, params } = buildActivityActionsQuery({ campaignId, limit: 10 }).toSQL();
    expect(sql).toContain('"campaign_id"');
    expect(params).toContain(campaignId);
    expect(params).toContain(10);
  });

  it('correlates the failure reason from the matching action_failed event', () => {
    const { sql } = buildActivityActionsQuery({ limit: 50 }).toSQL();
    // A scalar subquery pulls detail from the action_failed event keyed by actionId.
    expect(sql).toContain('"events"');
    expect(sql).toContain("->>'detail'");
    expect(sql).toContain("->>'actionId'");
    expect(sql).toContain('action_failed%');
  });
});

describe('buildReplyActivityQuery', () => {
  it('projects persisted inbound messages into the activity timeline', () => {
    const { sql, params } = buildReplyActivityQuery({ limit: 50 }).toSQL();
    expect(sql).toContain('"messages"');
    expect(sql).toContain('"targets"');
    expect(params).toContain('inbound');
  });

  it('scopes reply activity to one campaign when requested', () => {
    const campaignId = '33333333-3333-3333-3333-333333333333';
    const { params } = buildReplyActivityQuery({ campaignId, limit: 10 }).toSQL();
    expect(params).toContain(campaignId);
    expect(params).toContain('inbound');
  });
});

describe('projectScheduledSends', () => {
  // Every-day schedule so day assertions don't depend on which weekday the test runs.
  const schedule = { hoursStart: 8, hoursEnd: 20, days: [0, 1, 2, 3, 4, 5, 6] };
  const configById = new Map([['acct', { caps: { connect: 20, message: 20 }, schedule }]]);
  const now = new Date(2026, 6, 14, 12, 0, 0); // local noon, a fixed day
  const backlog = (n: number) =>
    Array.from({ length: n }, () => ({
      accountId: 'acct',
      type: 'connect',
      state: 'in_progress',
      nextStepAt: null,
    }));

  it("fills today's remaining budget, then ladders onto following days at hoursStart", () => {
    const usedToday = new Map([['acct:connect', 18]]); // 2 of 20 left today
    const out = projectScheduledSends(backlog(24), { now, configById, usedToday });
    expect(out[0]).toBeNull(); // today's budget
    expect(out[1]).toBeNull();
    const tomorrow8 = new Date(2026, 6, 15, 8, 0, 0);
    expect(out[2]?.getTime()).toBe(tomorrow8.getTime()); // first laddered slot
    expect(out[21]?.getTime()).toBe(tomorrow8.getTime()); // 20th slot still tomorrow
    const dayAfter8 = new Date(2026, 6, 16, 8, 0, 0);
    expect(out[22]?.getTime()).toBe(dayAfter8.getTime()); // 21st rolls to the next day
  });

  it('keeps a real future next_step_at unchanged and does not spend today on it', () => {
    const future = new Date(2026, 6, 15, 8, 0, 0); // a known future send (tomorrow)
    const cursors = [
      { accountId: 'acct', type: 'connect', state: 'in_progress', nextStepAt: future },
      ...backlog(20),
    ];
    const out = projectScheduledSends(cursors, { now, configById, usedToday: new Map() });
    expect(out[0]?.getTime()).toBe(future.getTime()); // passed through
    // 20 backlog with a full today budget all land today (null), not pushed by the fixed one.
    expect(out.slice(1).every((x) => x === null)).toBe(true);
  });

  it('leaves awaiting_approval cursors on their own next_step_at (never laddered)', () => {
    const at = new Date(2026, 6, 14, 15, 0, 0);
    const out = projectScheduledSends(
      [{ accountId: 'acct', type: 'message', state: 'awaiting_approval', nextStepAt: at }],
      { now, configById, usedToday: new Map() },
    );
    expect(out[0]?.getTime()).toBe(at.getTime());
  });
});

describe('buildCampaignPerformanceActionsQuery', () => {
  it('filters to successful actions and groups by campaign + type', () => {
    const { sql, params } = buildCampaignPerformanceActionsQuery().toSQL();
    expect(sql).toContain('"actions"');
    // result='success' is a bound param, not inlined.
    expect(params).toContain('success');
    expect(sql).toContain('group by');
    expect(sql).toContain('"campaign_id"');
    expect(sql).toContain('"type"');
  });
});

describe('readLeadContext', () => {
  it('pulls profileUrl out of external_context for the pending feed', () => {
    const ctx = readLeadContext({ name: 'Benoit', profileUrl: 'https://linkedin.com/in/benoit' });
    expect(ctx.profileUrl).toBe('https://linkedin.com/in/benoit');
  });

  it('returns null profileUrl when absent', () => {
    expect(readLeadContext({ name: 'Benoit' }).profileUrl).toBeNull();
  });
});
