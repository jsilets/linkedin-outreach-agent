// Dispatch-tick unit tests. They exercise the tick against the in-memory
// sequence store and a controllable GateDeps (fake safety + approval +
// executor), covering: a delay step advances without acting; an action step
// routes through the gate and advances; a gate deny leaves the cursor for retry;
// the last step completes.
//
// The executor is the runtime FakeExecutor shape: every act persists an Action
// and returns it. The safety port returns a configurable Decision so we can flip
// allow -> deny per test.

import { describe, expect, it, beforeEach } from 'vitest';
import type { Account, Action, Campaign, Decision } from '@loa/shared';
import type { ActRequest, ExecutorPort, GateDeps } from '@loa/mcp';
import { InMemoryStore } from '../store/in-memory-store.js';
import { DispatchTick } from './tick.js';

// --- fakes ------------------------------------------------------------------

class RecordingExecutor implements ExecutorPort {
  readonly calls: ActRequest[] = [];
  private seq = 0;
  async execute(req: ActRequest): Promise<Action> {
    this.calls.push(req);
    this.seq += 1;
    const now = new Date();
    return {
      id: `action-${this.seq}`,
      type: req.type,
      scheduledAt: now,
      executedAt: now,
      result: 'success',
      dedupKey: `${req.accountId}:${req.targetId}:${req.type}:${this.seq}`,
      accountId: req.accountId,
      targetId: req.targetId,
      campaignId: req.campaignId,
      createdAt: now,
      updatedAt: now,
    };
  }
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
      caps: { connect: 10, message: 10, view_profile: 10, follow: 10, withdraw_invite: 10, react: 10 },
      used: { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 },
    },
    warmupDay: 28,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeCampaign(id: string): Campaign {
  return {
    id,
    goal: 'g',
    // Autonomous so mayExecuteDirectly is true and the decision reaches the executor.
    autonomyLevel: 'autonomous',
    messageStrategy: 's',
    owner: 'o',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Build GateDeps whose safety returns `decision` and whose approval enqueue
 * throws (the autonomous path should never enqueue). */
function makeGate(executor: ExecutorPort, decision: Decision): GateDeps {
  return {
    executor,
    safety: {
      async getAccount(id: string): Promise<Account> {
        return fakeAccount(id);
      },
      async getCampaign(id: string): Promise<Campaign> {
        return fakeCampaign(id);
      },
      async canAct(): Promise<Decision> {
        return decision;
      },
    },
    approval: {
      async enqueue() {
        throw new Error('approval.enqueue should not be called on the autonomous path');
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
}

// --- fixtures ---------------------------------------------------------------

const ACCT = 'acct-1';
const CAMP = 'camp-1';
const TGT = 'tgt-1';

async function seedTargetRow(store: InMemoryStore): Promise<void> {
  await store.target.create({
    id: TGT,
    campaignId: CAMP,
    prospectRef: 'p1',
    linkedinUrn: 'urn:li:person:p1',
    externalContext: {},
    stage: 'sourced',
  });
}

describe('DispatchTick', () => {
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    await seedTargetRow(store);
  });

  it('delay step advances the cursor without acting, gating the next step', async () => {
    // steps: [delay, message(delay 120s)]. The delay step advances to the
    // message and gates it behind the message step's own delaySeconds.
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'delay', delaySeconds: 60 });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'message', body: 'hi', delaySeconds: 120 });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({ sequence: store.sequence, gate: makeGate(executor, { kind: 'allow' }) });

    const now = new Date('2026-07-06T12:00:00Z');
    const res = await tick.runTick(now);

    expect(res.ran).toBe(1);
    expect(executor.calls).toHaveLength(0); // delay does not act
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.currentStep).toBe(1);
    expect(progress.state).toBe('in_progress');
    // nextStepAt gated by the NEXT step's delaySeconds (120s), not the delay's.
    expect(progress.nextStepAt?.getTime()).toBe(now.getTime() + 120_000);
  });

  it('action step routes through the gate and advances with the next delay', async () => {
    // steps: [connect, delay(120s), message]
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect', note: 'hello' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'delay', delaySeconds: 120 });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 2, stepType: 'message', body: 'body' });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({ sequence: store.sequence, gate: makeGate(executor, { kind: 'allow' }) });

    const now = new Date('2026-07-06T12:00:00Z');
    const res = await tick.runTick(now);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ type: 'connect', accountId: ACCT, targetId: TGT, campaignId: CAMP, payload: 'hello' });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.currentStep).toBe(1);
    expect(progress.state).toBe('in_progress');
    // nextStepAt comes from the NEXT step (the delay), 120s out.
    expect(progress.nextStepAt?.getTime()).toBe(now.getTime() + 120_000);
    expect(res.outcomes[0]).toMatchObject({ kind: 'executed', actionId: 'action-1' });
  });

  it('gate deny leaves the cursor in place for a later retry', async () => {
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'message', body: 'b' });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      gate: makeGate(executor, { kind: 'deny', reason: 'budget' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.currentStep).toBe(0); // unchanged
    expect(progress.state).toBe('in_progress');
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'denied' });

    // A later tick with allow now advances it.
    const tick2 = new DispatchTick({ sequence: store.sequence, gate: makeGate(executor, { kind: 'allow' }) });
    await tick2.runTick(new Date());
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.currentStep).toBe(1);
    expect(executor.calls).toHaveLength(1);
  });

  it('completes when the last step executes', async () => {
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'view_profile' });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({ sequence: store.sequence, gate: makeGate(executor, { kind: 'allow' }) });

    await tick.runTick(new Date());

    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('completed');
    expect(progress.nextStepAt).toBeNull();
    expect(executor.calls).toHaveLength(1);

    // Completed cursors are no longer due.
    const due = await store.sequence.dueTargetProgress(new Date());
    expect(due).toHaveLength(0);
  });

  it('walks a full sequence across ticks: connect -> delay -> message -> completed', async () => {
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 0, stepType: 'connect' });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 1, stepType: 'delay', delaySeconds: 60 });
    await store.sequence.upsertCampaignStep({ campaignId: CAMP, stepOrder: 2, stepType: 'message', body: 'b' });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({ sequence: store.sequence, gate: makeGate(executor, { kind: 'allow' }) });

    const t0 = new Date('2026-07-06T12:00:00Z');
    await tick.runTick(t0); // connect -> cursor at delay, due at +60s (delay's own delaySeconds)
    let [p] = await store.sequence.listTargetProgress(CAMP);
    expect(p.currentStep).toBe(1);
    expect(p.nextStepAt?.getTime()).toBe(t0.getTime() + 60_000);

    // Not due yet before the delay elapses.
    expect(await store.sequence.dueTargetProgress(new Date(t0.getTime() + 30_000))).toHaveLength(0);

    const t1 = new Date(t0.getTime() + 60_000);
    await tick.runTick(t1); // delay -> cursor at message (delay 0), due immediately
    [p] = await store.sequence.listTargetProgress(CAMP);
    expect(p.currentStep).toBe(2);
    expect(p.nextStepAt).toBeNull();

    await tick.runTick(t1); // message -> completed
    [p] = await store.sequence.listTargetProgress(CAMP);
    expect(p.state).toBe('completed');
    expect(executor.calls.map((c) => c.type)).toEqual(['connect', 'message']);
  });
});
