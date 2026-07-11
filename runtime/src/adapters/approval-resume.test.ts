// Tests the ApprovalAdapter over a REAL ApprovalService backed by the in-memory
// store, so the pending-item binding is persisted the same way it is in
// Postgres. Covers two things:
//   1. Post-approval sequence resume: a cursor parked in awaiting_approval
//      advances on approve, stops (skipped) on reject, and a non-parked cursor
//      (a direct Act-tool approval) is left untouched.
//   2. Durability across a restart: a pending item enqueued through one adapter
//      is still visible via list_pending and still dispatches the correct
//      ActRequest through a brand-new adapter + services built over the SAME
//      store (the in-memory map used to strand these on restart).

import { describe, expect, it, beforeEach } from 'vitest';
import type { Action } from '@loa/shared';
import { SafetyDeferredError } from '@loa/shared';
import type { ActRequest, ExecutorPort } from '@loa/mcp';
import { ApprovalService, EventLog } from '@loa/orchestrator';
import { InMemoryStore } from '../store/in-memory-store.js';
import { ApprovalAdapter } from './mcp-ports.js';
import type { OrchestratorServices } from './orchestrator.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';

class RecordingExecutor implements ExecutorPort {
  readonly calls: ActRequest[] = [];
  /** Result stamped on returned actions; a test flips it to 'failed'. */
  result: 'success' | 'failed' = 'success';
  /** When set, execute throws this instead of returning (mint-time defer). */
  throwOnce: Error | undefined;

  async execute(req: ActRequest): Promise<Action> {
    if (this.throwOnce) {
      const err = this.throwOnce;
      this.throwOnce = undefined;
      throw err;
    }
    this.calls.push(req);
    const now = new Date();
    return {
      id: `action-${this.calls.length}`,
      type: req.type,
      scheduledAt: now,
      executedAt: now,
      result: this.result,
      dedupKey: `${req.accountId}:${req.targetId}:${req.type}`,
      accountId: req.accountId,
      targetId: req.targetId,
      campaignId: req.campaignId,
      createdAt: now,
      updatedAt: now,
    };
  }
}

/** Real orchestrator services over the store: the ApprovalService persists the
 * pending item (and its ActRequest) to the store, exactly like production. Only
 * the approvals + eventLog slice is exercised by these tests. */
function makeServices(store: InMemoryStore): OrchestratorServices {
  const eventLog = new EventLog(store.event);
  const approvals = new ApprovalService(store.message, store.approval, eventLog);
  return { eventLog, approvals } as unknown as OrchestratorServices;
}

function messageReq(targetId: string, body = 'first'): ActRequest {
  return { type: 'message', accountId: ACCT, targetId, campaignId: CAMP, payload: body };
}

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
    approvals = new ApprovalAdapter(makeServices(store), executor, store);
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'message', body: 'first' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'message', body: 'follow up' });
  });

  it('advances a parked cursor to the next step on approve', async () => {
    await parkedProgress(store, 't1');
    const pending = await approvals.enqueue(messageReq('t1'), 'supervised', 'first');

    await approvals.approve(pending.id, 'op');

    expect(executor.calls).toHaveLength(1); // the approved send dispatched
    const after = await store.sequence.getTargetProgressByTarget('t1');
    expect(after!.state).toBe('in_progress');
    expect(after!.currentStep).toBe(1);
  });

  it('stops the enrollment (skipped) on reject', async () => {
    await parkedProgress(store, 't2');
    const pending = await approvals.enqueue(messageReq('t2'), 'supervised', 'first');

    await approvals.reject(pending.id, 'op', 'wrong angle');

    expect(executor.calls).toHaveLength(0); // nothing sent on reject
    const after = await store.sequence.getTargetProgressByTarget('t2');
    expect(after!.state).toBe('skipped');
    expect(after!.currentStep).toBe(0); // did not advance
  });

  it('leaves a non-parked cursor untouched (direct Act-tool approval)', async () => {
    // Enrolled but in_progress (not awaiting_approval): a direct send approval
    // for this target must not move the sequence cursor.
    const prog = await store.sequence.enrollTarget(CAMP, 't3', ACCT);
    const pending = await approvals.enqueue(messageReq('t3', 'x'), 'supervised', 'x');

    await approvals.approve(pending.id, 'op');

    const after = await store.sequence.getTargetProgressByTarget('t3');
    expect(after!.id).toBe(prog.id);
    expect(after!.state).toBe('in_progress');
    expect(after!.currentStep).toBe(0);
  });
});

describe('ApprovalAdapter dispatch-first ordering', () => {
  let store: InMemoryStore;
  let executor: RecordingExecutor;
  let approvals: ApprovalAdapter;

  beforeEach(async () => {
    store = new InMemoryStore();
    executor = new RecordingExecutor();
    approvals = new ApprovalAdapter(makeServices(store), executor, store);
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'message', body: 'first' });
  });

  it('a safety deferral at dispatch leaves the draft pending and the cursor parked', async () => {
    await parkedProgress(store, 't-defer');
    const pending = await approvals.enqueue(messageReq('t-defer'), 'supervised', 'first');

    // The executor's mint-time gate re-check defers (cap hit / outside hours).
    executor.throwOnce = new SafetyDeferredError({
      kind: 'defer',
      until: new Date(Date.now() + 60_000),
    });
    await expect(approvals.approve(pending.id, 'op')).rejects.toBeInstanceOf(SafetyDeferredError);

    // Nothing was consumed: the draft is still pending (re-approvable), the
    // cursor is still parked, and no send happened.
    expect(executor.calls).toHaveLength(0);
    expect(await approvals.listPending()).toHaveLength(1);
    const prog = await store.sequence.getTargetProgressByTarget('t-defer');
    expect(prog!.state).toBe('awaiting_approval');

    // A later re-approve (gate now allows) dispatches and resolves normally.
    // This suite has a single sequence step, so approval completes the run.
    const action = await approvals.approve(pending.id, 'op');
    expect(action.result).toBe('success');
    expect(await approvals.listPending()).toHaveLength(0);
    expect((await store.sequence.getTargetProgressByTarget('t-defer'))!.state).toBe('completed');
  });

  it('a failed page drive leaves the draft pending instead of marking it sent', async () => {
    await parkedProgress(store, 't-fail');
    const pending = await approvals.enqueue(messageReq('t-fail'), 'supervised', 'first');

    executor.result = 'failed';
    const action = await approvals.approve(pending.id, 'op');

    expect(action.result).toBe('failed');
    // The draft was NOT marked sent and the cursor did not advance: the
    // operator can re-approve once the underlying failure is fixed.
    expect(await approvals.listPending()).toHaveLength(1);
    expect((await store.sequence.getTargetProgressByTarget('t-fail'))!.state).toBe(
      'awaiting_approval',
    );
  });

  it('editAndApprove dispatches the EDITED body, not the persisted draft payload', async () => {
    const pending = await approvals.enqueue(
      messageReq('t-edit', 'original text'),
      'supervised',
      'original text',
    );

    await approvals.editAndApprove(pending.id, 'op', 'rewritten by the operator');

    expect(executor.calls).toHaveLength(1);
    // The persisted ActRequest still carries the original payload; the send
    // must use the operator's rewrite.
    expect(executor.calls[0]!.payload).toBe('rewritten by the operator');
  });
});

describe('ApprovalAdapter durability across a restart', () => {
  it('list_pending and approve survive a fresh adapter + services over the same store', async () => {
    const store = new InMemoryStore();

    // --- before "restart": enqueue a connect approval through adapter A. ---
    const execA = new RecordingExecutor();
    const adapterA = new ApprovalAdapter(makeServices(store), execA, store);
    const req: ActRequest = {
      type: 'connect',
      accountId: ACCT,
      targetId: 't-restart',
      campaignId: CAMP,
      payload: 'nice to connect',
    };
    const pending = await adapterA.enqueue(req, 'supervised', 'nice to connect');

    // --- simulate a process restart: brand-new services + adapter, no shared
    //     in-memory state, only the SAME store underneath. ---
    const execB = new RecordingExecutor();
    const adapterB = new ApprovalAdapter(makeServices(store), execB, store);

    // The operator still sees the pending item (previously it went empty here).
    const listed = await adapterB.listPending();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(pending.id);
    expect(listed[0]!.req).toMatchObject({
      type: 'connect',
      targetId: 't-restart',
      campaignId: CAMP,
      payload: 'nice to connect',
    });

    // Approving dispatches the correct ActRequest (previously threw "no
    // ActRequest bound to pending item").
    const action = await adapterB.approve(pending.id, 'op');
    expect(action.type).toBe('connect');
    expect(execB.calls).toHaveLength(1);
    expect(execB.calls[0]).toMatchObject({
      type: 'connect',
      targetId: 't-restart',
      payload: 'nice to connect',
    });
    // The pre-restart adapter never dispatched anything.
    expect(execA.calls).toHaveLength(0);

    // The item is no longer pending after approval.
    expect(await adapterB.listPending()).toHaveLength(0);
  });
});
