// PacingScheduler: decides WHEN queued actions run. It layers working-hours
// windows, randomized inter-action jitter, and per-action dedup on top of the
// SafetyPort's budget/canAct decisions. Pure: pass `now` in, inject an RNG.

import type { Account, Action } from '@loa/shared';

import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from './config.js';
import { type Rng, type SafetyPort, seededRng } from './ports.js';
import { isWithinWorkingHours, nextWorkingInstant } from './working-hours.js';

export interface SchedulerOptions {
  config?: SchedulerConfig;
  /** Deterministic RNG for jitter. Defaults to a fixed seed for reproducibility. */
  rng?: Rng;
}

/** Why a queued action was not selected, for observability/testing. */
export type SkipReason =
  | 'outside_working_hours'
  | 'not_due_yet'
  | 'duplicate'
  | 'denied'
  | 'deferred'
  | 'budget_exhausted';

export interface DueResult {
  due: Action[];
  skipped: Array<{ action: Action; reason: SkipReason }>;
}

export class PacingScheduler {
  private readonly cfg: SchedulerConfig;
  private readonly rng: Rng;

  constructor(
    private readonly safety: SafetyPort,
    opts: SchedulerOptions = {},
  ) {
    this.cfg = opts.config ?? DEFAULT_SCHEDULER_CONFIG;
    this.rng = opts.rng ?? seededRng(0x1234_5678);
  }

  /** Randomized gap in milliseconds within [minGapSeconds, maxGapSeconds]. */
  private jitterMs(): number {
    const { minGapSeconds, maxGapSeconds } = this.cfg;
    const span = Math.max(0, maxGapSeconds - minGapSeconds);
    const secs = minGapSeconds + this.rng() * span;
    return Math.round(secs * 1000);
  }

  /**
   * Earliest time an action may run: the later of its own scheduledAt and
   * `now`, clamped into the next working window, then nudged forward by a
   * jitter gap so consecutive actions do not fire simultaneously.
   */
  nextRunAt(action: Action, now: Date): Date {
    const earliest = action.scheduledAt > now ? action.scheduledAt : now;
    const inWindow = nextWorkingInstant(earliest, this.cfg.working);
    const jittered = new Date(inWindow.getTime() + this.jitterMs());
    // Jitter can push us past the window edge; re-clamp.
    return nextWorkingInstant(jittered, this.cfg.working);
  }

  /**
   * Select the queued actions that should run at `now` for one account.
   * Respects: working hours, per-action scheduledAt, per-dedupKey uniqueness,
   * and the SafetyPort's canAct decision (which enforces budget, state, and
   * the weekly invite ceiling). Also enforces the daily cap locally by
   * counting selections against the account's remaining budget so a single
   * batch cannot blow the cap.
   */
  dueActions(account: Account, queue: Action[], now: Date): DueResult {
    const due: Action[] = [];
    const skipped: DueResult['skipped'] = [];

    if (!isWithinWorkingHours(now, this.cfg.working)) {
      for (const action of queue) skipped.push({ action, reason: 'outside_working_hours' });
      return { due, skipped };
    }

    const budget = this.safety.budget(account);
    // Track how many of each type we have already selected in this batch so we
    // never exceed remaining headroom (cap - used) within a single tick.
    const selectedByType = new Map<string, number>();
    const seenDedup = new Set<string>();

    // Deterministic order: earliest-scheduled first, then by id for stability.
    const ordered = [...queue].sort((a, b) => {
      const t = a.scheduledAt.getTime() - b.scheduledAt.getTime();
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });

    for (const action of ordered) {
      if (seenDedup.has(action.dedupKey)) {
        skipped.push({ action, reason: 'duplicate' });
        continue;
      }

      if (action.scheduledAt > now) {
        skipped.push({ action, reason: 'not_due_yet' });
        continue;
      }

      const cap = budget.caps[action.type];
      const used = budget.used[action.type] ?? 0;
      const alreadySelected = selectedByType.get(action.type) ?? 0;
      if (used + alreadySelected >= cap) {
        skipped.push({ action, reason: 'budget_exhausted' });
        continue;
      }

      const decision = this.safety.canAct(account, action);
      if (decision.kind === 'deny') {
        skipped.push({ action, reason: 'denied' });
        continue;
      }
      if (decision.kind === 'defer') {
        skipped.push({ action, reason: 'deferred' });
        continue;
      }

      due.push(action);
      seenDedup.add(action.dedupKey);
      selectedByType.set(action.type, alreadySelected + 1);
    }

    return { due, skipped };
  }
}
