import type {
  Account,
  AccountSchedule,
  AccountState,
  Action,
  ActionType,
  DailyBudget,
  Signal,
  SignalKind,
} from '@loa/shared';
import { describe, expect, it } from 'vitest';
import { type CapTable, DEFAULT_CONFIG } from './config.js';
import {
  activeHoursDefer,
  type Clock,
  type DailyUsageCounter,
  DefaultSafetyGate,
  isoDate,
  type RecentActionClock,
  scheduleDefer,
  type WeeklyInviteCounter,
} from './safety-gate.js';
import { isTerminal, transition } from './state-machine.js';

// Local noon (not UTC) so it sits inside the default 8am-8pm active-hours
// window in any timezone the tests run in; the window is exercised separately.
const FIXED_NOW = new Date(2026, 6, 6, 12, 0, 0); // a Monday, local noon
const fixedClock: Clock = { now: () => FIXED_NOW };

function budget(_state: AccountState, used: Partial<Record<ActionType, number>> = {}): DailyBudget {
  return {
    date: isoDate(FIXED_NOW),
    caps: { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 },
    used: {
      connect: 0,
      message: 0,
      view_profile: 0,
      follow: 0,
      withdraw_invite: 0,
      react: 0,
      ...used,
    },
  };
}

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'acct-1',
    handle: 'test-handle',
    proxyBinding: { proxyId: 'p1', region: 'us', sticky: true },
    state: 'Active',
    health: {
      acceptanceRate: 0.8,
      replyRate: 0.4,
      challengesLast7d: 0,
      lastCheckedAt: FIXED_NOW,
    },
    budget: budget('Active'),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...over,
  };
}

function action(type: ActionType, over: Partial<Action> = {}): Action {
  return {
    id: `act-${type}`,
    type,
    scheduledAt: FIXED_NOW,
    executedAt: null,
    result: 'pending',
    dedupKey: `${type}:target`,
    accountId: 'acct-1',
    targetId: 'target',
    campaignId: 'camp',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...over,
  };
}

function signal(kind: SignalKind): Signal {
  return { kind, observedAt: FIXED_NOW };
}

describe('state machine transitions', () => {
  it('Active -> Throttled on soft signal', () => {
    expect(transition('Active', 'soft_signal')?.toState).toBe('Throttled');
  });

  it('Throttled -> Active on recovered', () => {
    expect(transition('Throttled', 'recovered')?.toState).toBe('Active');
  });

  it('Throttled -> Cooldown on repeated soft signal', () => {
    expect(transition('Throttled', 'repeated_soft_signal')?.toState).toBe('Cooldown');
  });

  it('Cooldown -> Active on recovered', () => {
    expect(transition('Cooldown', 'recovered')?.toState).toBe('Active');
  });

  it('legacy Cold -> Active on recovered', () => {
    expect(transition('Cold', 'recovered')?.toState).toBe('Active');
  });

  it('Active -> Restricted on hard signal', () => {
    expect(transition('Active', 'hard_signal')?.toState).toBe('Restricted');
  });

  it('Throttled -> Restricted on hard signal', () => {
    expect(transition('Throttled', 'hard_signal')?.toState).toBe('Restricted');
  });

  it('Restricted is terminal', () => {
    expect(isTerminal('Restricted')).toBe(true);
    expect(transition('Restricted', 'recovered')).toBeNull();
    expect(transition('Restricted', 'hard_signal')).toBeNull();
  });

  it('rejects illegal edges', () => {
    expect(transition('Cold', 'soft_signal')).toBeNull();
    expect(transition('Active', 'recovered')).toBeNull();
  });
});

describe('budget by state', () => {
  const gate = new DefaultSafetyGate({
    allowMissingCounters: true,
    clock: fixedClock,
  });

  it('Active returns steady-state caps', () => {
    const b = gate.budget(account({ state: 'Active' }));
    expect(b.caps.connect).toBe(20);
    expect(b.caps.message).toBe(20);
  });

  it('legacy Cold/Warming are treated as Active caps', () => {
    expect(gate.budget(account({ state: 'Cold' })).caps.connect).toBe(20);
    expect(gate.budget(account({ state: 'Warming' })).caps.connect).toBe(20);
  });

  it('Throttled halves the Active caps', () => {
    const b = gate.budget(account({ state: 'Throttled' }));
    expect(b.caps.connect).toBe(10);
    expect(b.caps.message).toBe(10);
  });

  it('Cooldown and Restricted zero everything', () => {
    expect(gate.budget(account({ state: 'Cooldown' })).caps.connect).toBe(0);
    expect(gate.budget(account({ state: 'Restricted' })).caps.message).toBe(0);
  });

  it("uses the account's own editable limits over the config default", () => {
    const caps = {
      connect: 5,
      message: 3,
      view_profile: 40,
      follow: 7,
      withdraw_invite: 2,
      react: 9,
    };
    const b = gate.budget(account({ state: 'Active', limits: { caps } }));
    expect(b.caps.connect).toBe(5);
    expect(b.caps.message).toBe(3);
  });

  it('scales the per-account limits when Throttled', () => {
    const caps = {
      connect: 8,
      message: 8,
      view_profile: 40,
      follow: 7,
      withdraw_invite: 2,
      react: 9,
    };
    // Throttled halves the account's own base caps, not the config default.
    expect(gate.budget(account({ state: 'Throttled', limits: { caps } })).caps.connect).toBe(4);
  });

  it('operator action toggles disable only that action type', () => {
    const acct = account({
      state: 'Active',
      limits: { caps: DEFAULT_CONFIG.active, enabled: { connect: false, message: true } },
    });
    expect(gate.canAct(acct, action('connect'))).toEqual({
      kind: 'deny',
      reason: 'action connect disabled by operator',
    });
    expect(gate.canAct(acct, action('message'))).toEqual({ kind: 'allow' });
  });

  it('resets used when the stored budget is from another day', () => {
    const stale: DailyBudget = { ...budget('Active', { connect: 5 }), date: '2020-01-01' };
    const b = gate.budget(account({ state: 'Active', budget: stale }));
    expect(b.used.connect).toBe(0);
  });

  it('preserves used from today', () => {
    const b = gate.budget(account({ state: 'Active', budget: budget('Active', { connect: 5 }) }));
    expect(b.used.connect).toBe(5);
  });
});

describe('canAct enforcement', () => {
  const gate = new DefaultSafetyGate({
    allowMissingCounters: true,
    clock: fixedClock,
  });

  it('allows when under cap in a permitting state', () => {
    const acct = account({ state: 'Active', budget: budget('Active', { connect: 3 }) });
    expect(gate.canAct(acct, action('connect')).kind).toBe('allow');
  });

  it('defers when the daily cap is exhausted', () => {
    const acct = account({ state: 'Active', budget: budget('Active', { connect: 20 }) });
    const d = gate.canAct(acct, action('connect'));
    expect(d.kind).toBe('defer');
    if (d.kind === 'defer') expect(d.until.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
  });

  it('allows legacy Cold/Warming accounts (treated as Active, no warmup)', () => {
    expect(gate.canAct(account({ state: 'Cold' }), action('connect')).kind).toBe('allow');
    expect(gate.canAct(account({ state: 'Warming' }), action('connect')).kind).toBe('allow');
  });

  it('denies all outbound in Cooldown and Restricted', () => {
    expect(gate.canAct(account({ state: 'Cooldown' }), action('view_profile')).kind).toBe('deny');
    expect(gate.canAct(account({ state: 'Restricted' }), action('message')).kind).toBe('deny');
  });

  it('enforces the rolling weekly invite ceiling on connects', () => {
    const counter: WeeklyInviteCounter = {
      invitesLast7d: () => DEFAULT_CONFIG.weeklyInviteCeiling,
    };
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      weeklyInvites: counter,
    });
    const acct = account({ state: 'Active', budget: budget('Active', { connect: 1 }) });
    // Under the daily cap, but the weekly ceiling is hit -> defer.
    expect(g.canAct(acct, action('connect')).kind).toBe('defer');
    // Non-connect actions are unaffected by the invite ceiling.
    expect(g.canAct(acct, action('view_profile')).kind).toBe('allow');
  });
});

describe('daily usage cap (store-backed counter)', () => {
  const CONNECT_CAP = 20;

  function limitsWith(connect: number): Account['limits'] {
    return {
      caps: { connect, message: 20, view_profile: 60, follow: 20, withdraw_invite: 50, react: 30 },
    };
  }

  function usage(over: Partial<Record<ActionType, number>>): DailyUsageCounter {
    return {
      usedToday: () => ({
        connect: 0,
        message: 0,
        view_profile: 0,
        follow: 0,
        withdraw_invite: 0,
        react: 0,
        ...over,
      }),
    };
  }

  it('defers at the cap from the COUNTER even when acct.budget.used is stale-zero', () => {
    // Regression: the persisted acct.budget.used is never written with today's
    // count, so the gate must read the injected counter. Relying on the row is
    // what let 31 invites go out under a 20/day cap.
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      dailyUsage: usage({ connect: CONNECT_CAP }),
    });
    const acct = account({
      state: 'Active',
      limits: limitsWith(CONNECT_CAP),
      budget: budget('Active', { connect: 0 }),
    });
    expect(g.canAct(acct, action('connect')).kind).toBe('defer');
  });

  it('allows when the counter is one below the cap', () => {
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      dailyUsage: usage({ connect: CONNECT_CAP - 1 }),
    });
    const acct = account({
      state: 'Active',
      limits: limitsWith(CONNECT_CAP),
      budget: budget('Active', { connect: 0 }),
    });
    expect(g.canAct(acct, action('connect')).kind).toBe('allow');
  });

  it('is per-type: a maxed connect count does not block messages', () => {
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      dailyUsage: usage({ connect: CONNECT_CAP }),
    });
    const acct = account({
      state: 'Active',
      limits: limitsWith(CONNECT_CAP),
      budget: budget('Active'),
    });
    expect(g.canAct(acct, action('message')).kind).toBe('allow');
  });

  it('falls back to acct.budget.used when no counter is wired', () => {
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    const acct = account({
      state: 'Active',
      limits: limitsWith(CONNECT_CAP),
      budget: budget('Active', { connect: CONNECT_CAP }),
    });
    expect(g.canAct(acct, action('connect')).kind).toBe('defer');
  });
});

describe('action pacing', () => {
  // Fixed rng => gap is exactly minActionGapMs (jitter term floors to 0).
  const zeroJitterRng = () => 0;
  const gapMs = DEFAULT_CONFIG.minActionGapMs;

  function pacer(last: Date | undefined): RecentActionClock {
    return { lastActionAt: () => last };
  }

  it('allows the first action (no prior timestamp)', () => {
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      recentActions: pacer(undefined),
      rng: zeroJitterRng,
    });
    const acct = account({ state: 'Active', budget: budget('Active') });
    expect(g.canAct(acct, action('connect')).kind).toBe('allow');
  });

  it('defers a second action inside the gap, until last + gap', () => {
    const last = new Date(FIXED_NOW.getTime() - (gapMs - 1)); // 1ms short of the gap
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      recentActions: pacer(last),
      rng: zeroJitterRng,
    });
    const acct = account({ state: 'Active', budget: budget('Active') });
    const d = g.canAct(acct, action('connect'));
    expect(d.kind).toBe('defer');
    if (d.kind === 'defer') expect(d.until.getTime()).toBe(last.getTime() + gapMs);
  });

  it('allows once the gap has elapsed', () => {
    const last = new Date(FIXED_NOW.getTime() - gapMs); // exactly at the boundary
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      recentActions: pacer(last),
      rng: zeroJitterRng,
    });
    const acct = account({ state: 'Active', budget: budget('Active') });
    expect(g.canAct(acct, action('connect')).kind).toBe('allow');
  });

  it('applies across action types (spacing is per account, not per type)', () => {
    const last = new Date(FIXED_NOW.getTime() - (gapMs - 1));
    const g = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      recentActions: pacer(last),
      rng: zeroJitterRng,
    });
    const acct = account({ state: 'Active', budget: budget('Active') });
    // A view_profile is paced by the same last-action timestamp as a connect.
    expect(g.canAct(acct, action('view_profile')).kind).toBe('defer');
    expect(g.canAct(acct, action('message')).kind).toBe('defer');
  });
});

describe('onSignal back-off escalation', () => {
  it('soft signal moves Active -> Throttled', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    const t = gate.onSignal(account({ state: 'Active' }), signal('velocity'));
    expect(t.toState).toBe('Throttled');
  });

  it('repeated soft signal escalates Throttled -> Cooldown after threshold', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    const acct = account({ state: 'Active' });
    // First soft signal: throttle (streak = 1).
    expect(gate.onSignal(acct, signal('velocity')).toState).toBe('Throttled');
    const throttled = account({ state: 'Throttled' });
    // Second soft signal while throttled: streak reaches 2 -> cooldown.
    expect(gate.onSignal(throttled, signal('velocity')).toState).toBe('Cooldown');
  });

  it('low_acceptance below floor still throttles', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    const acct = account({
      state: 'Active',
      health: {
        acceptanceRate: 0.2,
        replyRate: 0.1,
        challengesLast7d: 0,
        lastCheckedAt: FIXED_NOW,
      },
    });
    const t = gate.onSignal(acct, signal('low_acceptance'));
    expect(t.toState).toBe('Throttled');
    expect(t.reason).toContain('floor');
  });

  it('ban_banner moves Active -> Restricted', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    expect(gate.onSignal(account({ state: 'Active' }), signal('ban_banner')).toState).toBe(
      'Restricted',
    );
  });

  it('ban_banner on Throttled -> Restricted', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    expect(gate.onSignal(account({ state: 'Throttled' }), signal('ban_banner')).toState).toBe(
      'Restricted',
    );
  });

  it('challenge routes Active into Throttled', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    expect(gate.onSignal(account({ state: 'Active' }), signal('challenge')).toState).toBe(
      'Throttled',
    );
  });

  it('geo_drift flags without moving state', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    const t = gate.onSignal(account({ state: 'Active' }), signal('geo_drift'));
    expect(t.fromState).toBe(t.toState);
    expect(t.reason).toContain('geo');
  });
});

describe('lifecycle helpers', () => {
  const gate = new DefaultSafetyGate({
    allowMissingCounters: true,
    clock: fixedClock,
  });

  it('recover from Throttled -> Active', () => {
    expect(gate.recover(account({ state: 'Throttled' }))?.toState).toBe('Active');
  });

  it('recover from Cooldown -> Active', () => {
    expect(gate.recover(account({ state: 'Cooldown' }))?.toState).toBe('Active');
  });

  it('recover is a no-op from other states', () => {
    expect(gate.recover(account({ state: 'Active' }))).toBeNull();
    expect(gate.recover(account({ state: 'Cold' }))).toBeNull();
  });
});

describe('active-hours window', () => {
  // Local-time constructors so getHours() is deterministic regardless of the
  // machine timezone: new Date(y,m,d,H) and getHours() are both local.
  const at = (hour: number) => new Date(2026, 6, 6, hour, 0, 0);

  it('no defer inside the window', () => {
    expect(activeHoursDefer(at(8), DEFAULT_CONFIG)).toBeNull(); // inclusive start
    expect(activeHoursDefer(at(12), DEFAULT_CONFIG)).toBeNull();
    expect(activeHoursDefer(at(19), DEFAULT_CONFIG)).toBeNull(); // last active hour
  });

  it('before the window defers to today at start', () => {
    const d = activeHoursDefer(at(6), DEFAULT_CONFIG);
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(8);
    expect(d!.getDate()).toBe(6); // same day
  });

  it('at/after the window end defers to tomorrow at start', () => {
    const d = activeHoursDefer(at(20), DEFAULT_CONFIG); // end is exclusive
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(8);
    expect(d!.getDate()).toBe(7); // next day
  });

  it('is disabled when start === end', () => {
    const cfg = { ...DEFAULT_CONFIG, activeHoursStart: 0, activeHoursEnd: 0 };
    expect(activeHoursDefer(at(3), cfg)).toBeNull();
  });

  it('canAct defers an otherwise-allowed action when outside the window', () => {
    const nightClock: Clock = { now: () => at(3) };
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: nightClock,
    });
    const acct = account({ state: 'Active' });
    const d = gate.canAct(acct, action('connect'));
    expect(d.kind).toBe('defer');
    if (d.kind === 'defer') expect(d.until.getHours()).toBe(8);
  });
});

describe('constructor counter guard', () => {
  const counters = {
    dailyUsage: { usedToday: () => budget('Active').used },
    weeklyInvites: { invitesLast7d: () => 0 },
    recentActions: { lastActionAt: () => undefined },
  };

  it('throws when any counter is missing and the test flag is not set', () => {
    // A gate without its counters silently enforces nothing — the exact
    // misconfiguration that once let 32 invites out under a 20/day cap.
    expect(() => new DefaultSafetyGate({ clock: fixedClock })).toThrow(/requires dailyUsage/);
    expect(
      () => new DefaultSafetyGate({ clock: fixedClock, dailyUsage: counters.dailyUsage }),
    ).toThrow(/requires dailyUsage/);
  });

  it('constructs when all three counters are wired', () => {
    expect(() => new DefaultSafetyGate({ clock: fixedClock, ...counters })).not.toThrow();
  });
});

describe('operator pause', () => {
  it('denies every action type for a paused account, before any other check', () => {
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      pause: { isPaused: () => true },
    });
    const acct = account({ state: 'Active' });
    for (const t of ['connect', 'message', 'react', 'view_profile'] as ActionType[]) {
      const d = gate.canAct(acct, action(t));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toContain('paused');
    }
  });

  it('allows again once the pause flag clears', () => {
    let paused = true;
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
      pause: { isPaused: () => paused },
    });
    const acct = account({ state: 'Active' });
    expect(gate.canAct(acct, action('connect')).kind).toBe('deny');
    paused = false;
    expect(gate.canAct(acct, action('connect')).kind).toBe('allow');
  });
});

describe('missing cap entry fails closed', () => {
  it('denies an action type absent from the account caps table', () => {
    // Simulate a caps blob written before a new action type existed: the key
    // is simply missing. An undefined cap must deny, not fall through to allow.
    const partialCaps = { connect: 20, message: 20 } as CapTable;
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      clock: fixedClock,
    });
    const acct = account({ state: 'Active', limits: { caps: partialCaps } });
    expect(gate.canAct(acct, action('react')).kind).toBe('deny');
    // Types that DO have an entry still work.
    expect(gate.canAct(acct, action('connect')).kind).toBe('allow');
  });
});

describe('working schedule (hours + days)', () => {
  // 2026-07-06 is a Monday, so 07-10 = Friday, 07-11 = Saturday, 07-12 = Sunday.
  const at = (y: number, mo: number, d: number, h: number) => new Date(y, mo, d, h, 0, 0);
  // Saturday off, everything else on; 8am-8pm.
  const satOff: AccountSchedule = { hoursStart: 8, hoursEnd: 20, days: [0, 1, 2, 3, 4, 5] };

  it('allows inside the window on an active day', () => {
    expect(scheduleDefer(at(2026, 6, 12, 12), satOff)).toBeNull(); // Sunday noon (kept on)
    expect(scheduleDefer(at(2026, 6, 10, 12), satOff)).toBeNull(); // Friday noon
  });

  it('defers a Saturday send to Sunday 8am (Saturday is a day off)', () => {
    const d = scheduleDefer(at(2026, 6, 11, 12), satOff); // Saturday noon
    expect(d).not.toBeNull();
    expect(d!.getDay()).toBe(0); // Sunday
    expect(d!.getDate()).toBe(12);
    expect(d!.getHours()).toBe(8);
  });

  it('skips the day off: a Friday-evening send lands Sunday, not Saturday', () => {
    const d = scheduleDefer(at(2026, 6, 10, 21), satOff); // Friday 9pm, past the window
    expect(d!.getDate()).toBe(12); // Sunday, hopping over Saturday
    expect(d!.getHours()).toBe(8);
  });

  it('defers an early active-day send to that day at the window start', () => {
    const d = scheduleDefer(at(2026, 6, 10, 6), satOff); // Friday 6am
    expect(d!.getDate()).toBe(10); // same day
    expect(d!.getHours()).toBe(8);
  });

  it('the gate defers a Saturday action for an account scheduled Saturday-off', () => {
    const satClock: Clock = { now: () => at(2026, 6, 11, 12) };
    const gate = new DefaultSafetyGate({ allowMissingCounters: true, clock: satClock });
    const caps = {
      connect: 20,
      message: 20,
      view_profile: 60,
      follow: 20,
      withdraw_invite: 50,
      react: 30,
    };
    const acct = account({ state: 'Active', limits: { caps, schedule: satOff } });
    const d = gate.canAct(acct, action('message'));
    expect(d.kind).toBe('defer');
    if (d.kind === 'defer') expect(d.until.getDay()).toBe(0); // Sunday
  });

  it('uses an action-specific schedule without closing other action types', () => {
    const satClock: Clock = { now: () => at(2026, 6, 11, 12) };
    const gate = new DefaultSafetyGate({ allowMissingCounters: true, clock: satClock });
    const caps = {
      connect: 20,
      message: 20,
      view_profile: 60,
      follow: 20,
      withdraw_invite: 50,
      react: 30,
    };
    const acct = account({
      state: 'Active',
      limits: {
        caps,
        schedule: { hoursStart: 8, hoursEnd: 20, days: [0, 1, 2, 3, 4, 5, 6] },
        schedules: { message: satOff },
      },
    });
    expect(gate.canAct(acct, action('connect'))).toEqual({ kind: 'allow' });
    const d = gate.canAct(acct, action('message'));
    expect(d.kind).toBe('defer');
    if (d.kind === 'defer') expect(d.until.getDay()).toBe(0);
  });
});
