// Cursor-advance rule, shared by the dispatch tick and the post-approval resume
// so both move a target through its sequence identically.
//
// Given the enabled steps and the index just handled, produce the patch that
// moves the cursor onto the next step (gated behind that step's own
// delaySeconds), or completes the enrollment when the handled step was last.

import type { AccountSchedule, db as shared } from '@loa/shared';
import { DEFAULT_SCHEDULE } from '@loa/shared';
import type { TargetProgressPatch } from '../store/index.js';

type CampaignStepRow = shared.CampaignStepRow;

const DAY_SECONDS = 86_400;

/**
 * When a delayed step should become due. A DAY-LEVEL delay (>= 1 day) is meant
 * as "N days later, the next morning" — not exactly N*24h from the clock minute
 * the previous step ran. So it lands on the working-window START of the target
 * calendar day, skipping days off. Accepting a connection Wed 3pm with a +1d
 * step therefore sends Thu ~8am, not Thu 3pm. Sub-day delays are left exact (the
 * gate still defers them out of any closed window).
 */
export function dueAfterDelay(
  handledAt: Date,
  delaySeconds: number,
  schedule: AccountSchedule,
): Date | null {
  if (delaySeconds <= 0) return null; // due immediately
  const raw = new Date(handledAt.getTime() + delaySeconds * 1000);
  if (delaySeconds < DAY_SECONDS) return raw; // sub-day: keep exact, gate handles hours
  // Day-level: snap to the target day's window start, then to the next active day.
  let d = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate(), schedule.hoursStart, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (schedule.days.includes(d.getDay())) return d;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, schedule.hoursStart, 0, 0, 0);
  }
  return d; // days empty (shouldn't happen): fall through with the last candidate
}

export function advanceAfterStep(
  steps: CampaignStepRow[],
  handledIdx: number,
  now: Date,
  schedule: AccountSchedule = DEFAULT_SCHEDULE,
): TargetProgressPatch {
  const nextIdx = handledIdx + 1;
  if (nextIdx >= steps.length) {
    return {
      currentStep: nextIdx,
      state: 'completed',
      nextStepAt: null,
      lastStepAt: now,
      errorMessage: null,
    };
  }
  const nextStep = steps[nextIdx]!;
  return {
    currentStep: nextIdx,
    // Back to in_progress: covers resuming a cursor parked in awaiting_approval.
    state: 'in_progress',
    nextStepAt: dueAfterDelay(now, nextStep.delaySeconds, schedule),
    lastStepAt: now,
    errorMessage: null,
  };
}
