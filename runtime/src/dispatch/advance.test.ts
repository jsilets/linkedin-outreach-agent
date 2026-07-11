import { describe, expect, it } from 'vitest';
import type { AccountSchedule } from '@loa/shared';
import { InMemoryStore } from '../store/in-memory-store.js';
import { advanceAfterStep, dueAfterDelay } from './advance.js';

const CAMP = 'camp-1';

describe('advanceAfterStep', () => {
  it('moves to the next step and gates it behind that step delay', async () => {
    const store = new InMemoryStore();
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'message', body: 'b', delaySeconds: 120 });
    const steps = await store.sequence.listCampaignSteps(CAMP);

    const now = new Date('2026-07-06T12:00:00Z');
    const patch = advanceAfterStep(steps, 0, now);

    expect(patch.currentStep).toBe(1);
    expect(patch.state).toBe('in_progress');
    expect(patch.nextStepAt?.getTime()).toBe(now.getTime() + 120_000);
  });

  it('leaves nextStepAt null when the next step has no delay', async () => {
    const store = new InMemoryStore();
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'view_profile' });
    const steps = await store.sequence.listCampaignSteps(CAMP);

    const patch = advanceAfterStep(steps, 0, new Date());
    expect(patch.currentStep).toBe(1);
    expect(patch.nextStepAt).toBeNull();
  });

  it('completes when the handled step was the last', async () => {
    const store = new InMemoryStore();
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'view_profile' });
    const steps = await store.sequence.listCampaignSteps(CAMP);

    const patch = advanceAfterStep(steps, 0, new Date());
    expect(patch.state).toBe('completed');
    expect(patch.nextStepAt).toBeNull();
    expect(patch.currentStep).toBe(1);
  });
});

describe('dueAfterDelay (day-aligned to the next working morning)', () => {
  const DAY = 86_400;
  // Saturday off, everything else on; 8am-8pm. 2026-07-06 is a Monday.
  const satOff: AccountSchedule = { hoursStart: 8, hoursEnd: 20, days: [0, 1, 2, 3, 4, 5] };

  it('a +1d step from Wed 3pm sends Thu ~8am, not exactly 24h later', () => {
    const wed3pm = new Date(2026, 6, 8, 15, 0, 0); // Wed Jul 8, 3pm local
    const due = dueAfterDelay(wed3pm, DAY, satOff)!;
    expect(due.getDate()).toBe(9); // Thursday
    expect(due.getHours()).toBe(8); // window start, not 3pm
  });

  it('skips a day off: a +1d step from Friday lands Monday morning', () => {
    const fri3pm = new Date(2026, 6, 10, 15, 0, 0); // Fri Jul 10 → +1d = Sat (off)
    const due = dueAfterDelay(fri3pm, DAY, satOff)!;
    expect(due.getDay()).toBe(0); // Sunday (0 is active in satOff)
    expect(due.getDate()).toBe(12);
    expect(due.getHours()).toBe(8);
  });

  it('leaves a sub-day delay exact (the gate handles the hour window)', () => {
    const now = new Date(2026, 6, 8, 15, 0, 0);
    const due = dueAfterDelay(now, 2 * 3600, satOff)!; // 2 hours
    expect(due.getTime()).toBe(now.getTime() + 2 * 3600 * 1000);
  });

  it('returns null for a zero delay (due immediately)', () => {
    expect(dueAfterDelay(new Date(), 0, satOff)).toBeNull();
  });
});
