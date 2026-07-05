// Working-hours math. Uses Intl to read the wall-clock hour and weekday in
// the account's timezone, so windows are expressed in local time without
// pulling in a date library.

import type { WorkingHours } from './config.js';

interface LocalParts {
  hour: number;
  /** 0=Sunday .. 6=Saturday */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock hour and weekday for `at` in the given timezone. */
export function localParts(at: Date, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  let hour = 0;
  let weekday = 0;
  for (const part of fmt.formatToParts(at)) {
    if (part.type === 'hour') {
      // Intl can emit "24" for midnight under hour12:false; normalize to 0.
      hour = parseInt(part.value, 10) % 24;
    } else if (part.type === 'weekday') {
      weekday = WEEKDAY_INDEX[part.value] ?? 0;
    }
  }
  return { hour, weekday };
}

/** True if `at` falls inside the working window (day and hour). */
export function isWithinWorkingHours(at: Date, w: WorkingHours): boolean {
  const { hour, weekday } = localParts(at, w.timezone);
  if (!w.workingDays.includes(weekday)) return false;
  return hour >= w.startHour && hour < w.endHour;
}

/**
 * The next instant at or after `from` that is inside the working window.
 * If `from` is already inside, returns `from` unchanged. Otherwise advances
 * to the next working day's start hour. Steps in whole hours, which is
 * precise enough for scheduling and avoids per-timezone DST arithmetic.
 */
export function nextWorkingInstant(from: Date, w: WorkingHours): Date {
  let cursor = new Date(from);
  // Cap the search so a misconfigured window (e.g. no working days) can't loop
  // forever. 24*14 hourly steps covers two weeks.
  for (let i = 0; i < 24 * 14; i++) {
    if (isWithinWorkingHours(cursor, w)) return cursor;
    const { hour, weekday } = localParts(cursor, w.timezone);
    const isWorkingDay = w.workingDays.includes(weekday);
    if (isWorkingDay && hour < w.startHour) {
      // Before the window today: jump forward to the start hour.
      cursor = new Date(cursor.getTime() + (w.startHour - hour) * 3600_000);
    } else {
      // After the window or a non-working day: advance an hour and retry.
      cursor = new Date(cursor.getTime() + 3600_000);
    }
  }
  return cursor;
}
