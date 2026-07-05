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
  /** Warmup caps keyed by week (1..4). Week 4 equals steady state. */
  warmupByWeek: Record<1 | 2 | 3 | 4, CapTable>;
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
  /** Length of the warmup ramp in days before an account may go Active. */
  warmupRampDays: number;
}

// Caps follow the architecture's safety model:
//   Warming: connect 5-15, message 5-15, view_profile 15-25, follow 3-10
//            (ramped by warmup week; week 1 is organic-only).
//   Active:  connect 20, message 20, view_profile 40-60, follow 15.
// view_profile/follow are set at the top of their documented ranges since
// they are the lowest-risk actions.
export const DEFAULT_CONFIG: SafetyConfig = {
  active: caps({
    connect: 20,
    message: 20,
    view_profile: 60,
    follow: 15,
    withdraw_invite: 10,
    react: 30,
  }),
  warmupByWeek: {
    // Week 1: organic only. No connects, no messages.
    1: caps({
      connect: 0,
      message: 0,
      view_profile: 15,
      follow: 3,
      react: 10,
    }),
    // Week 2: 5-10 connects/day, no note (messages still off).
    2: caps({
      connect: 10,
      message: 0,
      view_profile: 20,
      follow: 6,
      react: 15,
    }),
    // Week 3: 10-15 connects/day with notes (messages allowed).
    3: caps({
      connect: 15,
      message: 10,
      view_profile: 25,
      follow: 10,
      withdraw_invite: 5,
      react: 20,
    }),
    // Week 4+: ramp to steady state; account becomes eligible for Active.
    4: caps({
      connect: 20,
      message: 20,
      view_profile: 40,
      follow: 15,
      withdraw_invite: 10,
      react: 30,
    }),
  },
  throttleMultiplier: 0.5,
  weeklyInviteCeiling: 100,
  acceptanceRateFloor: 0.35,
  softSignalCooldownThreshold: 2,
  warmupRampDays: 28,
};
