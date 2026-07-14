// Day-aware slot allocator for enrollment staggering, shared by the enrollment
// path (CampaignAdapter.enrollTargets) and the backlog re-stagger script so
// both place cursors identically.
//
// A naive `slot = futureCount + index` restarts counting below the slots the
// existing future cursors already occupy (they start at slot `cap`, not 0), so
// a second batch would double-book the first future day. It also double-books
// calendar days around days off, where consecutive day offsets collapse onto
// the same working morning. This allocator instead keeps per-calendar-day
// occupancy and hands out the earliest day with room, so no assignment ever
// pushes a day past the cap it was built with.

import type { AccountSchedule } from '@loa/shared';
import { dueAfterDelay } from './advance.js';

const DAY_SECONDS = 86_400;

/** Local calendar-day bucket key (dueAfterDelay snaps in local time). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export class StaggerAllocator {
  private readonly occupancy = new Map<string, number>();

  /**
   * `existing` is the ledger of first-step due times already committed for
   * this campaign (nextStepAt of in_progress cursors still sitting at the
   * first step): null and due-or-overdue entries count against today, future
   * entries against their own calendar day. Counting is deliberately
   * conservative — an entry that in fact will not fire (or fires under a
   * different account's cap) only pushes new work later, never over a day's
   * cap. Enforcement stays with the safety gate.
   */
  constructor(
    private readonly now: Date,
    private readonly cap: number,
    private readonly schedule: AccountSchedule,
    existing: Array<Date | null>,
  ) {
    for (const at of existing) this.bump(at !== null && at > now ? at : now);
  }

  private bump(day: Date): void {
    const key = dayKey(day);
    this.occupancy.set(key, (this.occupancy.get(key) ?? 0) + 1);
  }

  /**
   * Claim the next free slot: the earliest working day whose occupancy is
   * below the cap. Day 0 yields null (due immediately, today's budget); later
   * days yield the working-window start via dueAfterDelay, skipping days off.
   */
  next(): Date | null {
    for (let day = 0; ; day += 1) {
      // Around days off consecutive offsets collapse onto one morning; the
      // occupancy check makes the loop walk past a filled date either way.
      const at = day === 0 ? null : dueAfterDelay(this.now, day * DAY_SECONDS, this.schedule);
      const key = dayKey(at ?? this.now);
      if ((this.occupancy.get(key) ?? 0) < this.cap) {
        this.bump(at ?? this.now);
        return at;
      }
    }
  }
}
