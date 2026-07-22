// The volume query is asserted at the SQL level: postgres.js does not open a
// connection until a query actually runs, and drizzle's .toSQL() only builds
// the statement, so no live DB is needed here.
import { DEFAULT_CONFIG, nextDay, scheduleDefer } from '@loa/safety';
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
let buildRemovedByStageQuery: typeof import('./queries.js').buildRemovedByStageQuery;
let deriveApprovedQueued: typeof import('./queries.js').deriveApprovedQueued;
let readLeadContext: typeof import('./queries.js').readLeadContext;
let groupInboxRows: typeof import('./queries.js').groupInboxRows;
let deriveReplyDetectorHealth: typeof import('./queries.js').deriveReplyDetectorHealth;
let buildReplyDetectorBootEventsQuery: typeof import('./queries.js').buildReplyDetectorBootEventsQuery;
let buildReplyDetectorScanEventsQuery: typeof import('./queries.js').buildReplyDetectorScanEventsQuery;
let projectScheduledSends: typeof import('./queries.js').projectScheduledSends;
let accountGateConfig: typeof import('./queries.js').accountGateConfig;
let deriveMessageTiming: typeof import('./queries.js').deriveMessageTiming;
let derivePausedAccountIds: typeof import('./queries.js').derivePausedAccountIds;
let buildPauseEventsQuery: typeof import('./queries.js').buildPauseEventsQuery;
let buildApprovedMessageCountsQuery: typeof import('./queries.js').buildApprovedMessageCountsQuery;
let toAccountRow: typeof import('./queries.js').toAccountRow;
let buildWeeklyInviteCountsQuery: typeof import('./queries.js').buildWeeklyInviteCountsQuery;
let buildOutstandingInviteCountsQuery: typeof import('./queries.js').buildOutstandingInviteCountsQuery;
let deriveDispatchHealth: typeof import('./queries.js').deriveDispatchHealth;
let buildDispatchBootEventsQuery: typeof import('./queries.js').buildDispatchBootEventsQuery;
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
    buildRemovedByStageQuery,
    deriveApprovedQueued,
    readLeadContext,
    groupInboxRows,
    deriveReplyDetectorHealth,
    buildReplyDetectorBootEventsQuery,
    buildReplyDetectorScanEventsQuery,
    projectScheduledSends,
    deriveMessageTiming,
    derivePausedAccountIds,
    buildPauseEventsQuery,
    buildApprovedMessageCountsQuery,
    toAccountRow,
    buildWeeklyInviteCountsQuery,
    buildOutstandingInviteCountsQuery,
    deriveDispatchHealth,
    buildDispatchBootEventsQuery,
    accountGateConfig,
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
  // Grouping is independent of the gate, so these tests hand it empty inputs and
  // let deriveMessageTiming's own suite cover the branches.
  const noTiming = {
    now: at('2026-07-14T12:00:00.000Z'),
    configById: new Map(),
    stateById: new Map(),
    pausedAccountIds: new Set<string>(),
    messagesUsedToday: new Map(),
  };

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
        updatedAt: at('2026-07-14T10:00:00.000Z'),
        sentAt: null,
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
        updatedAt: at('2026-07-14T11:00:00.000Z'),
        sentAt: null,
      },
    ];
    const inbox = groupInboxRows(rows, noTiming);
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

  it('omits rejected drafts from the operator inbox entirely', () => {
    // A rejected draft is as terminal as a cancelled one: the operator declined it
    // and it never reached LinkedIn, so it must not become a transcript bubble nor
    // the thread's latest preview.
    const inbox = groupInboxRows(
      [
        {
          messageId: 'sent',
          accountId: 'acct-1',
          targetId: 'target-1',
          externalContext: {},
          campaignGoal: null,
          direction: 'outbound' as const,
          body: 'Hi there',
          status: 'sent',
          intent: null,
          pendingReq: null,
          createdAt: at('2026-07-14T10:00:00.000Z'),
          updatedAt: at('2026-07-14T10:00:00.000Z'),
          sentAt: null,
        },
        {
          messageId: 'rejected',
          accountId: 'acct-1',
          targetId: 'target-1',
          externalContext: {},
          campaignGoal: null,
          direction: 'outbound' as const,
          body: 'Operator declined this',
          status: 'rejected',
          intent: null,
          pendingReq: { type: 'message' },
          createdAt: at('2026-07-14T11:00:00.000Z'),
          updatedAt: at('2026-07-14T11:00:00.000Z'),
          sentAt: null,
        },
      ],
      noTiming,
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.messages.map((m) => m.id)).toEqual(['sent']);
    expect(inbox[0]?.latestPreview).toBe('Hi there');
    expect(inbox[0]?.needsApproval).toBe(false);
  });

  it('omits cancelled drafts from the operator inbox entirely', () => {
    const inbox = groupInboxRows(
      [
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
          updatedAt: at('2026-07-14T10:00:00.000Z'),
          sentAt: null,
        },
      ],
      noTiming,
    );
    expect(inbox).toEqual([]);
  });

  it('carries a pending follow-up eligibility time into the inbox', () => {
    const inbox = groupInboxRows(
      [
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
          updatedAt: at('2026-07-14T10:00:00.000Z'),
          sentAt: null,
        },
      ],
      noTiming,
    );
    expect(inbox[0]?.messages[0]?.eligibleAt).toBe('2026-07-15T10:00:00.000Z');
    // timing.readyAt is the same instant, by construction: the two must never
    // disagree about when a draft becomes eligible.
    expect(inbox[0]?.messages[0]?.timing).toEqual({
      kind: 'awaiting_approval',
      readyAt: '2026-07-15T10:00:00.000Z',
    });
  });
});

describe('deriveMessageTiming', () => {
  const at = (value: string) => new Date(value);
  // A Tuesday, 10:00 local: inside the default 8-20 window on an active day.
  const now = at('2026-07-14T10:00:00.000Z');
  const acct = 'acct-1';

  // Local-time schedules make these assertions TZ-dependent; pin the window to
  // one that is open at every hour so only the branch under test can move.
  const alwaysOpen = { hoursStart: 0, hoursEnd: 0, days: [0, 1, 2, 3, 4, 5, 6] };
  const alwaysShut = { hoursStart: 8, hoursEnd: 20, days: [] as number[] };

  const inputs = (
    over: {
      caps?: Record<string, number>;
      schedule?: { hoursStart: number; hoursEnd: number; days: number[] };
      used?: number;
      state?: string;
      paused?: boolean;
      enabled?: Partial<Record<'message', boolean>>;
    } = {},
  ) => ({
    now,
    configById: new Map([
      [
        acct,
        accountGateConfig({
          caps: over.caps ?? { message: 20 },
          schedule: over.schedule ?? alwaysOpen,
          enabled: over.enabled,
        }),
      ],
    ]),
    stateById: new Map([[acct, over.state ?? 'Active']]),
    pausedAccountIds: new Set(over.paused ? [acct] : []),
    messagesUsedToday: new Map([[acct, over.used ?? 0]]),
  });

  const row = (over: Partial<Parameters<typeof deriveMessageTiming>[0]> = {}) => ({
    direction: 'outbound' as const,
    status: 'approved',
    accountId: acct,
    createdAt: at('2026-07-14T08:00:00.000Z'),
    updatedAt: at('2026-07-14T09:00:00.000Z'),
    sentAt: null,
    eligibleAt: null,
    ...over,
  });

  it('reads an inbound row as received at LinkedIn source time', () => {
    expect(
      deriveMessageTiming(
        row({ direction: 'inbound', status: 'sent', createdAt: at('2026-07-14T07:30:00.000Z') }),
        inputs(),
      ),
    ).toEqual({ kind: 'received', at: '2026-07-14T07:30:00.000Z' });
  });

  it('reads a sent row as sent at its real send time, not its draft time', () => {
    expect(
      deriveMessageTiming(
        row({ status: 'sent', sentAt: at('2026-07-14T09:45:00.000Z') }),
        inputs(),
      ),
    ).toEqual({ kind: 'sent', at: '2026-07-14T09:45:00.000Z' });
  });

  it('falls back to updatedAt for a legacy sent row predating sent_at', () => {
    expect(deriveMessageTiming(row({ status: 'sent', sentAt: null }), inputs())).toEqual({
      kind: 'sent',
      at: '2026-07-14T09:00:00.000Z',
    });
  });

  it('reads an approved row inside an open window with cap to spare as queued_soon', () => {
    const timing = deriveMessageTiming(row(), inputs({ used: 5, caps: { message: 20 } }));
    expect(timing).toEqual({ kind: 'queued_soon' });
    // The anti-burst pacer re-rolls its gap every tick, so there is no instant to
    // promise. Asserted structurally: queued_soon must never grow a timestamp.
    expect(Object.keys(timing)).toEqual(['kind']);
  });

  it('reads an approved row outside the window as queued_window at the next open instant', () => {
    const timing = deriveMessageTiming(row(), inputs({ schedule: alwaysShut }));
    expect(timing.kind).toBe('queued_window');
    // Matches the gate: scheduleDefer parks a no-active-day schedule a week out.
    expect(timing).toEqual({
      kind: 'queued_window',
      at: scheduleDefer(now, alwaysShut)?.toISOString(),
    });
  });

  it('reads an approved row at its daily message cap as queued_capped at the day boundary', () => {
    expect(deriveMessageTiming(row(), inputs({ used: 20, caps: { message: 20 } }))).toEqual({
      kind: 'queued_capped',
      at: nextDay(now).toISOString(),
    });
  });

  it('reads an approved row on a paused account as blocked, not as sending soon', () => {
    // The live shape of the bug: window open, cap to spare, so every check the
    // old branch made passed and it promised a send. The gate denies on pause
    // before reaching either, dispatch drops the send, and the row sits at
    // 'approved' indefinitely.
    const timing = deriveMessageTiming(row(), inputs({ paused: true, used: 0 }));
    expect(timing).toEqual({ kind: 'queued_blocked', reason: 'paused' });
  });

  it('reads an approved row on a Restricted account as blocked', () => {
    expect(deriveMessageTiming(row(), inputs({ state: 'Restricted' }))).toEqual({
      kind: 'queued_blocked',
      reason: 'restricted',
    });
  });

  it('reads an approved row on a Cooldown account as blocked', () => {
    expect(deriveMessageTiming(row(), inputs({ state: 'Cooldown' }))).toEqual({
      kind: 'queued_blocked',
      reason: 'cooldown',
    });
  });

  it('reads an approved row with messages disabled as blocked', () => {
    expect(deriveMessageTiming(row(), inputs({ enabled: { message: false } }))).toEqual({
      kind: 'queued_blocked',
      reason: 'disabled',
    });
  });

  it('names no instant for a blocked row: nothing here clears on a clock', () => {
    const timing = deriveMessageTiming(row(), inputs({ paused: true }));
    expect(Object.keys(timing).sort()).toEqual(['kind', 'reason']);
  });

  it('leaves an Active, unpaused account on the cap and window path', () => {
    expect(deriveMessageTiming(row(), inputs({ state: 'Active' }))).toEqual({
      kind: 'queued_soon',
    });
    // A state the gate does not deny must not be swept in by the blocked branch.
    expect(deriveMessageTiming(row(), inputs({ state: 'Throttled' }))).toEqual({
      kind: 'queued_soon',
    });
  });

  it('checks pause before both the cap and the window, matching SafetyGate.canAct order', () => {
    // Paused AND capped AND shut: pause is the gate's first check and a hard
    // deny, so neither of the other two answers may surface.
    expect(
      deriveMessageTiming(
        row(),
        inputs({ paused: true, used: 20, caps: { message: 20 }, schedule: alwaysShut }),
      ),
    ).toEqual({ kind: 'queued_blocked', reason: 'paused' });
  });

  it('checks pause before account state, matching SafetyGate.canAct order', () => {
    expect(deriveMessageTiming(row(), inputs({ paused: true, state: 'Restricted' }))).toEqual({
      kind: 'queued_blocked',
      reason: 'paused',
    });
  });

  it('checks the cap before the window, matching SafetyGate.canAct order', () => {
    // Capped AND outside the window: the gate defers on the cap first, so the
    // honest answer is tomorrow, not "when the window reopens".
    expect(
      deriveMessageTiming(row(), inputs({ used: 20, caps: { message: 20 }, schedule: alwaysShut })),
    ).toEqual({ kind: 'queued_capped', at: nextDay(now).toISOString() });
  });

  it('reads a draft that is eligible now as awaiting approval with no ready time', () => {
    expect(deriveMessageTiming(row({ status: 'draft', eligibleAt: null }), inputs())).toEqual({
      kind: 'awaiting_approval',
      readyAt: null,
    });
  });

  it('reads a future-dated draft as awaiting approval with its ready time', () => {
    expect(
      deriveMessageTiming(
        row({ status: 'draft', eligibleAt: '2026-07-15T10:00:00.000Z' }),
        inputs(),
      ),
    ).toEqual({ kind: 'awaiting_approval', readyAt: '2026-07-15T10:00:00.000Z' });
  });

  it('falls back to the gate defaults for an account with no config row', () => {
    // A missing config must not read as an unlimited cap.
    expect(
      deriveMessageTiming(row(), {
        now,
        configById: new Map(),
        stateById: new Map(),
        pausedAccountIds: new Set(),
        messagesUsedToday: new Map(),
      }),
    ).toMatchObject({ kind: expect.stringMatching(/^queued_/) });
  });
});

describe('deriveDispatchHealth', () => {
  it('reports a running tick and its configured interval', () => {
    expect(
      deriveDispatchHealth([
        {
          kind: 'dispatch_tick_started',
          ts: new Date('2026-07-14T09:00:00.000Z'),
          payload: { intervalMs: 60_000 },
        },
      ]),
    ).toEqual({
      status: 'running',
      intervalMs: 60_000,
      lastStartedAt: '2026-07-14T09:00:00.000Z',
    });
  });

  it('reports never_run when the runtime has never recorded a boot', () => {
    expect(deriveDispatchHealth([])).toEqual({
      status: 'never_run',
      intervalMs: null,
      lastStartedAt: null,
    });
  });

  it('lets a newer idle boot outrank an older start', () => {
    // The interval was removed and the process restarted: approved messages are
    // now going nowhere, and the previous boot's start must not mask that.
    expect(
      deriveDispatchHealth([
        {
          kind: 'dispatch_tick_started',
          ts: new Date('2026-07-13T09:00:00.000Z'),
          payload: { intervalMs: 60_000 },
        },
        {
          kind: 'dispatch_tick_idle',
          ts: new Date('2026-07-14T09:00:00.000Z'),
          payload: { reason: 'LOA_DISPATCH_INTERVAL_MS unset' },
        },
      ]),
    ).toEqual({
      status: 'disabled',
      intervalMs: null,
      lastStartedAt: '2026-07-13T09:00:00.000Z',
    });
  });

  it('lets a newer start outrank an older idle boot', () => {
    expect(
      deriveDispatchHealth([
        {
          kind: 'dispatch_tick_idle',
          ts: new Date('2026-07-13T09:00:00.000Z'),
          payload: { reason: 'LOA_DISPATCH_INTERVAL_MS unset' },
        },
        {
          kind: 'dispatch_tick_started',
          ts: new Date('2026-07-14T09:00:00.000Z'),
          payload: { intervalMs: 60_000 },
        },
      ]),
    ).toEqual({ status: 'running', intervalMs: 60_000, lastStartedAt: '2026-07-14T09:00:00.000Z' });
  });
});

describe('buildDispatchBootEventsQuery', () => {
  it('reads the newest row per kind so a boot event can never be evicted', () => {
    // The bug this guards: dispatch's lifecycle events are written once per boot
    // and compete with the whole event stream for recency. A windowed read drops
    // them after enough unrelated events and a running tick reads 'never_run'.
    const { sql, params } = buildDispatchBootEventsQuery().toSQL();
    expect(sql).toContain('distinct on');
    expect(sql).not.toContain('limit');
    expect(params).toContain('dispatch_tick_started');
    expect(params).toContain('dispatch_tick_idle');
  });
});

describe('derivePausedAccountIds', () => {
  const at = (value: string) => new Date(value);
  const A = 'acct-1';
  const B = 'acct-2';
  const paused = (accountId: string, ts: string) => ({
    accountId,
    kind: 'account_paused',
    ts: at(ts),
  });
  const resumed = (accountId: string, ts: string) => ({
    accountId,
    kind: 'account_resumed',
    ts: at(ts),
  });

  // The rule under test is PauseRegistry.rehydrate's, in
  // runtime/src/adapters/safety-state.ts. These cases mirror its branches so the
  // read model cannot drift from the gate the dispatch tick actually consults.
  it('pauses an account whose newest pause is newer than its newest resume', () => {
    expect([
      ...derivePausedAccountIds([
        resumed(A, '2026-07-14T09:00:00.000Z'),
        paused(A, '2026-07-14T19:34:00.000Z'),
      ]),
    ]).toEqual([A]);
  });

  it('does not pause an account whose newest resume is newer than its newest pause', () => {
    expect([
      ...derivePausedAccountIds([
        paused(A, '2026-07-14T09:00:00.000Z'),
        resumed(A, '2026-07-14T10:00:00.000Z'),
      ]),
    ]).toEqual([]);
  });

  it('pauses on an unmatched pause and ignores an unmatched resume', () => {
    const ids = derivePausedAccountIds([
      paused(A, '2026-07-14T09:00:00.000Z'),
      resumed(B, '2026-07-14T09:00:00.000Z'),
    ]);
    expect([...ids]).toEqual([A]);
  });

  it('reads each account independently', () => {
    const ids = derivePausedAccountIds([
      paused(A, '2026-07-14T19:34:00.000Z'),
      paused(B, '2026-07-14T08:00:00.000Z'),
      resumed(B, '2026-07-14T08:30:00.000Z'),
    ]);
    expect([...ids]).toEqual([A]);
  });

  it('takes the newest of several events of one kind, whatever their row order', () => {
    // Guards against reading whichever row happened to arrive first.
    expect([
      ...derivePausedAccountIds([
        resumed(A, '2026-07-14T18:00:00.000Z'),
        paused(A, '2026-07-14T07:00:00.000Z'),
        paused(A, '2026-07-14T19:34:00.000Z'),
      ]),
    ]).toEqual([A]);
  });

  it('ignores unrelated kinds and account-less rows', () => {
    expect([
      ...derivePausedAccountIds([
        { accountId: A, kind: 'dispatch_tick_started', ts: at('2026-07-14T20:00:00.000Z') },
        { accountId: null, kind: 'account_paused', ts: at('2026-07-14T20:00:00.000Z') },
      ]),
    ]).toEqual([]);
  });

  it('is empty with no events at all', () => {
    expect([...derivePausedAccountIds([])]).toEqual([]);
  });
});

describe('buildPauseEventsQuery', () => {
  it('reads the newest row per account and kind so a pause can never be evicted', () => {
    // A pause has no expiry: if a windowed read dropped the account_paused row,
    // a frozen queue would read back as sending in the next few minutes.
    const { sql, params } = buildPauseEventsQuery(['acct-1']).toSQL();
    expect(sql).toContain('distinct on');
    expect(sql).not.toContain('limit');
    expect(params).toContain('account_paused');
    expect(params).toContain('account_resumed');
    expect(params).toContain('acct-1');
  });
});

describe('buildApprovedMessageCountsQuery', () => {
  it('counts approved outbound messages per account', () => {
    const { sql, params } = buildApprovedMessageCountsQuery().toSQL();
    expect(sql).toContain('"messages"');
    expect(sql).toContain('count(*)::int');
    expect(sql).toContain('group by');
    expect(sql).toContain('"account_id"');
    // Both filters are bound params, not inlined. 'approved' is the whole point:
    // a draft is not queued behind the pause, it is waiting on a human.
    expect(params).toContain('approved');
    expect(params).toContain('outbound');
  });

  it('does not window or limit the count', () => {
    // The pause holds the whole backlog however old; a limit would understate
    // what resuming is about to release.
    const { sql } = buildApprovedMessageCountsQuery().toSQL();
    expect(sql).not.toContain('limit');
  });
});

describe('toAccountRow', () => {
  const row = { id: 'acct-1', handle: 'josh', state: 'Active', limits: null };
  const NO_INVITES = { weeklyByAccount: new Map(), outstandingByAccount: new Map() };

  it('marks an account in the paused set as paused and carries its held count', () => {
    expect(
      toAccountRow(row, new Set(['acct-1']), new Map([['acct-1', 11]]), NO_INVITES),
    ).toMatchObject({
      id: 'acct-1',
      handle: 'josh',
      paused: true,
      queuedMessageCount: 11,
    });
  });

  it('reads an account outside the paused set as sending', () => {
    expect(toAccountRow(row, new Set(['other']), new Map(), NO_INVITES)).toMatchObject({
      paused: false,
      queuedMessageCount: 0,
    });
  });

  it('does not read another account queue as this one', () => {
    // A grouped count covers every account: keying it wrong would quote someone
    // else's backlog in this account's resume confirm.
    expect(
      toAccountRow(
        row,
        new Set(['acct-1']),
        new Map([
          ['acct-2', 7],
          ['acct-1', 11],
        ]),
        NO_INVITES,
      ).queuedMessageCount,
    ).toBe(11);
  });

  it('backfills legacy null limits so the caps UI always has values', () => {
    expect(toAccountRow(row, new Set(), new Map(), NO_INVITES).limits.caps).toBeDefined();
  });

  it('carries both invite limiters with the ceilings the gate checks them against', () => {
    // The daily cap is not the only limiter on connects. A card that reported
    // only the cap showed headroom the gate refused, which is indistinguishable
    // from sends stopping for no reason.
    expect(
      toAccountRow(row, new Set(), new Map(), {
        weeklyByAccount: new Map([['acct-1', 98]]),
        outstandingByAccount: new Map([['acct-1', 60]]),
      }),
    ).toMatchObject({
      weeklyInvitesUsed: 98,
      weeklyInviteCeiling: DEFAULT_CONFIG.weeklyInviteCeiling,
      outstandingInvites: 60,
      outstandingInviteCeiling: DEFAULT_CONFIG.outstandingInviteCeiling,
    });
  });

  it('reads an account with no invite rows as zero used, not as missing', () => {
    // A rendered 0/100 is a claim of full headroom; undefined would render as
    // blank and read as "unknown".
    expect(toAccountRow(row, new Set(), new Map(), NO_INVITES)).toMatchObject({
      weeklyInvitesUsed: 0,
      outstandingInvites: 0,
    });
  });

  it('does not read another account invite counts as this one', () => {
    expect(
      toAccountRow(row, new Set(), new Map(), {
        weeklyByAccount: new Map([
          ['acct-2', 99],
          ['acct-1', 4],
        ]),
        outstandingByAccount: new Map([
          ['acct-2', 480],
          ['acct-1', 7],
        ]),
      }),
    ).toMatchObject({ weeklyInvitesUsed: 4, outstandingInvites: 7 });
  });

  it('reports the gate ceilings even for an account with its own caps set', () => {
    // The ceilings live in the gate's SafetyConfig, not in the account's limits
    // blob: editing a daily cap must not appear to move either of them.
    const withCaps = { ...row, limits: { caps: { connect: 5, message: 5 } } };
    const built = toAccountRow(withCaps, new Set(), new Map(), NO_INVITES);
    expect(built.weeklyInviteCeiling).toBe(DEFAULT_CONFIG.weeklyInviteCeiling);
    expect(built.outstandingInviteCeiling).toBe(DEFAULT_CONFIG.outstandingInviteCeiling);
  });
});

describe('buildWeeklyInviteCountsQuery', () => {
  it('counts only successful connects, per account, inside a 7-day window', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const { sql, params } = buildWeeklyInviteCountsQuery(['acct-1', 'acct-2'], now).toSQL();
    expect(sql).toContain('"actions"');
    expect(sql).toContain('count(*)');
    expect(sql).toContain('group by');
    // Both filters bound, not inlined. 'connect' is what makes this the invite
    // ceiling rather than a count of all outbound activity; 'success' matches the
    // gate, which does not burn ceiling on an invite LinkedIn never saw.
    expect(params).toContain('connect');
    expect(params).toContain('success');
    // The cutoff is exactly 7 days back from now, matching the gate's rolling
    // window rather than a calendar week.
    expect(params).toContain('2026-07-08T12:00:00.000Z');
    expect(params).toContain('acct-1');
    expect(params).toContain('acct-2');
  });

  it('does not limit the count', () => {
    // A limit would understate the ceiling and offer invites the gate refuses.
    const { sql } = buildWeeklyInviteCountsQuery(['acct-1']).toSQL();
    expect(sql).not.toContain('limit');
  });
});

describe('buildOutstandingInviteCountsQuery', () => {
  it('counts awaiting_connection cursors per account', () => {
    const { sql, params } = buildOutstandingInviteCountsQuery(['acct-1']).toSQL();
    expect(sql).toContain('"target_progress"');
    expect(sql).toContain('count(*)');
    expect(sql).toContain('group by');
    // The parked-invite state is the whole definition of "outstanding": the same
    // source StoreBackedOutstandingInvites rehydrates from.
    expect(params).toContain('awaiting_connection');
    expect(params).toContain('acct-1');
  });

  it('is not windowed by time', () => {
    // An invite nobody accepts is outstanding forever, which is exactly the pile
    // the ceiling is about. Any window would hide the oldest ones.
    const { sql } = buildOutstandingInviteCountsQuery(['acct-1']).toSQL();
    expect(sql).not.toContain('limit');
    expect(sql).not.toContain('"created_at"');
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

  it('reports disabled when a restart left the detector idle after a healthy run', () => {
    // The detector ran for a week, then came back up with the poll interval unset.
    // The last scan is minutes old and well inside staleAfterMs, so reading health
    // off it would show a green "checked 5 minutes ago" for a detector that is not
    // running at all.
    const health = deriveReplyDetectorHealth(
      [
        {
          kind: 'reply_detector_idle',
          ts: new Date('2026-07-14T19:50:00.000Z'),
          payload: { reason: 'poll_interval_unset' },
        },
        {
          kind: 'reply_scan_succeeded',
          ts: new Date('2026-07-14T19:45:00.000Z'),
          payload: { accounts: 1, listedThreads: 20 },
        },
        {
          kind: 'reply_detector_started',
          ts: new Date('2026-07-07T19:00:00.000Z'),
          payload: { intervalMs: 1_800_000 },
        },
      ],
      now,
    );
    expect(health.status).toBe('disabled');
    // The last real scan stays visible; only the health verdict changes.
    expect(health.lastSuccessfulScanAt).toBe('2026-07-14T19:45:00.000Z');
    expect(health.coverage).toMatchObject({ accounts: 1, listedThreads: 20 });
  });

  it('stays healthy when a restart re-enabled the detector after an idle boot', () => {
    const health = deriveReplyDetectorHealth(
      [
        {
          kind: 'reply_scan_succeeded',
          ts: new Date('2026-07-14T19:45:00.000Z'),
          payload: {},
        },
        {
          kind: 'reply_detector_started',
          ts: new Date('2026-07-14T19:40:00.000Z'),
          payload: { intervalMs: 1_800_000 },
        },
        {
          kind: 'reply_detector_idle',
          ts: new Date('2026-07-14T19:00:00.000Z'),
          payload: { reason: 'poll_interval_unset' },
        },
      ],
      now,
    );
    expect(health.status).toBe('healthy');
  });

  it('honors a long configured interval even once started ages out of the scan window', () => {
    // reply_detector_started is written once per boot; reply_scan_succeeded lands
    // every tick. Read from a shared window it is evicted, intervalMs falls back to
    // 0, and staleAfterMs collapses to the 1h default — calling a 2h-interval
    // detector stale on every scan after the 32nd.
    const rows = [
      {
        kind: 'reply_scan_succeeded',
        ts: new Date('2026-07-14T18:30:00.000Z'), // 90m old: fine for a 2h interval
        payload: {},
      },
      {
        kind: 'reply_detector_started',
        ts: new Date('2026-06-01T00:00:00.000Z'), // an old boot, far outside a 32-tick window
        payload: { intervalMs: 7_200_000 },
      },
    ];
    expect(deriveReplyDetectorHealth(rows, now).status).toBe('healthy');
    // Guard the derivation itself: without the started row it wrongly reads stale.
    expect(deriveReplyDetectorHealth([rows[0]!], now).status).toBe('stale');
  });
});

describe('buildReplyDetectorBootEventsQuery', () => {
  it('reads the newest boot event per kind, unwindowed by tick volume', () => {
    const { sql, params } = buildReplyDetectorBootEventsQuery().toSQL();
    expect(sql).toContain('"events"');
    // distinct-on kind + ts desc is what keeps intervalMs from being evicted, so
    // there is no LIMIT to age reply_detector_started out.
    expect(sql.toLowerCase()).toContain('distinct on');
    expect(params).toContain('reply_detector_started');
    expect(params).toContain('reply_detector_idle');
    expect(sql.toLowerCase()).not.toContain('limit');
  });
});

describe('buildReplyDetectorScanEventsQuery', () => {
  it('windows only the per-tick scan trail', () => {
    const { sql, params } = buildReplyDetectorScanEventsQuery().toSQL();
    expect(params).toContain('reply_scan_succeeded');
    expect(params).toContain('reply_scan_failed');
    // Boot events are read separately and must not share this window.
    expect(params).not.toContain('reply_detector_started');
    expect(sql.toLowerCase()).toContain('limit');
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

  it('surfaces the failure reason from the event and the skip reason from the row', () => {
    const { sql } = buildActivityActionsQuery({ limit: 50 }).toSQL();
    // A scalar subquery pulls detail from the action_failed event keyed by actionId,
    // and coalesces to the action row's own detail (where skip reasons live).
    expect(sql).toContain('"events"');
    expect(sql).toContain("->>'detail'");
    expect(sql).toContain("->>'actionId'");
    expect(sql).toContain('action_failed%');
    expect(sql).toContain('coalesce(');
    expect(sql).toContain('"detail"');
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
  // The invite ceilings are not what these cases exercise; take the gate's own
  // values rather than restating numbers this file would have to chase.
  const ceilings = {
    weeklyInviteCeiling: DEFAULT_CONFIG.weeklyInviteCeiling,
    outstandingInviteCeiling: DEFAULT_CONFIG.outstandingInviteCeiling,
  };
  const configById = new Map([
    [
      'acct',
      { caps: { connect: 20, message: 20 }, enabled: {}, schedule, schedules: {}, ...ceilings },
    ],
  ]);
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

  it('uses the action-specific schedule for the cursor type', () => {
    const messageSchedule = { hoursStart: 10, hoursEnd: 16, days: [0, 1, 2, 3, 4, 5, 6] };
    const byAction = new Map([
      [
        'acct',
        {
          caps: { connect: 0, message: 0 },
          enabled: {},
          schedule,
          schedules: { message: messageSchedule },
          ...ceilings,
        },
      ],
    ]);
    const [out] = projectScheduledSends(
      [{ accountId: 'acct', type: 'message', state: 'in_progress', nextStepAt: null }],
      { now, configById: byAction, usedToday: new Map() },
    );
    expect(out?.getHours()).toBe(10);
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
    // No campaign filter when the id is omitted.
    expect(sql).not.toContain('"campaign_id" =');
  });

  it('counts distinct messaged targets alongside raw action volume', () => {
    // `replies` counts distinct PEOPLE, so the reply-rate denominator has to as
    // well. count(*) alone mixes populations: a 3-step sequence to 10 targets is 30
    // actions, and an invite-note reply with no message step has no action at all.
    const { sql } = buildCampaignPerformanceActionsQuery().toSQL();
    expect(sql).toContain('count(distinct "target_id")');
    // Raw volume is kept as its own projection, not replaced.
    expect(sql).toContain('count(*)');
  });

  it('scopes to one campaign when given', () => {
    const campaignId = '63f1cd27-4444-4444-4444-444444444444';
    const { sql, params } = buildCampaignPerformanceActionsQuery(campaignId).toSQL();
    expect(sql).toContain('"campaign_id" =');
    expect(params).toContain(campaignId);
    expect(params).toContain('success');
  });
});

describe('buildRemovedByStageQuery', () => {
  it('buckets skipped leads by furthest stage over the persisted signals', () => {
    const { sql, params } = buildRemovedByStageQuery().toSQL();
    // Only removed (skipped) leads, grouped per campaign.
    expect(sql).toContain('"target_progress"');
    expect(params).toContain('skipped');
    expect(sql).toContain('group by');
    expect(sql).toContain('"campaign_id"');
    // Each stage is a filtered count over a correlated existence check on the
    // same tables the funnel numerators read. The stage literals are inlined in
    // the SQL text; only the state filter is a bound param.
    expect(sql).toContain('filter (where');
    expect(sql).toContain('invite_accepted');
    expect(sql).toContain('connect');
    expect(sql).toContain('inbound');
    // No campaign filter when the id is omitted.
    expect(sql).not.toContain('"campaign_id" =');
  });

  it('scopes to one campaign when given', () => {
    const campaignId = '6970997e-5555-4555-8555-555555555555';
    const { sql, params } = buildRemovedByStageQuery(campaignId).toSQL();
    expect(sql).toContain('"campaign_id" =');
    expect(params).toContain(campaignId);
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
