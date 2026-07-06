import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { advanceAfterStep } from './advance.js';

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
