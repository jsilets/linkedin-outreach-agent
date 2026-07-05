// DefaultSafetyGate: the choke point. Decides whether an account may act,
// reacts to detector signals by moving state and cutting budget, and reports
// the per-day budget for an account.

import type {
  Account,
  Action,
  ActionType,
  DailyBudget,
  Decision,
  SafetyGate,
  Signal,
  Transition,
} from '@loa/shared';

import { DEFAULT_CONFIG, type CapTable, type SafetyConfig } from './config.js';
import { isTerminal, transition, type StateEvent } from './state-machine.js';
import { warmupCaps, warmupComplete } from './warmup.js';

/**
 * Port for reading the rolling 7-day count of invites (connect actions) sent
 * by an account. The scheduler/store owns this state; the gate only reads it.
 * If not provided, the gate falls back to today's connect `used` count, which
 * is a conservative lower bound.
 */
export interface WeeklyInviteCounter {
  invitesLast7d(accountId: string): number;
}

/**
 * Optional clock seam so tests can pin "now". Defaults to Date.now.
 */
export interface Clock {
  now(): Date;
}

const REAL_CLOCK: Clock = { now: () => new Date() };

export interface SafetyGateOptions {
  config?: SafetyConfig;
  weeklyInvites?: WeeklyInviteCounter;
  clock?: Clock;
}

/** ISO date (YYYY-MM-DD) for a Date, in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emptyUsed(): Record<ActionType, number> {
  return {
    connect: 0,
    message: 0,
    view_profile: 0,
    follow: 0,
    withdraw_invite: 0,
    react: 0,
  };
}

function scaleCaps(caps: CapTable, factor: number): CapTable {
  const out = {} as CapTable;
  for (const k of Object.keys(caps) as ActionType[]) {
    out[k] = Math.floor(caps[k] * factor);
  }
  return out;
}

const ZERO_CAPS: CapTable = {
  connect: 0,
  message: 0,
  view_profile: 0,
  follow: 0,
  withdraw_invite: 0,
  react: 0,
};

export class DefaultSafetyGate implements SafetyGate {
  private readonly cfg: SafetyConfig;
  private readonly weeklyInvites?: WeeklyInviteCounter;
  private readonly clock: Clock;

  // Consecutive soft-signal counter per account. Reset when the account
  // recovers or a non-soft signal lands. Drives soft -> cooldown escalation.
  private readonly softStreak = new Map<string, number>();

  constructor(opts: SafetyGateOptions = {}) {
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.weeklyInvites = opts.weeklyInvites;
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  /** Caps that apply given the account's state and warmup day. */
  private capsForState(acct: Account): CapTable {
    switch (acct.state) {
      case 'Warming':
        return warmupCaps(acct.warmupDay, this.cfg);
      case 'Active':
        return this.cfg.active;
      case 'Throttled':
        // Throttled cuts whatever the account would otherwise get. A throttled
        // account is conceptually still at its Active steady-state ceiling, so
        // scale the Active caps.
        return scaleCaps(this.cfg.active, this.cfg.throttleMultiplier);
      case 'Cold':
      case 'Cooldown':
      case 'Restricted':
        // No outbound work in these states.
        return ZERO_CAPS;
      default:
        return ZERO_CAPS;
    }
  }

  budget(acct: Account): DailyBudget {
    const today = isoDate(this.clock.now());
    const caps = this.capsForState(acct);
    // Preserve today's usage; reset if the stored budget is from another day.
    const used =
      acct.budget && acct.budget.date === today
        ? { ...emptyUsed(), ...acct.budget.used }
        : emptyUsed();
    return { date: today, caps, used };
  }

  /** Rolling 7-day invite count for connect actions. */
  private invitesLast7d(acct: Account, todayConnectUsed: number): number {
    if (this.weeklyInvites) return this.weeklyInvites.invitesLast7d(acct.id);
    return todayConnectUsed;
  }

  canAct(acct: Account, action: Action): Decision {
    const type = action.type;

    // Terminal / no-outbound states deny outright.
    if (acct.state === 'Restricted') {
      return { kind: 'deny', reason: 'account restricted; halted pending human review' };
    }
    if (acct.state === 'Cooldown') {
      return { kind: 'deny', reason: 'account in cooldown; no outbound actions' };
    }
    if (acct.state === 'Cold') {
      return { kind: 'deny', reason: 'account not warmed up; start warmup first' };
    }

    const b = this.budget(acct);
    const cap = b.caps[type];
    const used = b.used[type] ?? 0;

    // State forbids this action entirely (e.g. connects in warmup week 1).
    if (cap <= 0) {
      return { kind: 'deny', reason: `action ${type} not permitted in state ${acct.state}` };
    }

    // Daily cap for this action type is exhausted: defer to the next day.
    if (used >= cap) {
      return { kind: 'defer', until: nextDay(this.clock.now()) };
    }

    // Rolling weekly invite ceiling is a second, independent constraint on
    // connects. Once hit, defer connects to the next day.
    if (type === 'connect') {
      const weekInvites = this.invitesLast7d(acct, used);
      if (weekInvites >= this.cfg.weeklyInviteCeiling) {
        return { kind: 'defer', until: nextDay(this.clock.now()) };
      }
    }

    return { kind: 'allow' };
  }

  onSignal(acct: Account, sig: Signal): Transition {
    const noop: Transition = {
      fromState: acct.state,
      toState: acct.state,
      reason: `signal ${sig.kind} noted; no state change`,
    };

    // Hard stop. A ban banner ends the account.
    if (sig.kind === 'ban_banner') {
      this.softStreak.delete(acct.id);
      return this.applyEvent(acct, 'hard_signal') ?? {
        fromState: acct.state,
        toState: acct.state,
        reason: 'ban banner on terminal/ineligible state; halt and raise human task',
      };
    }

    // A challenge (checkpoint / captcha) is not a ban but must stop activity;
    // route into cooldown by throttling first if Active, else escalating.
    if (sig.kind === 'challenge') {
      return this.throttleOrCooldown(acct, 'challenge issued');
    }

    // geo_drift: the action's egress region no longer matches the account.
    // This is handled as a per-action block in canAct callers; at the state
    // level it is a soft warning that does not itself move state.
    if (sig.kind === 'geo_drift') {
      return {
        fromState: acct.state,
        toState: acct.state,
        reason: 'geo drift detected; block affected actions and flag for review',
      };
    }

    // velocity and low_acceptance are soft signals. low_acceptance below the
    // acceptance-rate floor is a ban-risk trigger and is treated more harshly.
    const belowFloor =
      sig.kind === 'low_acceptance' && acct.health.acceptanceRate < this.cfg.acceptanceRateFloor;

    return this.throttleOrCooldown(
      acct,
      belowFloor
        ? `acceptance rate ${acct.health.acceptanceRate} below floor ${this.cfg.acceptanceRateFloor}`
        : `soft signal ${sig.kind}`,
    );
  }

  /**
   * Soft-signal handling with exponential back-off in state terms: first soft
   * signal on an Active account throttles it; a further soft signal while
   * already Throttled (once the streak crosses the configured threshold)
   * escalates to Cooldown.
   */
  private throttleOrCooldown(acct: Account, reason: string): Transition {
    const streak = (this.softStreak.get(acct.id) ?? 0) + 1;
    this.softStreak.set(acct.id, streak);

    if (acct.state === 'Active') {
      const t = transition(acct.state, 'soft_signal');
      if (t) return { ...t, reason: `${t.reason}: ${reason}` };
    }

    if (acct.state === 'Throttled') {
      if (streak >= this.cfg.softSignalCooldownThreshold) {
        const t = transition(acct.state, 'repeated_soft_signal');
        if (t) {
          this.softStreak.delete(acct.id);
          return { ...t, reason: `${t.reason}: ${reason}` };
        }
      }
      // Not yet at the escalation threshold: stay throttled, budget already cut.
      return {
        fromState: acct.state,
        toState: acct.state,
        reason: `throttled; awaiting escalation (${streak}/${this.cfg.softSignalCooldownThreshold}): ${reason}`,
      };
    }

    // Any other state: record but do not move.
    return {
      fromState: acct.state,
      toState: acct.state,
      reason: `soft signal in state ${acct.state}; no transition: ${reason}`,
    };
  }

  private applyEvent(acct: Account, event: StateEvent): Transition | null {
    if (isTerminal(acct.state)) return null;
    return transition(acct.state, event);
  }

  // -- Lifecycle helpers the orchestrator calls explicitly (not signal-driven).

  /** Cold -> Warming. Returns null if not applicable. */
  startWarmup(acct: Account): Transition | null {
    return transition(acct.state, 'start');
  }

  /** Warming -> Active once the ramp is complete. Returns null otherwise. */
  promoteIfReady(acct: Account): Transition | null {
    if (acct.state !== 'Warming') return null;
    if (!warmupComplete(acct.warmupDay, this.cfg)) return null;
    this.softStreak.delete(acct.id);
    return transition(acct.state, 'ramp_complete');
  }

  /** Throttled -> Active after health recovers. Returns null otherwise. */
  recover(acct: Account): Transition | null {
    if (acct.state !== 'Throttled') return null;
    this.softStreak.delete(acct.id);
    return transition(acct.state, 'recovered');
  }

  /** Cooldown -> Warming to restart the ramp. Returns null otherwise. */
  rewarm(acct: Account): Transition | null {
    if (acct.state !== 'Cooldown') return null;
    this.softStreak.delete(acct.id);
    return transition(acct.state, 'rewarm');
  }
}

/** Start of the next UTC day after `d`. Used as a defer target. */
export function nextDay(d: Date): Date {
  const n = new Date(d);
  n.setUTCHours(0, 0, 0, 0);
  n.setUTCDate(n.getUTCDate() + 1);
  return n;
}
