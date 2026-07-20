// No component-test setup exists in this workspace (no jsdom/testing-library,
// and web/vitest.config.ts only scans server/), so the regressions are pinned on
// the pure predicates the view delegates to. Runs under the root vitest config.
import { describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxThread, MessageTiming } from './api';
import {
  composerLocked,
  filterThreads,
  isOutboundSend,
  lastOutboundSentAt,
  latestMessage,
  runComposerAction,
  threadTimingLabel,
  timingLabel,
} from './InboxView';

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: 'm1',
    direction: 'outbound',
    body: 'hello',
    status: 'sent',
    intent: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    pendingMessageId: null,
    eligibleAt: null,
    timing: { kind: 'sent', at: '2026-07-14T00:00:00.000Z' },
    ...overrides,
  };
}

// Local-clock helpers: the copy is rendered with the host's locale and zone, so
// the expectations are built from local date parts rather than fixed ISO text.
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function atLocal(dayOffset: number, hour: number): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    0,
    0,
    0,
  ).toISOString();
}

function thread(messages: InboxMessage[]): InboxThread {
  return {
    id: 't1',
    accountId: 'a1',
    targetId: 'target-1',
    name: 'Ada',
    company: null,
    headline: null,
    profileUrl: null,
    campaignGoal: null,
    latestAt: '2026-07-14T00:00:00.000Z',
    latestPreview: 'hello',
    hasInbound: messages.some((m) => m.direction === 'inbound'),
    needsApproval: messages.some((m) => m.pendingMessageId !== null),
    messages,
  };
}

describe('filterThreads sent', () => {
  it('excludes a thread whose only sent-status row is an inbound reply', () => {
    const inboundOnly = thread([message({ direction: 'inbound', status: 'sent' })]);
    expect(filterThreads([inboundOnly], 'sent')).toEqual([]);
  });

  it('includes a thread with an outbound send', () => {
    const sent = thread([
      message({ direction: 'inbound', status: 'sent' }),
      message({ id: 'm2', direction: 'outbound', status: 'sent' }),
    ]);
    expect(filterThreads([sent], 'sent')).toEqual([sent]);
  });

  it('excludes outbound rows that never dispatched', () => {
    const queued = thread([message({ direction: 'outbound', status: 'draft' })]);
    expect(filterThreads([queued], 'sent')).toEqual([]);
  });

  it('leaves the other filters alone', () => {
    const inboundOnly = thread([message({ direction: 'inbound', status: 'sent' })]);
    expect(filterThreads([inboundOnly], 'replies')).toEqual([inboundOnly]);
    expect(filterThreads([inboundOnly], 'approval')).toEqual([]);
    expect(filterThreads([inboundOnly], 'all')).toEqual([inboundOnly]);
  });

  it('is the same predicate the transcript uses for the last outbound send', () => {
    expect(isOutboundSend(message({ direction: 'inbound', status: 'sent' }))).toBe(false);
    expect(isOutboundSend(message({ direction: 'outbound', status: 'sent' }))).toBe(true);
    expect(isOutboundSend(message({ direction: 'outbound', status: 'failed' }))).toBe(false);
  });
});

describe('lastOutboundSentAt', () => {
  it('reads the send instant, not the drafted-at createdAt', () => {
    // A follow-up drafted 4 days ago but not sent until 2 days ago: the footer
    // must name when it left, matching the "Sent 2d ago" thread row, not when it
    // was first queued.
    const drafted = '2026-07-13T00:00:00.000Z';
    const sent = '2026-07-15T00:00:00.000Z';
    const messages = [
      message({ id: 'm1', createdAt: drafted, timing: { kind: 'sent', at: sent } }),
    ];
    expect(lastOutboundSentAt(messages)).toBe(sent);
  });

  it('returns the most recent send when several went out', () => {
    const messages = [
      message({ id: 'm1', timing: { kind: 'sent', at: '2026-07-10T00:00:00.000Z' } }),
      message({ id: 'm2', timing: { kind: 'sent', at: '2026-07-15T00:00:00.000Z' } }),
    ];
    expect(lastOutboundSentAt(messages)).toBe('2026-07-15T00:00:00.000Z');
  });

  it('ignores drafts and inbound replies, and is null with no sends', () => {
    expect(
      lastOutboundSentAt([
        message({ direction: 'inbound', status: 'sent' }),
        message({ id: 'm2', direction: 'outbound', status: 'draft' }),
      ]),
    ).toBeNull();
  });
});

describe('timingLabel', () => {
  it('answers "how long ago" for a message that actually went out', () => {
    const at = hoursAgo(18);
    expect(timingLabel({ kind: 'sent', at })).toEqual({ text: 'Sent 18h ago', at });
  });

  it('answers "how long ago" for an inbound reply', () => {
    const at = hoursAgo(18);
    expect(timingLabel({ kind: 'received', at })).toEqual({ text: 'Received 18h ago', at });
  });

  it('names the window a queued message is waiting on', () => {
    const at = atLocal(0, 8);
    const label = timingLabel({ kind: 'queued_window', at });
    expect(label.at).toBe(at);
    expect(label.text).toMatch(/^Queued · sends after \d{1,2}:00/);
  });

  it('says "tomorrow" for a capped message that really does send tomorrow', () => {
    expect(timingLabel({ kind: 'queued_capped', at: atLocal(1, 9) }).text).toBe(
      'Queued · sends tomorrow (daily cap reached)',
    );
  });

  it('names the day instead of lying about "tomorrow" when it is further out', () => {
    const at = atLocal(3, 9);
    const label = timingLabel({ kind: 'queued_capped', at });
    expect(label.at).toBe(at);
    expect(label.text).not.toContain('tomorrow');
    expect(label.text).toMatch(/^Queued · sends \w{3} \d{1,2}:00.* \(daily cap reached\)$/);
  });

  it('says a draft is ready now when nothing gates it', () => {
    expect(timingLabel({ kind: 'awaiting_approval', readyAt: null })).toEqual({
      text: 'Ready to send · needs approval',
      at: null,
    });
  });

  it('names the deadline when a draft is gated on a future eligibility', () => {
    const readyAt = atLocal(1, 9);
    const label = timingLabel({ kind: 'awaiting_approval', readyAt });
    expect(label.at).toBe(readyAt);
    expect(label.text).toMatch(/^Needs approval before \w{3} \d{1,2}:00/);
  });

  it('never renders a countdown for queued_soon', () => {
    const label = timingLabel({ kind: 'queued_soon' });
    expect(label).toEqual({ text: 'Queued · sends in the next few minutes', at: null });
    // The real wait is the safety gate's anti-burst pacer (minActionGapMs +
    // rand(0, jitter)), re-rolled every tick. Any digit here would be invented.
    expect(label.text).not.toMatch(/\d/);
  });

  it('says a blocked queue will not move until a human acts', () => {
    expect(timingLabel({ kind: 'queued_blocked', reason: 'paused' })).toEqual({
      text: 'Queued · sending is paused for this account',
      at: null,
    });
    expect(timingLabel({ kind: 'queued_blocked', reason: 'restricted' })).toEqual({
      text: 'Queued · account restricted — nothing will send',
      at: null,
    });
    expect(timingLabel({ kind: 'queued_blocked', reason: 'cooldown' })).toEqual({
      text: 'Queued · account in cooldown — nothing will send',
      at: null,
    });
    expect(timingLabel({ kind: 'queued_blocked', reason: 'disabled' })).toEqual({
      text: 'Queued · messages are turned off for this account',
      at: null,
    });
  });

  it('never suggests a blocked row is about to go out', () => {
    // The gate denies these outright, so any wording implying an imminent or
    // timed send is the same lie 'sends in the next few minutes' told.
    for (const reason of ['paused', 'restricted', 'cooldown', 'disabled'] as const) {
      const label = timingLabel({ kind: 'queued_blocked', reason });
      expect(label.at).toBeNull();
      expect(label.text).not.toMatch(/\d|soon|minutes|shortly/i);
    }
  });

  it('offers no timestamp to wrap in <time> exactly when the copy names no instant', () => {
    const timings: MessageTiming[] = [
      { kind: 'received', at: hoursAgo(1) },
      { kind: 'sent', at: hoursAgo(1) },
      { kind: 'queued_soon' },
      { kind: 'queued_window', at: atLocal(0, 8) },
      { kind: 'queued_capped', at: atLocal(1, 9) },
      { kind: 'queued_blocked', reason: 'paused' },
      { kind: 'queued_blocked', reason: 'restricted' },
      { kind: 'queued_blocked', reason: 'cooldown' },
      { kind: 'queued_blocked', reason: 'disabled' },
      { kind: 'awaiting_approval', readyAt: null },
      { kind: 'awaiting_approval', readyAt: atLocal(1, 9) },
    ];
    expect(timings.map((t) => timingLabel(t).at !== null)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    for (const timing of timings) expect(timingLabel(timing).text).not.toBe('');
  });
});

describe('threadTimingLabel', () => {
  it('reads a queued thread as pending rather than as the age of its draft', () => {
    // The draft was created 18h ago; the row must not imply the thread is stale.
    expect(threadTimingLabel({ kind: 'queued_soon' })).toEqual({ text: 'Queued', at: null });
    expect(threadTimingLabel({ kind: 'queued_capped', at: atLocal(1, 9) }).text).toBe(
      'Queued · tomorrow',
    );
    expect(threadTimingLabel({ kind: 'queued_window', at: atLocal(0, 8) }).text).toMatch(
      /^Queued · \d{1,2}:00/,
    );
  });

  it('keeps the bare relative stamp for messages that already happened', () => {
    const at = hoursAgo(18);
    expect(threadTimingLabel({ kind: 'sent', at })).toEqual({ text: '18h ago', at });
    expect(threadTimingLabel({ kind: 'received', at })).toEqual({ text: '18h ago', at });
  });

  it('distinguishes a draft that is ready now from one that is not', () => {
    expect(threadTimingLabel({ kind: 'awaiting_approval', readyAt: null })).toEqual({
      text: 'Ready now',
      at: null,
    });
    expect(threadTimingLabel({ kind: 'awaiting_approval', readyAt: hoursAgo(-5) }).text).toBe(
      'Ready in 5h',
    );
  });

  it('never renders a countdown for queued_soon', () => {
    expect(threadTimingLabel({ kind: 'queued_soon' }).text).not.toMatch(/\d/);
  });

  it('marks a blocked thread with its reason instead of a bare Queued', () => {
    // Bare 'Queued' would sit this row among the ones that really are moving.
    expect(threadTimingLabel({ kind: 'queued_blocked', reason: 'paused' })).toEqual({
      text: 'Queued · Paused',
      at: null,
    });
    expect(threadTimingLabel({ kind: 'queued_blocked', reason: 'restricted' })).toEqual({
      text: 'Queued · Restricted',
      at: null,
    });
    expect(threadTimingLabel({ kind: 'queued_blocked', reason: 'cooldown' })).toEqual({
      text: 'Queued · Cooldown',
      at: null,
    });
    expect(threadTimingLabel({ kind: 'queued_blocked', reason: 'disabled' })).toEqual({
      text: 'Queued · Messages off',
      at: null,
    });
  });

  it('names no instant for a blocked thread', () => {
    for (const reason of ['paused', 'restricted', 'cooldown', 'disabled'] as const) {
      const label = threadTimingLabel({ kind: 'queued_blocked', reason });
      expect(label.at).toBeNull();
      expect(label.text).not.toMatch(/\d/);
    }
  });
});

describe('latestMessage', () => {
  it('picks the row latestAt/latestPreview came from, breaking ties the way the server does', () => {
    const older = message({ id: 'm1', createdAt: '2026-07-14T00:00:00.000Z' });
    const newer = message({ id: 'm2', createdAt: '2026-07-14T05:00:00.000Z' });
    const tie = message({ id: 'm3', createdAt: '2026-07-14T05:00:00.000Z' });
    expect(latestMessage(thread([older, newer]))?.id).toBe('m2');
    expect(latestMessage(thread([newer, older]))?.id).toBe('m2');
    // The server keeps the last row at the max createdAt (it compares with >=).
    expect(latestMessage(thread([newer, tie]))?.id).toBe('m3');
    expect(latestMessage(thread([]))).toBeNull();
  });
});

describe('runComposerAction', () => {
  it('reports done when both the action and the reload succeed', async () => {
    const outcome = await runComposerAction(
      () => Promise.resolve({ ok: true }),
      () => Promise.resolve([]),
      'Could not approve this draft.',
    );
    expect(outcome).toEqual({ phase: 'done' });
  });

  it('does not report an approval failure when only the reload fails', async () => {
    const act = vi.fn(() => Promise.resolve({ ok: true }));
    const outcome = await runComposerAction(
      act,
      () => Promise.reject(new Error('502 Bad Gateway')),
      'Could not approve this draft.',
    );
    expect(act).toHaveBeenCalledTimes(1);
    expect(outcome.phase).toBe('stale');
    expect(outcome.phase === 'stale' && outcome.notice).not.toContain('Could not approve');
    // The send may already be dispatching: the operator must not be offered a retry.
    expect(composerLocked(outcome.phase)).toBe(true);
  });

  it('locks the actions after success and frees them only after a real failure', () => {
    expect(composerLocked('working')).toBe(true);
    expect(composerLocked('done')).toBe(true);
    expect(composerLocked('stale')).toBe(true);
    expect(composerLocked('error')).toBe(false);
    expect(composerLocked('idle')).toBe(false);
  });

  it('reports an error only when the action itself fails, and does not reload', async () => {
    const reload = vi.fn(() => Promise.resolve([]));
    const outcome = await runComposerAction(
      () => Promise.reject(new Error('pending message already approved')),
      reload,
      'Could not approve this draft.',
    );
    expect(reload).not.toHaveBeenCalled();
    expect(outcome).toEqual({ phase: 'error', notice: 'pending message already approved' });
  });

  it('falls back to the caller notice when the action rejects with a non-Error', async () => {
    const outcome = await runComposerAction(
      () => Promise.reject('nope'),
      () => Promise.resolve([]),
      'Could not reject this draft.',
    );
    expect(outcome).toEqual({ phase: 'error', notice: 'Could not reject this draft.' });
  });
});
