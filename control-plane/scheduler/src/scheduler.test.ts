import { describe, it, expect } from 'vitest';
import type { Account, Action, ActionType, DailyBudget, Decision } from '@loa/shared';

import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from './config.js';
import { seededRng, type SafetyPort } from './ports.js';
import { isWithinWorkingHours, nextWorkingInstant } from './working-hours.js';
import { PacingScheduler } from './scheduler.js';

// Monday 2026-07-06. 12:00 UTC is inside 09:00-18:00; 20:00 is outside.
const MON_NOON = new Date('2026-07-06T12:00:00.000Z');
const MON_EVENING = new Date('2026-07-06T20:00:00.000Z');
const SAT = new Date('2026-07-04T12:00:00.000Z'); // Saturday

function dailyBudget(caps: Partial<Record<ActionType, number>>, used: Partial<Record<ActionType, number>> = {}): DailyBudget {
  const zero = { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 };
  return { date: '2026-07-06', caps: { ...zero, ...caps }, used: { ...zero, ...used } };
}

function account(): Account {
  return {
    id: 'acct-1',
    handle: 'h',
    proxyBinding: { proxyId: 'p', region: 'us', sticky: true },
    state: 'Active',
    health: { acceptanceRate: 0.8, replyRate: 0.4, challengesLast7d: 0, lastCheckedAt: MON_NOON },
    budget: dailyBudget({ connect: 20 }),
    createdAt: MON_NOON,
    updatedAt: MON_NOON,
  };
}

function action(id: string, type: ActionType, over: Partial<Action> = {}): Action {
  return {
    id,
    type,
    scheduledAt: MON_NOON,
    executedAt: null,
    result: 'pending',
    dedupKey: `${type}:${id}`,
    accountId: 'acct-1',
    targetId: `t-${id}`,
    campaignId: 'c',
    createdAt: MON_NOON,
    updatedAt: MON_NOON,
    ...over,
  };
}

// A configurable fake SafetyPort.
function fakeSafety(over: Partial<{ decision: Decision; budget: DailyBudget }> = {}): SafetyPort {
  return {
    canAct: () => over.decision ?? { kind: 'allow' },
    budget: () => over.budget ?? dailyBudget({ connect: 20, message: 20, view_profile: 60 }),
  };
}

describe('working hours', () => {
  it('recognizes inside and outside the window', () => {
    expect(isWithinWorkingHours(MON_NOON, DEFAULT_SCHEDULER_CONFIG.working)).toBe(true);
    expect(isWithinWorkingHours(MON_EVENING, DEFAULT_SCHEDULER_CONFIG.working)).toBe(false);
    expect(isWithinWorkingHours(SAT, DEFAULT_SCHEDULER_CONFIG.working)).toBe(false);
  });

  it('advances to the next working instant from outside the window', () => {
    const next = nextWorkingInstant(MON_EVENING, DEFAULT_SCHEDULER_CONFIG.working);
    expect(isWithinWorkingHours(next, DEFAULT_SCHEDULER_CONFIG.working)).toBe(true);
    // Next working instant after Monday evening is Tuesday 09:00 UTC.
    expect(next.getUTCDate()).toBe(7);
    expect(next.getUTCHours()).toBe(9);
  });

  it('skips the weekend', () => {
    const next = nextWorkingInstant(SAT, DEFAULT_SCHEDULER_CONFIG.working);
    // Saturday -> Monday 09:00.
    expect(next.getUTCDay()).toBe(1);
  });

  it('respects a custom timezone window', () => {
    const cfg: SchedulerConfig['working'] = {
      timezone: 'America/Chicago',
      startHour: 9,
      endHour: 18,
      workingDays: [1, 2, 3, 4, 5],
    };
    // 12:00 UTC = 07:00 Chicago (CDT) -> before the 09:00 window.
    expect(isWithinWorkingHours(MON_NOON, cfg)).toBe(false);
    // 15:00 UTC = 10:00 Chicago -> inside.
    expect(isWithinWorkingHours(new Date('2026-07-06T15:00:00.000Z'), cfg)).toBe(true);
  });
});

describe('nextRunAt jitter', () => {
  it('is deterministic under a seeded RNG and within the gap bounds', () => {
    const sched = new PacingScheduler(fakeSafety(), { rng: seededRng(42) });
    const a = action('a', 'connect');
    const t1 = sched.nextRunAt(a, MON_NOON);
    const gap = t1.getTime() - MON_NOON.getTime();
    expect(gap).toBeGreaterThanOrEqual(DEFAULT_SCHEDULER_CONFIG.minGapSeconds * 1000);
    expect(gap).toBeLessThanOrEqual((DEFAULT_SCHEDULER_CONFIG.maxGapSeconds + 1) * 1000);

    // Same seed -> same sequence.
    const sched2 = new PacingScheduler(fakeSafety(), { rng: seededRng(42) });
    expect(sched2.nextRunAt(a, MON_NOON).getTime()).toBe(t1.getTime());
  });

  it('clamps an out-of-window action into the next window', () => {
    const sched = new PacingScheduler(fakeSafety(), { rng: seededRng(1) });
    const a = action('a', 'connect', { scheduledAt: MON_EVENING });
    const run = sched.nextRunAt(a, MON_EVENING);
    expect(isWithinWorkingHours(run, DEFAULT_SCHEDULER_CONFIG.working)).toBe(true);
  });
});

describe('dueActions selection', () => {
  it('returns nothing outside working hours', () => {
    const sched = new PacingScheduler(fakeSafety(), { rng: seededRng(1) });
    const res = sched.dueActions(account(), [action('a', 'connect')], MON_EVENING);
    expect(res.due).toHaveLength(0);
    expect(res.skipped[0]?.reason).toBe('outside_working_hours');
  });

  it('selects due, allowed actions inside working hours', () => {
    const sched = new PacingScheduler(fakeSafety(), { rng: seededRng(1) });
    const res = sched.dueActions(account(), [action('a', 'connect'), action('b', 'view_profile')], MON_NOON);
    expect(res.due.map((a) => a.id).sort()).toEqual(['a', 'b']);
  });

  it('skips actions not yet due', () => {
    const sched = new PacingScheduler(fakeSafety(), { rng: seededRng(1) });
    const future = action('a', 'connect', { scheduledAt: new Date('2026-07-06T14:00:00.000Z') });
    const res = sched.dueActions(account(), [future], MON_NOON);
    expect(res.due).toHaveLength(0);
    expect(res.skipped[0]?.reason).toBe('not_due_yet');
  });

  it('dedups by dedupKey within a tick', () => {
    const sched = new PacingScheduler(fakeSafety(), { rng: seededRng(1) });
    const a = action('a', 'connect', { dedupKey: 'same' });
    const b = action('b', 'connect', { dedupKey: 'same' });
    const res = sched.dueActions(account(), [a, b], MON_NOON);
    expect(res.due).toHaveLength(1);
    expect(res.skipped.find((s) => s.reason === 'duplicate')).toBeTruthy();
  });

  it('respects the safety decision (deny / defer)', () => {
    const denied = new PacingScheduler(fakeSafety({ decision: { kind: 'deny', reason: 'x' } }), { rng: seededRng(1) });
    expect(denied.dueActions(account(), [action('a', 'connect')], MON_NOON).due).toHaveLength(0);

    const deferred = new PacingScheduler(
      fakeSafety({ decision: { kind: 'defer', until: MON_EVENING } }),
      { rng: seededRng(1) },
    );
    const res = deferred.dueActions(account(), [action('a', 'connect')], MON_NOON);
    expect(res.due).toHaveLength(0);
    expect(res.skipped[0]?.reason).toBe('deferred');
  });

  it('never exceeds remaining budget headroom within one tick', () => {
    // cap 2, already used 1 -> only 1 more connect should be selected.
    const safety = fakeSafety({ budget: dailyBudget({ connect: 2 }, { connect: 1 }) });
    const sched = new PacingScheduler(safety, { rng: seededRng(1) });
    const queue = [action('a', 'connect'), action('b', 'connect'), action('c', 'connect')];
    const res = sched.dueActions(account(), queue, MON_NOON);
    expect(res.due).toHaveLength(1);
    expect(res.skipped.filter((s) => s.reason === 'budget_exhausted')).toHaveLength(2);
  });
});
