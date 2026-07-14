// Tests the approval flow over a REAL ApprovalService + in-memory store, so the
// pending-item binding is persisted the same way it is in Postgres.
//
// The model: approving does NOT dispatch. approve() marks the message 'approved'
// and leaves the sequence cursor parked; the dispatch tick sends approved
// messages when the working-hours window is open and only then advances the
// cursor. So an off-hours approval goes out at the next window with no second
// approval. These tests cover that end to end.

import type { ActRequest, ExecutorPort, GateDeps } from '@loa/mcp';
import { ApprovalService, EventLog } from '@loa/orchestrator';
import type { Account, Action, Campaign } from '@loa/shared';
import { SafetyDeferredError } from '@loa/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DispatchTick } from '../dispatch/tick.js';
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

function makeServices(store: InMemoryStore): OrchestratorServices {
  const eventLog = new EventLog(store.event);
  const approvals = new ApprovalService(store.message, store.approval, eventLog);
  return { eventLog, approvals } as unknown as OrchestratorServices;
}

/** A dispatch tick over the same store, whose executor the test controls. Its
 * gate is a stub — the tick's approved-send path uses only executor + safety
 * (for the account schedule). approval.enqueue must work, though: once a send
 * advances the cursor onto a scheduled follow-up message step, the tick's
 * pre-draft pass queues that follow-up in the same tick. */
function makeTick(store: InMemoryStore, executor: RecordingExecutor): DispatchTick {
  const gate: GateDeps = {
    executor,
    safety: {
      getAccount: async (id: string): Promise<Account> => fakeAccount(id),
      getCampaign: async (id: string): Promise<Campaign> => fakeCampaign(id),
      canAct: async () => ({ kind: 'allow' as const }),
    },
    approval: {
      async enqueue(req, autonomyLevel) {
        return { id: `pending-${req.targetId}`, req, autonomyLevel, createdAt: new Date() };
      },
      async listPending() {
        return [];
      },
      async approve() {
        throw new Error('not used');
      },
      async editAndApprove() {
        throw new Error('not used');
      },
      async reject() {
        /* not used */
      },
      async record() {
        /* not used */
      },
    },
  };
  return new DispatchTick({
    sequence: store.sequence,
    targets: store.target,
    messages: store.message,
    gate,
  });
}

function fakeAccount(id: string): Account {
  return {
    id,
    handle: 'op',
    proxyBinding: { proxyId: 'p', region: 'us', sticky: true },
    state: 'Active',
    health: { acceptanceRate: 0.6, replyRate: 0.3, challengesLast7d: 0, lastCheckedAt: new Date() },
    budget: {
      date: new Date().toISOString().slice(0, 10),
      caps: {
        connect: 10,
        message: 10,
        view_profile: 10,
        follow: 10,
        withdraw_invite: 10,
        react: 10,
      },
      used: { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeCampaign(id: string): Campaign {
  return {
    id,
    goal: 'g',
    autonomyLevel: 'semi_auto',
    messageStrategy: 's',
    owner: 'o',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function messageReq(targetId: string, body = 'first'): ActRequest {
  return { type: 'message', accountId: ACCT, targetId, campaignId: CAMP, payload: body };
}

async function parkedProgress(store: InMemoryStore, targetId: string): Promise<string> {
  // A 'connected' target row must exist: the tick's pre-send guards cancel an
  // approved message whose target is missing or terminal (lost/replied).
  await store.target.create({
    id: targetId,
    campaignId: CAMP,
    prospectRef: targetId,
    linkedinUrn: `urn:li:person:${targetId}`,
    externalContext: {},
    stage: 'connected',
  });
  const prog = await store.sequence.enrollTarget(CAMP, targetId, ACCT);
  await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
  return prog.id;
}

describe('ApprovalAdapter — approval marks approved, tick sends', () => {
  let store: InMemoryStore;
  let executor: RecordingExecutor;
  let approvals: ApprovalAdapter;

  beforeEach(async () => {
    store = new InMemoryStore();
    executor = new RecordingExecutor();
    approvals = new ApprovalAdapter(makeServices(store), executor, store);
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'first',
    });
    // The follow-up carries a delay so, after the first send advances the cursor
    // onto it, it is not immediately due again within the same tick pass.
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'message',
      body: 'follow up',
      delaySeconds: 3600,
    });
  });

  it('approve marks the message approved and leaves the cursor parked (no send yet)', async () => {
    await parkedProgress(store, 't1');
    const pending = await approvals.enqueue(messageReq('t1'), 'supervised', 'first');

    const outcome = await approvals.approve(pending.id, 'op');

    expect(outcome.status).toBe('approved');
    expect(executor.calls).toHaveLength(0); // nothing dispatched at approval time
    expect((await store.message.findById(pending.id))!.status).toBe('approved');
    // Still parked; the tick advances it only after the send.
    expect((await store.sequence.getTargetProgressByTarget('t1'))!.state).toBe('awaiting_approval');
  });

  it('the tick sends the approved message and advances the cursor', async () => {
    await parkedProgress(store, 't2');
    const pending = await approvals.enqueue(messageReq('t2'), 'supervised', 'first');
    await approvals.approve(pending.id, 'op');

    const res = await makeTick(store, executor).runTick(new Date());

    expect(executor.calls).toHaveLength(1);
    expect((await store.message.findById(pending.id))!.status).toBe('sent');
    const prog = await store.sequence.getTargetProgressByTarget('t2');
    expect(prog!.currentStep).toBe(1); // advanced to the follow-up
    // The pre-draft pass queued the scheduled follow-up in the same tick, so
    // the cursor is already parked for its approval — not idle in_progress.
    expect(prog!.state).toBe('awaiting_approval');
    expect(prog!.nextStepAt!.getTime()).toBeGreaterThan(Date.now()); // send still waits
    expect(res.outcomes.some((o) => o.kind === 'executed')).toBe(true);
  });

  it('an off-hours (deferred) send leaves it approved; a later tick sends it — no re-approval', async () => {
    await parkedProgress(store, 't3');
    const pending = await approvals.enqueue(messageReq('t3'), 'supervised', 'first');
    await approvals.approve(pending.id, 'op');

    // First tick: the executor's gate defers (outside the window).
    executor.throwOnce = new SafetyDeferredError({
      kind: 'defer',
      until: new Date(Date.now() + 3_600_000),
    });
    await makeTick(store, executor).runTick(new Date());
    expect((await store.message.findById(pending.id))!.status).toBe('approved'); // still approved
    expect((await store.sequence.getTargetProgressByTarget('t3'))!.state).toBe('awaiting_approval');

    // Later tick, window now open: it sends, no second approval needed.
    await makeTick(store, executor).runTick(new Date());
    expect((await store.message.findById(pending.id))!.status).toBe('sent');
    expect((await store.sequence.getTargetProgressByTarget('t3'))!.currentStep).toBe(1);
  });

  it('a failed send leaves the message approved for a later retry', async () => {
    await parkedProgress(store, 't4');
    const pending = await approvals.enqueue(messageReq('t4'), 'supervised', 'first');
    await approvals.approve(pending.id, 'op');

    executor.result = 'failed';
    await makeTick(store, executor).runTick(new Date());
    expect((await store.message.findById(pending.id))!.status).toBe('approved'); // not sent
    expect((await store.sequence.getTargetProgressByTarget('t4'))!.state).toBe('awaiting_approval');
  });

  it('editAndApprove sends the EDITED body, not the persisted draft payload', async () => {
    await parkedProgress(store, 't5');
    const pending = await approvals.enqueue(
      messageReq('t5', 'original text'),
      'supervised',
      'original text',
    );

    await approvals.editAndApprove(pending.id, 'op', 'rewritten by the operator');
    await makeTick(store, executor).runTick(new Date());

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]!.payload).toBe('rewritten by the operator');
  });

  it('reject marks the draft rejected, stops the enrollment (skipped), nothing sent', async () => {
    await parkedProgress(store, 't6');
    const pending = await approvals.enqueue(messageReq('t6'), 'supervised', 'first');

    await approvals.reject(pending.id, 'op', 'wrong angle');
    await makeTick(store, executor).runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect((await store.sequence.getTargetProgressByTarget('t6'))!.state).toBe('skipped');
    // The draft is terminal 'rejected': gone from the pending queue, un-approvable.
    expect((await store.message.findById(pending.id))!.status).toBe('rejected');
    expect(await store.message.listDrafts()).toHaveLength(0);
    await expect(approvals.approve(pending.id, 'op')).rejects.toThrow(/already decided/);
  });
});

describe('ApprovalAdapter durability across a restart', () => {
  it('a pending item enqueued before a restart approves + sends through fresh instances', async () => {
    const store = new InMemoryStore();
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });

    const execA = new RecordingExecutor();
    const adapterA = new ApprovalAdapter(makeServices(store), execA, store);
    await store.target.create({
      id: 't-restart',
      campaignId: CAMP,
      prospectRef: 't-restart',
      linkedinUrn: 'urn:li:person:t-restart',
      externalContext: {},
      stage: 'connected',
    });
    const prog = await store.sequence.enrollTarget(CAMP, 't-restart', ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
    const pending = await adapterA.enqueue(
      messageReq('t-restart', 'nice to connect'),
      'supervised',
      'nice to connect',
    );

    // Restart: brand-new adapter + services over the SAME store.
    const execB = new RecordingExecutor();
    const adapterB = new ApprovalAdapter(makeServices(store), execB, store);

    const listed = await adapterB.listPending();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(pending.id);

    const outcome = await adapterB.approve(pending.id, 'op');
    expect(outcome.status).toBe('approved');
    expect(execA.calls).toHaveLength(0); // pre-restart adapter never dispatched

    await makeTick(store, execB).runTick(new Date());
    expect(execB.calls).toHaveLength(1);
    expect(execB.calls[0]).toMatchObject({ type: 'message', targetId: 't-restart' });
    expect((await store.message.findById(pending.id))!.status).toBe('sent');
    // No longer pending, and it left the approval queue when approved.
    expect(await adapterB.listPending()).toHaveLength(0);
  });
});
