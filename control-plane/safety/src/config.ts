// Safety configuration. All tunable numbers live here so the caps and
// thresholds can be adjusted in one place without touching gate logic.

import type { ActionType } from '@loa/shared';

/** Per-action-type daily caps for a given account state. */
export type CapTable = Record<ActionType, number>;

function caps(partial: Partial<CapTable>): CapTable {
  return {
    connect: 0,
    message: 0,
    view_profile: 0,
    follow: 0,
    withdraw_invite: 0,
    react: 0,
    ...partial,
  };
}

export interface SafetyConfig {
  /** Steady-state caps for an Active account. */
  active: CapTable;
  /**
   * Multiplier applied to the current caps when an account is Throttled.
   * 0.5 means budgets are halved.
   */
  throttleMultiplier: number;
  /** Rolling invite ceiling across a 7-day window. LinkedIn's ~100/week. */
  weeklyInviteCeiling: number;
  /**
   * Acceptance-rate floor. Below this, low_acceptance is treated as a
   * ban-risk signal that throttles and tightens rather than a benign dip.
   */
  acceptanceRateFloor: number;
  /**
   * Number of consecutive soft signals (while already Throttled) that
   * escalate an account into Cooldown.
   */
  softSignalCooldownThreshold: number;
  /**
   * Minimum gap between any two outbound actions on one account, in ms. The
   * daily caps and the weekly ceiling bound totals; this bounds spacing so
   * activity looks human, not a burst of back-to-back sends.
   */
  minActionGapMs: number;
  /**
   * Extra random spread added on top of minActionGapMs, in ms. The effective
   * gap for each action is minActionGapMs + rand(0, actionGapJitterMs), so a
   * fixed cadence never emerges.
   */
  actionGapJitterMs: number;
  /**
   * Local-time hour window [activeHoursStart, activeHoursEnd) during which
   * outbound actions may run, on a 24h clock in the HOST's local timezone. The
   * account runs from the operator's own IP, so host-local hours match the
   * account's plausible working hours. Outside the window the gate defers to
   * the next window start, so a self-running engine does not send overnight.
   * Set activeHoursStart === activeHoursEnd to disable the window (act any
   * hour). Only non-wrapping windows are supported (start < end).
   */
  activeHoursStart: number; // 0-23
  activeHoursEnd: number; // 1-24
}

// Steady-state daily caps for an Active account:
//   connect 20, message 20, view_profile 60, follow 15.
// view_profile/follow are set at the top of their documented ranges since
// they are the lowest-risk actions. There is no warmup ramp: an established
// account operates at these caps from the start, bounded by the weekly invite
// ceiling and the per-action pacing gap below.
export const DEFAULT_CONFIG: SafetyConfig = {
  active: caps({
    connect: 20,
    message: 20,
    view_profile: 60,
    follow: 15,
    withdraw_invite: 10,
    react: 30,
  }),
  throttleMultiplier: 0.5,
  weeklyInviteCeiling: 100,
  acceptanceRateFloor: 0.35,
  softSignalCooldownThreshold: 2,
  // 4 min floor + up to 6 min jitter => a 4-10 min gap between any two actions.
  minActionGapMs: 240_000,
  actionGapJitterMs: 360_000,
  // Send only during local working hours, 8am-8pm; defer anything else to 8am.
  activeHoursStart: 8,
  activeHoursEnd: 20,
};
