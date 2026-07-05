import { describe, it, expect } from 'vitest';
import type {
  Account,
  AccountState,
  Action,
  ActionType,
  DailyBudget,
  Signal,
  SignalKind,
} from '@loa/shared';

import { DEFAULT_CONFIG } from './config.js';
import { transition, isTerminal } from './state-machine.js';
import { warmupWeek, warmupCaps, warmupComplete } from './warmup.js';
import { DefaultSafetyGate, isoDate, type WeeklyInviteCounter, type Clock } from './safety-gate.js';

const FIXED_NOW = new Date('2026-07-06T12:00:00.000Z'); // a Monday, noon UTC
const fixedClock: Clock = { now: () => FIXED_NOW };

function budget(state: AccountState, used: Partial<Record<ActionType, number>> = {}): DailyBudget {
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
    warmupDay: 0,
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
  it('Cold -> Warming on start', () => {
    expect(transition('Cold', 'start')).toEqual({
      fromState: 'Cold',
      toState: 'Warming',
      reason: expect.any(String),
    });
  });

  it('Warming -> Active on ramp_complete', () => {
    expect(transition('Warming', 'ramp_complete')?.toState).toBe('Active');
  });

  it('Active -> Throttled on soft signal', () => {
    expect(transition('Active', 'soft_signal')?.toState).toBe('Throttled');
  });

  it('Throttled -> Active on recovered', () => {
    expect(transition('Throttled', 'recovered')?.toState).toBe('Active');
  });

  it('Throttled -> Cooldown on repeated soft signal', () => {
    expect(transition('Throttled', 'repeated_soft_signal')?.toState).toBe('Cooldown');
  });

  it('Cooldown -> Warming on rewarm', () => {
    expect(transition('Cooldown', 'rewarm')?.toState).toBe('Warming');
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
    expect(transition('Restricted', 'start')).toBeNull();
  });

  it('rejects illegal edges', () => {
    expect(transition('Cold', 'soft_signal')).toBeNull();
    expect(transition('Active', 'start')).toBeNull();
    expect(transition('Warming', 'soft_signal')).toBeNull();
  });
});

describe('warmup ramp', () => {
  it('maps days to weeks', () => {
    expect(warmupWeek(1)).toBe(1);
    expect(warmupWeek(7)).toBe(1);
    expect(warmupWeek(8)).toBe(2);
    expect(warmupWeek(14)).toBe(2);
    expect(warmupWeek(15)).toBe(3);
    expect(warmupWeek(21)).toBe(3);
    expect(warmupWeek(22)).toBe(4);
    expect(warmupWeek(60)).toBe(4);
  });

  it('week 1 is organic-only: no connects, no messages', () => {
    const w1 = warmupCaps(3, DEFAULT_CONFIG);
    expect(w1.connect).toBe(0);
    expect(w1.message).toBe(0);
    expect(w1.view_profile).toBeGreaterThan(0);
    expect(w1.follow).toBeGreaterThan(0);
  });

  it('week 2 opens connects but not messages', () => {
    const w2 = warmupCaps(10, DEFAULT_CONFIG);
    expect(w2.connect).toBeGreaterThan(0);
    expect(w2.connect).toBeLessThanOrEqual(10);
    expect(w2.message).toBe(0);
  });

  it('week 3 opens messages', () => {
    const w3 = warmupCaps(18, DEFAULT_CONFIG);
    expect(w3.connect).toBeGreaterThan(0);
    expect(w3.message).toBeGreaterThan(0);
  });

  it('week 4 reaches steady-state connect cap', () => {
    const w4 = warmupCaps(25, DEFAULT_CONFIG);
    expect(w4.connect).toBe(DEFAULT_CONFIG.active.connect);
  });

  it('completes only after the ramp length', () => {
    expect(warmupComplete(27, DEFAULT_CONFIG)).toBe(false);
    expect(warmupComplete(28, DEFAULT_CONFIG)).toBe(true);
  });
});

describe('budget by state', () => {
  const gate = new DefaultSafetyGate({ clock: fixedClock });

  it('Active returns steady-state caps', () => {
    const b = gate.budget(account({ state: 'Active' }));
    expect(b.caps.connect).toBe(20);
    expect(b.caps.message).toBe(20);
  });

  it('Warming returns warmup caps for the day', () => {
    const b = gate.budget(account({ state: 'Warming', warmupDay: 3 }));
    expect(b.caps.connect).toBe(0);
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
  const gate = new DefaultSafetyGate({ clock: fixedClock });

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

  it('denies actions the state forbids (connects during warmup week 1)', () => {
    const acct = account({ state: 'Warming', warmupDay: 2, budget: budget('Warming') });
    expect(gate.canAct(acct, action('connect')).kind).toBe('deny');
  });

  it('denies all outbound in Cooldown and Restricted', () => {
    expect(gate.canAct(account({ state: 'Cooldown' }), action('view_profile')).kind).toBe('deny');
    expect(gate.canAct(account({ state: 'Restricted' }), action('message')).kind).toBe('deny');
    expect(gate.canAct(account({ state: 'Cold' }), action('connect')).kind).toBe('deny');
  });

  it('enforces the rolling weekly invite ceiling on connects', () => {
    const counter: WeeklyInviteCounter = { invitesLast7d: () => DEFAULT_CONFIG.weeklyInviteCeiling };
    const g = new DefaultSafetyGate({ clock: fixedClock, weeklyInvites: counter });
    const acct = account({ state: 'Active', budget: budget('Active', { connect: 1 }) });
    // Under the daily cap, but the weekly ceiling is hit -> defer.
    expect(g.canAct(acct, action('connect')).kind).toBe('defer');
    // Non-connect actions are unaffected by the invite ceiling.
    expect(g.canAct(acct, action('view_profile')).kind).toBe('allow');
  });
});

describe('onSignal back-off escalation', () => {
  it('soft signal moves Active -> Throttled', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    const t = gate.onSignal(account({ state: 'Active' }), signal('velocity'));
    expect(t.toState).toBe('Throttled');
  });

  it('repeated soft signal escalates Throttled -> Cooldown after threshold', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    const acct = account({ state: 'Active' });
    // First soft signal: throttle (streak = 1).
    expect(gate.onSignal(acct, signal('velocity')).toState).toBe('Throttled');
    const throttled = account({ state: 'Throttled' });
    // Second soft signal while throttled: streak reaches 2 -> cooldown.
    expect(gate.onSignal(throttled, signal('velocity')).toState).toBe('Cooldown');
  });

  it('low_acceptance below floor still throttles', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    const acct = account({ state: 'Active', health: { acceptanceRate: 0.2, replyRate: 0.1, challengesLast7d: 0, lastCheckedAt: FIXED_NOW } });
    const t = gate.onSignal(acct, signal('low_acceptance'));
    expect(t.toState).toBe('Throttled');
    expect(t.reason).toContain('floor');
  });

  it('ban_banner moves Active -> Restricted', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    expect(gate.onSignal(account({ state: 'Active' }), signal('ban_banner')).toState).toBe('Restricted');
  });

  it('ban_banner on Throttled -> Restricted', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    expect(gate.onSignal(account({ state: 'Throttled' }), signal('ban_banner')).toState).toBe('Restricted');
  });

  it('challenge routes Active into Throttled', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    expect(gate.onSignal(account({ state: 'Active' }), signal('challenge')).toState).toBe('Throttled');
  });

  it('geo_drift flags without moving state', () => {
    const gate = new DefaultSafetyGate({ clock: fixedClock });
    const t = gate.onSignal(account({ state: 'Active' }), signal('geo_drift'));
    expect(t.fromState).toBe(t.toState);
    expect(t.reason).toContain('geo');
  });
});

describe('lifecycle helpers', () => {
  const gate = new DefaultSafetyGate({ clock: fixedClock });

  it('startWarmup only from Cold', () => {
    expect(gate.startWarmup(account({ state: 'Cold' }))?.toState).toBe('Warming');
    expect(gate.startWarmup(account({ state: 'Active' }))).toBeNull();
  });

  it('promoteIfReady requires a completed ramp', () => {
    expect(gate.promoteIfReady(account({ state: 'Warming', warmupDay: 10 }))).toBeNull();
    expect(gate.promoteIfReady(account({ state: 'Warming', warmupDay: 28 }))?.toState).toBe('Active');
  });

  it('recover only from Throttled', () => {
    expect(gate.recover(account({ state: 'Throttled' }))?.toState).toBe('Active');
    expect(gate.recover(account({ state: 'Active' }))).toBeNull();
  });

  it('rewarm only from Cooldown', () => {
    expect(gate.rewarm(account({ state: 'Cooldown' }))?.toState).toBe('Warming');
    expect(gate.rewarm(account({ state: 'Active' }))).toBeNull();
  });
});
