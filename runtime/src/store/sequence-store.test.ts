// Sequence-store unit tests against the in-memory implementation. Cover the
// step-template CRUD + reorder, idempotent enrollment, the due query, cursor
// advance, the reply pullout, and the count/volume aggregates.

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';

describe('InMemoryStore sequence surface', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('upserts, lists (ordered), updates, and deletes campaign steps', async () => {
    const a = await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'message',
      body: 'hi',
    });
    const b = await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'n',
    });

    let steps = await store.sequence.listCampaignSteps(CAMP);
    expect(steps.map((s) => s.stepType)).toEqual(['connect', 'message']); // ordered by stepOrder

    // Update in place by id.
    const updated = await store.sequence.upsertCampaignStep({ ...a, body: 'hello' });
    expect(updated.id).toBe(a.id);
    expect(updated.body).toBe('hello');

    await store.sequence.deleteCampaignStep(b.id);
    steps = await store.sequence.listCampaignSteps(CAMP);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe(a.id);
  });

  it('reorders steps by id', async () => {
    const s0 = await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
    });
    const s1 = await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'view_profile',
    });
    const s2 = await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 2,
      stepType: 'message',
      body: 'b',
    });

    await store.sequence.reorderCampaignSteps(CAMP, [s2.id, s0.id, s1.id]);
    const steps = await store.sequence.listCampaignSteps(CAMP);
    expect(steps.map((s) => s.id)).toEqual([s2.id, s0.id, s1.id]);
    expect(steps.map((s) => s.stepOrder)).toEqual([0, 1, 2]);
  });

  it('enrollTarget is idempotent on targetId', async () => {
    const first = await store.sequence.enrollTarget(CAMP, 'tgt-1', ACCT);
    const second = await store.sequence.enrollTarget(CAMP, 'tgt-1', ACCT);
    expect(second.id).toBe(first.id);
    const all = await store.sequence.listTargetProgress(CAMP);
    expect(all).toHaveLength(1);
    expect(first.state).toBe('in_progress');
    expect(first.currentStep).toBe(0);
  });

  it('dueTargetProgress selects in_progress rows with null or past nextStepAt', async () => {
    const now = new Date('2026-07-06T12:00:00Z');
    const p = await store.sequence.enrollTarget(CAMP, 'tgt-1', ACCT); // nextStepAt null -> due
    expect(await store.sequence.dueTargetProgress(now)).toHaveLength(1);

    // Push it into the future -> not due.
    await store.sequence.advanceTargetProgress(p.id, {
      nextStepAt: new Date(now.getTime() + 60_000),
    });
    expect(await store.sequence.dueTargetProgress(now)).toHaveLength(0);
    // At/after the time -> due again.
    expect(await store.sequence.dueTargetProgress(new Date(now.getTime() + 60_000))).toHaveLength(
      1,
    );

    // Completed rows are never due.
    await store.sequence.advanceTargetProgress(p.id, { state: 'completed', nextStepAt: null });
    expect(await store.sequence.dueTargetProgress(new Date(now.getTime() + 120_000))).toHaveLength(
      0,
    );
  });

  it('pullTargetFromFunnel moves an active cursor to terminal replied', async () => {
    const p = await store.sequence.enrollTarget(CAMP, 'tgt-1', ACCT);
    await store.sequence.pullTargetFromFunnel('tgt-1', 'reply');

    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.id).toBe(p.id);
    expect(after.state).toBe('replied');
    expect(after.nextStepAt).toBeNull();
    expect(after.errorMessage).toBe('reply');
    // No longer due.
    expect(await store.sequence.dueTargetProgress(new Date())).toHaveLength(0);
  });

  it('pullTargetFromFunnel is a no-op for an unenrolled target', async () => {
    await store.sequence.pullTargetFromFunnel('nobody', 'reply');
    expect(await store.sequence.listTargetProgress(CAMP)).toHaveLength(0);
  });

  it("pullTargetFromFunnel cancels the target's undelivered outbound messages", async () => {
    await store.sequence.enrollTarget(CAMP, 'tgt-1', ACCT);
    const draft = await store.message.create({
      accountId: ACCT,
      targetId: 'tgt-1',
      direction: 'outbound',
      body: 'd',
      threadRef: 't',
      status: 'draft',
    });
    const approved = await store.message.create({
      accountId: ACCT,
      targetId: 'tgt-1',
      direction: 'outbound',
      body: 'a',
      threadRef: 't',
      status: 'approved',
    });
    const sent = await store.message.create({
      accountId: ACCT,
      targetId: 'tgt-1',
      direction: 'outbound',
      body: 's',
      threadRef: 't',
      status: 'sent',
    });
    const inbound = await store.message.create({
      accountId: ACCT,
      targetId: 'tgt-1',
      direction: 'inbound',
      body: 'i',
      threadRef: 't',
      status: 'draft',
    });
    const other = await store.message.create({
      accountId: ACCT,
      targetId: 'tgt-2',
      direction: 'outbound',
      body: 'o',
      threadRef: 't2',
      status: 'draft',
    });

    await store.sequence.pullTargetFromFunnel('tgt-1', 'reply');

    expect((await store.message.findById(draft.id))!.status).toBe('cancelled');
    expect((await store.message.findById(approved.id))!.status).toBe('cancelled');
    expect((await store.message.findById(sent.id))!.status).toBe('sent'); // already delivered
    expect((await store.message.findById(inbound.id))!.status).toBe('draft'); // inbound untouched
    expect((await store.message.findById(other.id))!.status).toBe('draft'); // another target untouched
  });

  it('activeEnrollments returns live cursors (including awaiting_approval) and drops terminal ones', async () => {
    const inProg = await store.sequence.enrollTarget(CAMP, 'tgt-a', ACCT);
    const parked = await store.sequence.enrollTarget(CAMP, 'tgt-b', ACCT);
    await store.sequence.advanceTargetProgress(parked.id, { state: 'awaiting_approval' });
    const awaitingConn = await store.sequence.enrollTarget(CAMP, 'tgt-c', ACCT);
    await store.sequence.advanceTargetProgress(awaitingConn.id, { state: 'awaiting_connection' });
    const done = await store.sequence.enrollTarget(CAMP, 'tgt-d', ACCT);
    await store.sequence.advanceTargetProgress(done.id, { state: 'completed' });
    const replied = await store.sequence.enrollTarget(CAMP, 'tgt-e', ACCT);
    await store.sequence.advanceTargetProgress(replied.id, { state: 'replied' });

    const active = await store.sequence.activeEnrollments();
    expect(active.map((p) => p.id).sort()).toEqual([inProg.id, parked.id, awaitingConn.id].sort());
  });

  it('campaignCounts aggregates target stages and progress states', async () => {
    await store.target.create({
      campaignId: CAMP,
      prospectRef: 'a',
      linkedinUrn: 'u:a',
      externalContext: {},
      stage: 'sourced',
    });
    await store.target.create({
      campaignId: CAMP,
      prospectRef: 'b',
      linkedinUrn: 'u:b',
      externalContext: {},
      stage: 'invited',
    });
    await store.sequence.enrollTarget(CAMP, 'tgt-x', ACCT);

    const counts = await store.sequence.campaignCounts(CAMP);
    expect(counts.targets).toBe(2);
    expect(counts.byStage).toEqual({ sourced: 1, invited: 1 });
    expect(counts.byProgressState).toEqual({ in_progress: 1 });
  });

  it('actionVolume buckets recent actions by date and type', async () => {
    const today = new Date();
    await store.action.create({
      accountId: ACCT,
      targetId: 't',
      campaignId: CAMP,
      type: 'connect',
      scheduledAt: today,
      executedAt: today,
      result: 'success',
      dedupKey: 'd1',
    });
    await store.action.create({
      accountId: ACCT,
      targetId: 't',
      campaignId: CAMP,
      type: 'connect',
      scheduledAt: today,
      executedAt: today,
      result: 'success',
      dedupKey: 'd2',
    });
    // An old action outside the window is excluded.
    const old = new Date(today.getTime() - 40 * 24 * 60 * 60 * 1000);
    await store.action.create({
      accountId: ACCT,
      targetId: 't',
      campaignId: CAMP,
      type: 'message',
      scheduledAt: old,
      executedAt: old,
      result: 'success',
      dedupKey: 'd3',
    });

    const vol = await store.sequence.actionVolume(ACCT, 7);
    expect(vol).toHaveLength(1);
    expect(vol[0]).toMatchObject({ type: 'connect', count: 2 });
    expect(vol[0]!.date).toBe(today.toISOString().slice(0, 10));
  });
});
