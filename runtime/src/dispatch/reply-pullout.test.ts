// Reply-pullout wiring test. Uses the SAME orchestrator wiring the runtime
// composes (makeOrchestratorServices over the store, with store.sequence passed
// to the ReplyRouter). It proves that routing an inbound reply for an enrolled
// target pulls it out of the funnel mid-sequence, and the dispatch tick then
// skips it.

import { describe, expect, it } from 'vitest';
import type { SchedulerLikePort } from '@loa/orchestrator';
import { InMemoryStore } from '../store/in-memory-store.js';
import { makeOrchestratorServices } from '../adapters/orchestrator.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';
const TGT = 'tgt-1';

const noopScheduler: SchedulerLikePort = {
  async enqueueFollowUp() {
    /* no-op for this test */
  },
};

async function seedTarget(store: InMemoryStore): Promise<void> {
  await store.target.create({
    id: TGT,
    campaignId: CAMP,
    prospectRef: 'p1',
    linkedinUrn: 'urn:li:person:p1',
    externalContext: {},
    stage: 'invited',
  });
}

describe('reply pullout wiring', () => {
  it('an inbound reply pulls an enrolled target out of the funnel', async () => {
    const store = new InMemoryStore();
    await seedTarget(store);

    // Enroll the target and put it mid-sequence.
    const p = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(p.id, { currentStep: 1 });

    const orchestrator = makeOrchestratorServices(store, noopScheduler);

    // A reply of any intent should pull the target out.
    await orchestrator.replyRouter.route({ targetId: TGT, campaignId: CAMP, intent: 'Interested' });

    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('replied');
    expect(after.errorMessage).toBe('reply');

    // The cursor is no longer due, so the tick would not act on it.
    expect(await store.sequence.dueTargetProgress(new Date())).toHaveLength(0);
  });

  it('a Stop reply both suppresses and pulls out', async () => {
    const store = new InMemoryStore();
    await seedTarget(store);
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const orchestrator = makeOrchestratorServices(store, noopScheduler);
    const outcome = await orchestrator.replyRouter.route({
      targetId: TGT,
      campaignId: CAMP,
      intent: 'Stop',
    });

    expect(outcome.suppressed).toBe(true);
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('replied');
  });
});
