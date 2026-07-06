// Tests the post-approval sequence resume on ApprovalAdapter: a cursor parked in
// awaiting_approval advances on approve, stops (skipped) on reject, and a
// non-parked cursor (a direct Act-tool approval) is left untouched.

import { describe, expect, it, beforeEach } from 'vitest';
import type { Action } from '@loa/shared';
import type { ActRequest, ExecutorPort } from '@loa/mcp';
import { InMemoryStore } from '../store/in-memory-store.js';
import { ApprovalAdapter } from './mcp-ports.js';
import type { OrchestratorServices } from './orchestrator.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';

class RecordingExecutor implements ExecutorPort {
  readonly calls: ActRequest[] = [];
  async execute(req: ActRequest): Promise<Action> {
    this.calls.push(req);
    const now = new Date();
    return {
      id: `action-${this.calls.length}`,
      type: req.type,
      scheduledAt: now,
      executedAt: now,
      result: 'success',
      dedupKey: `${req.accountId}:${req.targetId}:${req.type}`,
      accountId: req.accountId,
      targetId: req.targetId,
      campaignId: req.campaignId,
      createdAt: now,
      updatedAt: now,
    };
  }
}

// Only approvals.{approve,reject,editAndApprove} are called on these paths.
const fakeServices = {
  approvals: {
    async approve() {},
    async reject() {},
    async editAndApprove() {},
  },
} as unknown as OrchestratorServices;

async function parkedProgress(store: InMemoryStore, targetId: string): Promise<string> {
  const prog = await store.sequence.enrollTarget(CAMP, targetId, ACCT);
  await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
  return prog.id;
}

describe('ApprovalAdapter sequence resume', () => {
  let store: InMemoryStore;
  let executor: RecordingExecutor;
  let approvals: ApprovalAdapter;

  beforeEach(async () => {
    store = new InMemoryStore();
    executor = new RecordingExecutor();
    approvals = new ApprovalAdapter(fakeServices, executor, store);
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'message', body: 'first' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'message', body: 'follow up' });
  });

  it('advances a parked cursor to the next step on approve', async () => {
    await parkedProgress(store, 't1');
    approvals.bind('pend-1', { type: 'message', accountId: ACCT, targetId: 't1', campaignId: CAMP, payload: 'first' });

    await approvals.approve('pend-1', 'op');

    expect(executor.calls).toHaveLength(1); // the approved send dispatched
    const after = await store.sequence.getTargetProgressByTarget('t1');
    expect(after!.state).toBe('in_progress');
    expect(after!.currentStep).toBe(1);
  });

  it('stops the enrollment (skipped) on reject', async () => {
    await parkedProgress(store, 't2');
    approvals.bind('pend-2', { type: 'message', accountId: ACCT, targetId: 't2', campaignId: CAMP, payload: 'first' });

    await approvals.reject('pend-2', 'op', 'wrong angle');

    expect(executor.calls).toHaveLength(0); // nothing sent on reject
    const after = await store.sequence.getTargetProgressByTarget('t2');
    expect(after!.state).toBe('skipped');
    expect(after!.currentStep).toBe(0); // did not advance
  });

  it('leaves a non-parked cursor untouched (direct Act-tool approval)', async () => {
    // Enrolled but in_progress (not awaiting_approval): a direct send approval
    // for this target must not move the sequence cursor.
    const prog = await store.sequence.enrollTarget(CAMP, 't3', ACCT);
    approvals.bind('pend-3', { type: 'message', accountId: ACCT, targetId: 't3', campaignId: CAMP, payload: 'x' });

    await approvals.approve('pend-3', 'op');

    const after = await store.sequence.getTargetProgressByTarget('t3');
    expect(after!.id).toBe(prog.id);
    expect(after!.state).toBe('in_progress');
    expect(after!.currentStep).toBe(0);
  });
});
