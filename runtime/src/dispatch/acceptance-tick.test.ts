// Acceptance-tick unit tests. They exercise the tick against the in-memory store
// with a fake connections reader (the one live seam the tick cannot run offline).
//
// Covered: a parked enrollment whose target now appears in the connections list
// is set 'connected' and released to the next step with nextStepAt clocked from
// acceptance; an unmatched parked enrollment stays parked.

import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { StaticConnectionsReader } from '../adapters/observe-live.js';
import { AcceptanceTick } from './acceptance-tick.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';
const TGT = 'tgt-1';

/** Enroll a target and park its cursor after a connect step (the state the
 * dispatch tick leaves it in), with steps [connect, delay(60), message]. */
async function seedParked(store: InMemoryStore): Promise<string> {
  await store.target.create({
    id: TGT,
    campaignId: CAMP,
    prospectRef: 'p1',
    linkedinUrn: 'urn:li:person:p1',
    externalContext: {},
    stage: 'invited',
  });
  await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect' });
  await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'delay', delaySeconds: 60 });
  await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 2, stepType: 'message', body: 'hi' });
  const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
  await store.sequence.advanceTargetProgress(prog.id, {
    state: 'awaiting_connection',
    nextStepAt: null,
  });
  return prog.id;
}

describe('AcceptanceTick', () => {
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    await seedParked(store);
  });

  it('releases a parked enrollment once its target appears in the connections', async () => {
    const tick = new AcceptanceTick({
      connections: new StaticConnectionsReader([{ entityUrn: 'urn:li:person:p1' }]),
      sequence: store.sequence,
      targets: store.target,
    });

    const now = new Date('2026-07-06T12:00:00Z');
    const res = await tick.runTick(now);

    expect(res.accounts).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ kind: 'connected', targetId: TGT, nextStep: 1 });

    // Target moved to connected.
    const target = await store.target.findById(TGT);
    expect(target?.stage).toBe('connected');

    // Cursor released to the step after connect, with the delay clock starting
    // at acceptance (now + delay's delaySeconds).
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('in_progress');
    expect(progress.currentStep).toBe(1);
    expect(progress.nextStepAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('leaves a parked enrollment alone when its target has not accepted', async () => {
    const tick = new AcceptanceTick({
      connections: new StaticConnectionsReader([{ entityUrn: 'urn:li:person:stranger' }]),
      sequence: store.sequence,
      targets: store.target,
    });

    const res = await tick.runTick(new Date());

    expect(res.outcomes[0]).toMatchObject({ kind: 'still_waiting' });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('awaiting_connection');
    expect(progress.currentStep).toBe(0); // still parked on connect
    const target = await store.target.findById(TGT);
    expect(target?.stage).toBe('invited'); // unchanged
  });

  it('completes the enrollment when the connect step was the last step', async () => {
    // A connect-only campaign: acceptance has no next step to run.
    const store2 = new InMemoryStore();
    await store2.target.create({
      id: TGT,
      campaignId: CAMP,
      prospectRef: 'p1',
      linkedinUrn: 'urn:li:person:p1',
      externalContext: {},
      stage: 'invited',
    });
    await store2.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect' });
    const prog = await store2.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store2.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_connection', nextStepAt: null });

    const tick = new AcceptanceTick({
      connections: new StaticConnectionsReader([{ entityUrn: 'urn:li:person:p1' }]),
      sequence: store2.sequence,
      targets: store2.target,
    });

    const res = await tick.runTick(new Date());

    expect(res.outcomes[0]).toMatchObject({ kind: 'completed', targetId: TGT });
    const [progress] = await store2.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('completed');
  });
});
