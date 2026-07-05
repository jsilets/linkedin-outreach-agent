// Scheduler configuration. Working-hours window, jitter gaps, and daily spread.

/** A working-hours window in the account's local timezone. */
export interface WorkingHours {
  /** IANA timezone id, e.g. "America/Chicago". */
  timezone: string;
  /** Inclusive start hour, 0-23. Sends allowed from startHour:00. */
  startHour: number;
  /** Exclusive end hour, 0-23. No sends at or after endHour:00. */
  endHour: number;
  /** Days of week that are working days. 0=Sunday .. 6=Saturday. */
  workingDays: number[];
}

export interface SchedulerConfig {
  working: WorkingHours;
  /** Minimum gap between two consecutive actions, in seconds. */
  minGapSeconds: number;
  /** Maximum gap between two consecutive actions, in seconds. */
  maxGapSeconds: number;
}

// Default: weekdays 09:00-18:00, 8-20s between actions. The wide max gap plus
// working-hours clamp spreads a day's cap across the window rather than firing
// it in one burst.
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  working: {
    timezone: 'UTC',
    startHour: 9,
    endHour: 18,
    workingDays: [1, 2, 3, 4, 5], // Mon-Fri
  },
  minGapSeconds: 8,
  maxGapSeconds: 20,
};
