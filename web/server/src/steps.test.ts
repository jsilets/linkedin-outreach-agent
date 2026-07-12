import { describe, expect, it } from 'vitest';
import { normalizeSteps, StepValidationError } from './steps.js';

describe('normalizeSteps', () => {
  it('assigns contiguous stepOrder from array position (reorder)', () => {
    const out = normalizeSteps([
      { stepType: 'connect' },
      { stepType: 'delay', delaySeconds: 172800 },
      { stepType: 'message', body: 'hi' },
    ]);
    expect(out.map((s) => s.stepOrder)).toEqual([0, 1, 2]);
    expect(out.map((s) => s.stepType)).toEqual(['connect', 'delay', 'message']);
  });

  it('defaults optional fields', () => {
    const [step] = normalizeSteps([{ stepType: 'view_profile' }]);
    expect(step).toMatchObject({
      delaySeconds: 0,
      note: null,
      body: null,
      reaction: null,
      enabled: true,
    });
  });

  it('coerces empty strings to null and keeps content', () => {
    const [step] = normalizeSteps([{ stepType: 'message', body: '', note: 'keep' }]);
    expect(step?.body).toBeNull();
    expect(step?.note).toBe('keep');
  });

  it('rejects an unknown step type', () => {
    expect(() => normalizeSteps([{ stepType: 'like' }])).toThrow(StepValidationError);
  });

  it('rejects a delay step with no delaySeconds', () => {
    expect(() => normalizeSteps([{ stepType: 'delay' }])).toThrow(/delay/);
    expect(() => normalizeSteps([{ stepType: 'delay', delaySeconds: 0 }])).toThrow(
      StepValidationError,
    );
  });

  it('allows non-delay steps to carry a delay before them', () => {
    const [step] = normalizeSteps([{ stepType: 'message', delaySeconds: 3600, body: 'x' }]);
    expect(step?.delaySeconds).toBe(3600);
  });

  it('rejects a negative delay', () => {
    expect(() => normalizeSteps([{ stepType: 'connect', delaySeconds: -5 }])).toThrow(
      StepValidationError,
    );
  });

  it('rejects a non-array payload', () => {
    expect(() => normalizeSteps({ stepType: 'connect' })).toThrow(StepValidationError);
  });
});
