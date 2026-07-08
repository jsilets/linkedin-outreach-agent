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
};
