// DefaultSafetyGate: the choke point. Decides whether an account may act,
// reacts to detector signals by moving state and cutting budget, and reports
// the per-day budget for an account.

import type {
  Account,
  AccountSchedule,
  Action,
  ActionType,
  DailyBudget,
  Decision,
  SafetyGate,
  Signal,
  Transition,
} from '@loa/shared';
import { DEFAULT_SCHEDULE } from '@loa/shared';

import { type CapTable, DEFAULT_CONFIG, type SafetyConfig } from './config.js';
import { isTerminal, type StateEvent, transition } from './state-machine.js';

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
 * Port for reading today's usage per action type for an account — the count that
 * the daily caps are checked against. The scheduler/store owns this state; the
 * gate only reads it synchronously inside budget()/canAct. If not provided, the
 * gate falls back to the persisted `acct.budget.used`, which is NEVER written
 * with today's live count and therefore silently disables the daily cap — so a
 * real deployment MUST wire this. A rolling-24h implementation is preferred over
 * a calendar-day one so the cap can't reset mid-day at the UTC boundary.
 */
export interface DailyUsageCounter {
  usedToday(accountId: string): Record<ActionType, number>;
}

/**
 * Port for reading how many invitations this account has sent that the
 * recipient has neither accepted nor ignored away — the PENDING pile.
 *
 * This is a different limit from the weekly ceiling, and LinkedIn documents it
 * as carrying the harshest penalty they list: an account restricted for "too
 * many outstanding invitations" can wait up to a month, versus about a week for
 * the ordinary invite limit. LinkedIn publishes no threshold, so the ceiling
 * here is a backstop against an obviously-unhealthy pile, not a model of their
 * rule.
 *
 * It grows structurally: every invite that is never accepted stays in the pile
 * forever unless it is withdrawn. At a 38% acceptance rate roughly six of every
 * ten invites sent are permanent additions.
 */
export interface OutstandingInviteCounter {
  outstandingInvites(accountId: string): number;
}

/**
 * Port for reading the timestamp of the most recent outbound action on an
 * account, across ALL action types. The runtime owns this state (kept warm as
 * actions execute, rehydrated from action rows on boot); the gate only reads it
 * to space actions apart. If not provided, no pacing constraint is applied.
 */
export interface RecentActionClock {
  lastActionAt(accountId: string): Date | undefined;
}

/**
 * Port for reading the operator pause flag for an account. Pause is an operator
 * override (pause_account / kill_all), orthogonal to the account state machine:
 * a paused account keeps its state and caps but the gate denies every outbound
 * action until it is resumed. The runtime owns this state (persisted as
 * account_paused/account_resumed events, rehydrated at boot).
 */
export interface PauseState {
  isPaused(accountId: string): boolean;
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
  /** Today's per-type usage. Without it the daily cap is not enforced. */
  dailyUsage?: DailyUsageCounter;
  /** Pending-invite pile. Without it the outstanding ceiling is not enforced. */
  outstandingInvites?: OutstandingInviteCounter;
  clock?: Clock;
  recentActions?: RecentActionClock;
  /** Operator pause flag. When wired, a paused account is denied every action. */
  pause?: PauseState;
  /** RNG seam for the action-gap jitter. Defaults to Math.random. */
  rng?: () => number;
  /**
   * TEST-ONLY escape hatch. Without all three counters (dailyUsage,
   * weeklyInvites, recentActions) the gate silently loses its daily caps,
   * weekly ceiling, and pacing — the exact misconfiguration that once let 32
   * invites out under a 20/day cap. The constructor therefore throws unless
   * every counter is wired or this flag is set. Never set it in production.
   */
  allowMissingCounters?: boolean;
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
  private readonly dailyUsage?: DailyUsageCounter;
  private readonly outstandingInvites?: OutstandingInviteCounter;
  private readonly clock: Clock;
  private readonly recentActions?: RecentActionClock;
  private readonly pause?: PauseState;
  private readonly rng: () => number;

  // Consecutive soft-signal counter per account. Reset when the account
  // recovers or a non-soft signal lands. Drives soft -> cooldown escalation.
  private readonly softStreak = new Map<string, number>();

  constructor(opts: SafetyGateOptions = {}) {
    if (
      !opts.allowMissingCounters &&
      (!opts.dailyUsage || !opts.weeklyInvites || !opts.recentActions || !opts.outstandingInvites)
    ) {
      // Fail closed at construction: a gate without its counters silently
      // enforces nothing (daily caps read a never-updated fallback, the weekly
      // ceiling can never fire cross-day, pacing is skipped entirely, and the
      // outstanding-invite pile is unbounded).
      throw new Error(
        'DefaultSafetyGate requires dailyUsage, weeklyInvites, recentActions, and ' +
          'outstandingInvites; pass allowMissingCounters: true only in tests',
      );
    }
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.weeklyInvites = opts.weeklyInvites;
    this.dailyUsage = opts.dailyUsage;
    this.outstandingInvites = opts.outstandingInvites;
    this.clock = opts.clock ?? REAL_CLOCK;
    this.recentActions = opts.recentActions;
    this.pause = opts.pause;
    this.rng = opts.rng ?? Math.random;
  }

  /**
   * The account's editable base caps: its own `limits.caps` when set, else the
   * config fallback. This is the single source of truth for steady-state caps.
   */
  private baseCaps(acct: Account): CapTable {
    return acct.limits?.caps ?? this.cfg.active;
  }

  /** Caps that apply given the account's state. */
  private capsForState(acct: Account): CapTable {
    switch (acct.state) {
      // Cold/Warming are legacy labels with no warmup ramp any more; treat them
      // as steady-state Active.
      case 'Cold':
      case 'Warming':
      case 'Active':
        return this.baseCaps(acct);
      case 'Throttled':
        // Throttled cuts whatever the account would otherwise get. A throttled
        // account is conceptually still at its Active steady-state ceiling, so
        // scale the account's base caps.
        return scaleCaps(this.baseCaps(acct), this.cfg.throttleMultiplier);
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
    // Prefer the store-backed usage counter when wired. The persisted
    // acct.budget.used is never written with today's live count, so falling back
    // to it silently disables the daily cap; the counter reflects real action
    // rows and survives restarts. Preserve the day-scoped fallback for callers
    // (e.g. tests) that don't wire a counter.
    const used = this.dailyUsage
      ? { ...emptyUsed(), ...this.dailyUsage.usedToday(acct.id) }
      : acct.budget && acct.budget.date === today
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
    // Operator pause is the hardest stop of all: it is checked before anything
    // else so pause_account / kill_all actually halt outbound work.
    if (this.pause?.isPaused(acct.id)) {
      return { kind: 'deny', reason: 'account paused by operator' };
    }

    if (acct.state === 'Restricted') {
      return { kind: 'deny', reason: 'account restricted; halted pending human review' };
    }
    if (acct.state === 'Cooldown') {
      return { kind: 'deny', reason: 'account in cooldown; no outbound actions' };
    }
    if (!actionEnabled(acct, type)) {
      return { kind: 'deny', reason: `action ${type} disabled by operator` };
    }

    const b = this.budget(acct);
    // Fail closed on a missing cap entry: an undefined cap would sail past both
    // comparisons below and allow the action uncapped (e.g. an action type added
    // after an account's caps blob was written).
    const cap = b.caps[type] ?? 0;
    const used = b.used[type] ?? 0;

    // State forbids this action entirely (cap of 0 for this type).
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

    // Outstanding-invite ceiling: a third, independent constraint on connects,
    // and the one LinkedIn punishes hardest (their docs put "too many
    // outstanding invitations" at up to a month, against about a week for the
    // ordinary limit).
    //
    // Deliberately a DENY with a reason, not a defer. The pile does not drain by
    // waiting — an invite nobody accepts is outstanding forever — so deferring to
    // tomorrow would retry, silently, every day, forever. A deny names the
    // condition. The remedy is withdrawing stale invites (withdraw_invite exists
    // and is not yet driven by anything), or accepting that this account is done
    // inviting until its pile clears.
    if (type === 'connect' && this.outstandingInvites) {
      const pending = this.outstandingInvites.outstandingInvites(acct.id);
      if (pending >= this.cfg.outstandingInviteCeiling) {
        return {
          kind: 'deny',
          reason:
            `${pending} outstanding invitations (ceiling ${this.cfg.outstandingInviteCeiling}); ` +
            'withdraw stale invites before sending more',
        };
      }
    }

    // Working schedule (hours + days): a self-running engine should not send
    // overnight or on the account's days off. Outside the window, defer to the
    // next active day's start (coarser than the daily cap, so it runs before
    // pacing). An action-specific schedule wins, then the account-wide schedule,
    // then the global config.
    const windowDefer = scheduleDefer(this.clock.now(), effectiveSchedule(acct, this.cfg, type));
    if (windowDefer) {
      return { kind: 'defer', until: windowDefer };
    }

    // Per-account spacing across ALL action types: the caps bound the daily
    // count but not the cadence, so a dispatch tick could otherwise fire every
    // due action back-to-back. Space each action by a jittered gap. The first
    // action (no prior timestamp) is always allowed.
    if (this.recentActions) {
      const last = this.recentActions.lastActionAt(acct.id);
      if (last) {
        const gap = this.cfg.minActionGapMs + Math.floor(this.rng() * this.cfg.actionGapJitterMs);
        const readyAt = last.getTime() + gap;
        if (this.clock.now().getTime() < readyAt) {
          return { kind: 'defer', until: new Date(readyAt) };
        }
      }
    }

    return { kind: 'allow' };
  }

  onSignal(acct: Account, sig: Signal): Transition {
    // Hard stop. A ban banner ends the account.
    if (sig.kind === 'ban_banner') {
      this.softStreak.delete(acct.id);
      return (
        this.applyEvent(acct, 'hard_signal') ?? {
          fromState: acct.state,
          toState: acct.state,
          reason: 'ban banner on terminal/ineligible state; halt and raise human task',
        }
      );
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

  /** Throttled or Cooldown -> Active after health recovers. Null otherwise. */
  recover(acct: Account): Transition | null {
    if (acct.state !== 'Throttled' && acct.state !== 'Cooldown') return null;
    this.softStreak.delete(acct.id);
    return transition(acct.state, 'recovered');
  }
}

/** Start of the next UTC day after `d`. Used as a defer target. */
export function nextDay(d: Date): Date {
  const n = new Date(d);
  n.setUTCHours(0, 0, 0, 0);
  n.setUTCDate(n.getUTCDate() + 1);
  return n;
}

/**
 * If `now` (host local time) is outside the config's working-hours window,
 * return the next window-start Date; otherwise return null (inside the window,
 * or the window is disabled). Hours are read and built in local time so the
 * comparison matches the operator's own clock. Only non-wrapping windows
 * (start < end) are honored; any other config disables the window.
 */
export function activeHoursDefer(now: Date, cfg: SafetyConfig): Date | null {
  const { activeHoursStart: start, activeHoursEnd: end } = cfg;
  if (start >= end) return null; // disabled (start === end) or invalid wrap.
  const hour = now.getHours();
  if (hour >= start && hour < end) return null; // inside the window.
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), start, 0, 0, 0);
  if (hour >= end) next.setDate(next.getDate() + 1); // past today's window -> tomorrow.
  return next;
}

/** The schedule that applies to an account: its own when set, else the global
 * config's hour window run every day. Takes only the `limits` slice so a read
 * model holding a limits blob (not a hydrated Account) can resolve the same
 * window the gate will enforce rather than re-deriving the fallback. */
export function effectiveSchedule(
  acct: Pick<Account, 'limits'>,
  cfg: SafetyConfig,
  actionType?: ActionType,
): AccountSchedule {
  return (
    (actionType ? acct.limits?.schedules?.[actionType] : undefined) ??
    acct.limits?.schedule ?? {
      hoursStart: cfg.activeHoursStart,
      hoursEnd: cfg.activeHoursEnd,
      days: DEFAULT_SCHEDULE.days,
    }
  );
}

/** Whether an operator toggle allows this action type. Missing means enabled. */
export function actionEnabled(acct: Pick<Account, 'limits'>, type: ActionType): boolean {
  return acct.limits?.enabled?.[type] ?? true;
}

/**
 * When (if ever) `now` falls outside a working schedule: the next moment the
 * account is allowed to act, or null if it may act right now. Combines the local
 * hour window with the active-weekday set. A day not in `days` is a day off; an
 * hour window with start >= end disables the hour gate (act any hour on an
 * active day). Deferrals target the start of the next active day (or today's
 * window start when we are early on an active day).
 */
export function scheduleDefer(now: Date, schedule: AccountSchedule): Date | null {
  const { hoursStart: start, hoursEnd: end, days } = schedule;
  const hourGateOn = start < end;
  const startHour = hourGateOn ? start : 0;
  const dayOn = days.includes(now.getDay());
  const hourOn = !hourGateOn || (now.getHours() >= start && now.getHours() < end);
  if (dayOn && hourOn) return null; // inside the window on an active day.

  // Walk forward to the next active day's window start that is still in the
  // future. i=0 covers "active day, before the window opens today".
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, startHour, 0, 0, 0);
    if (cand.getTime() > now.getTime() && days.includes(cand.getDay())) return cand;
  }
  // days is empty (no active day): nothing may send. Park a week out; a later
  // schedule edit re-opens it. (The UI prevents saving zero active days.)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, startHour, 0, 0, 0);
}
