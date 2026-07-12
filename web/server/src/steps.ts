// Validation and normalization for the campaign flow (the ordered step list).
// Kept free of DB imports so it can be unit-tested on its own.
import { CAMPAIGN_STEP_TYPES, type CampaignStepType } from '@loa/shared';

interface StepInput {
  stepType: string;
  delaySeconds?: number | null;
  note?: string | null;
  body?: string | null;
  reaction?: string | null;
  enabled?: boolean;
}

export interface NormalizedStep {
  stepOrder: number;
  stepType: CampaignStepType;
  delaySeconds: number;
  note: string | null;
  body: string | null;
  reaction: string | null;
  enabled: boolean;
}

export class StepValidationError extends Error {}

// Takes the client's step list (order implied by array position) and returns
// rows ready to insert, or throws StepValidationError with a readable message.
export function normalizeSteps(input: unknown): NormalizedStep[] {
  if (!Array.isArray(input)) {
    throw new StepValidationError('Expected an array of steps.');
  }
  return input.map((raw, i) => normalizeStep(raw, i));
}

function normalizeStep(raw: unknown, index: number): NormalizedStep {
  if (typeof raw !== 'object' || raw === null) {
    throw new StepValidationError(`Step ${index + 1} is not an object.`);
  }
  const step = raw as StepInput;
  const stepType = step.stepType;
  if (!CAMPAIGN_STEP_TYPES.includes(stepType as CampaignStepType)) {
    throw new StepValidationError(
      `Step ${index + 1} has an unknown type "${stepType}". ` +
        `Allowed: ${CAMPAIGN_STEP_TYPES.join(', ')}.`,
    );
  }
  const delaySeconds =
    step.delaySeconds === undefined || step.delaySeconds === null
      ? 0
      : Number(step.delaySeconds);
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new StepValidationError(`Step ${index + 1} has an invalid delaySeconds.`);
  }
  if (stepType === 'delay' && delaySeconds <= 0) {
    throw new StepValidationError(`Step ${index + 1} is a delay but has no delaySeconds > 0.`);
  }
  return {
    stepOrder: index,
    stepType: stepType as CampaignStepType,
    delaySeconds,
    note: nullableString(step.note),
    body: nullableString(step.body),
    reaction: nullableString(step.reaction),
    enabled: step.enabled === undefined ? true : Boolean(step.enabled),
  };
}

function nullableString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}
