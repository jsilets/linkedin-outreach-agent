// Cursor-advance rule, shared by the dispatch tick and the post-approval resume
// so both move a target through its sequence identically.
//
// Given the enabled steps and the index just handled, produce the patch that
// moves the cursor onto the next step (gated behind that step's own
// delaySeconds), or completes the enrollment when the handled step was last.

import type { db as shared } from '@loa/shared';
import type { TargetProgressPatch } from '../store/index.js';

type CampaignStepRow = shared.CampaignStepRow;

export function advanceAfterStep(
  steps: CampaignStepRow[],
  handledIdx: number,
  now: Date,
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
    nextStepAt:
      nextStep.delaySeconds > 0 ? new Date(now.getTime() + nextStep.delaySeconds * 1000) : null,
    lastStepAt: now,
    errorMessage: null,
  };
}
