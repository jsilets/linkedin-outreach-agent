// StaggerAllocator unit tests: day-0 fill, working-morning overflow, seeding
// from an existing ledger, day-off collapsing, and overdue bucketing.

import type { AccountSchedule } from '@loa/shared';
import { DEFAULT_SCHEDULE } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import { dueAfterDelay } from './advance.js';
import { StaggerAllocator } from './stagger.js';

const DAY = 86_400;
// A fixed weekday base keeps day arithmetic stable: 2026-07-13 is a Monday.
const NOW = new Date(2026, 6, 13, 12, 0, 0);

describe('StaggerAllocator', () => {
  it('hands out cap nulls, then fills successive working mornings', () => {
    const a = new StaggerAllocator(NOW, 2, DEFAULT_SCHEDULE, []);
    expect(a.next()).toBeNull();
    expect(a.next()).toBeNull();
    expect(a.next()).toEqual(dueAfterDelay(NOW, DAY, DEFAULT_SCHEDULE));
    expect(a.next()).toEqual(dueAfterDelay(NOW, DAY, DEFAULT_SCHEDULE));
    expect(a.next()).toEqual(dueAfterDelay(NOW, 2 * DAY, DEFAULT_SCHEDULE));
  });

  it('seeds from an existing ledger: nulls fill today, future dates their day', () => {
    const day1 = dueAfterDelay(NOW, DAY, DEFAULT_SCHEDULE)!;
    const a = new StaggerAllocator(NOW, 2, DEFAULT_SCHEDULE, [null, null, day1]);
    // Today full, day 1 has one slot left, then day 2.
    expect(a.next()).toEqual(day1);
    expect(a.next()).toEqual(dueAfterDelay(NOW, 2 * DAY, DEFAULT_SCHEDULE));
  });

  it('never packs a day past cap when offsets collapse onto one morning (day off)', () => {
    // Wednesday (3) off: from Monday, day-2 and day-3 offsets both land on
    // Thursday. Occupancy must fill Thursday once, then move to Friday.
    const schedule: AccountSchedule = { hoursStart: 9, hoursEnd: 17, days: [0, 1, 2, 4, 5, 6] };
    const a = new StaggerAllocator(NOW, 1, schedule, []);
    expect(a.next()).toBeNull(); // Monday (today)
    expect(a.next()).toEqual(new Date(2026, 6, 14, 9, 0, 0)); // Tuesday
    expect(a.next()).toEqual(new Date(2026, 6, 16, 9, 0, 0)); // Wednesday off -> Thursday
    expect(a.next()).toEqual(new Date(2026, 6, 17, 9, 0, 0)); // Friday, NOT Thursday again
  });

  it('counts an overdue scheduled entry against today, not its stale date', () => {
    const overdue = new Date(NOW.getTime() - DAY);
    const a = new StaggerAllocator(NOW, 2, DEFAULT_SCHEDULE, [overdue]);
    expect(a.next()).toBeNull(); // one of today's two slots is left
    expect(a.next()).toEqual(dueAfterDelay(NOW, DAY, DEFAULT_SCHEDULE));
  });
});
