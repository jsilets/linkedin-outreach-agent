// Dispatch-tick unit tests. They exercise the tick against the in-memory
// sequence store and a controllable GateDeps (fake safety + approval +
// executor), covering: a delay step advances without acting; an action step
// routes through the gate and advances; a gate deny leaves the cursor for retry;
// the last step completes.
//
// The executor is the runtime FakeExecutor shape: every act persists an Action
// and returns it. The safety port returns a configurable Decision so we can flip
// allow -> deny per test.

import type { ActRequest, ExecutorPort, GateDeps } from '@loa/mcp';
import type { Account, Action, Campaign, Decision, Json } from '@loa/shared';
import { SafetyDeferredError } from '@loa/shared';
import { beforeEach, describe, expect, it } from 'vitest';
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

/** An executor whose execute() always throws the given error. Models the two
 * ways the executor can fail once the gate has already allowed at step 1:
 * a typed SafetyDeferredError (the runner re-check flipped to defer/deny at
 * token-mint time) vs. a genuine error. */
class ThrowingExecutor implements ExecutorPort {
  calls = 0;
  constructor(private readonly err: Error) {}
  async execute(_req: ActRequest): Promise<Action> {
    this.calls += 1;
    throw this.err;
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

/** A supervised gate: getCampaign returns a supervised campaign so every send
 * queues, and approval.enqueue records the draft and returns a pending item
 * (never touches executor). */
function makeSupervisedGate(
  executor: ExecutorPort,
  enqueued: Array<{ req: ActRequest; draftBody?: string }> = [],
): GateDeps {
  return {
    executor,
    safety: {
      async getAccount(id: string): Promise<Account> {
        return fakeAccount(id);
      },
      async getCampaign(id: string): Promise<Campaign> {
        return { ...fakeCampaign(id), autonomyLevel: 'supervised' };
      },
      async canAct(): Promise<Decision> {
        throw new Error('canAct should not run: supervised queues before the safety check');
      },
    },
    approval: {
      async enqueue(req, _level, draftBody) {
        enqueued.push({ req, draftBody });
        return { id: 'pending-1', req, autonomyLevel: 'supervised', createdAt: new Date() };
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
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'delay',
      delaySeconds: 60,
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'message',
      body: 'hi',
      delaySeconds: 120,
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

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

  it('a non-connect action routes through the gate and advances with the next delay', async () => {
    // steps: [view_profile, delay(120s), message]. A view_profile is a plain
    // timer-advancing action (connect is special-cased to park; see below).
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'view_profile',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'delay',
      delaySeconds: 120,
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 2,
      stepType: 'message',
      body: 'body',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const now = new Date('2026-07-06T12:00:00Z');
    const res = await tick.runTick(now);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      type: 'view_profile',
      accountId: ACCT,
      targetId: TGT,
      campaignId: CAMP,
    });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.currentStep).toBe(1);
    expect(progress.state).toBe('in_progress');
    // nextStepAt comes from the NEXT step (the delay), 120s out.
    expect(progress.nextStepAt?.getTime()).toBe(now.getTime() + 120_000);
    expect(res.outcomes[0]).toMatchObject({ kind: 'executed', actionId: 'action-1' });
  });

  it('a successful connect parks the cursor in awaiting_connection and sets the target invited', async () => {
    // steps: [connect, message]. A connect is not a timer advance: it sends the
    // invite, sets the target stage to 'invited', and parks the cursor ON the
    // connect step (no due time) for the acceptance tick to release.
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'hello',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'message',
      body: 'body',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const now = new Date('2026-07-06T12:00:00Z');
    const res = await tick.runTick(now);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ type: 'connect', payload: 'hello' });
    expect(res.outcomes[0]).toMatchObject({ kind: 'awaiting_connection' });

    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('awaiting_connection');
    expect(progress.currentStep).toBe(0); // still ON the connect step
    expect(progress.nextStepAt).toBeNull(); // parked, not on a timer
    expect(progress.lastStepAt?.getTime()).toBe(now.getTime());

    const target = await store.target.findById(TGT);
    expect(target?.stage).toBe('invited');

    // Parked cursors are not due, so the dispatch tick will not re-fire it.
    expect(await store.sequence.dueTargetProgress(new Date())).toHaveLength(0);
  });

  it('holds a message step whose target is not yet connected, and fires once it is', async () => {
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    // Target is still 'invited' (connect sent, not accepted): the message is held.
    await store.target.setStage(TGT, 'invited');

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0); // not fired
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'not_connected' });
    const [held] = await store.sequence.listTargetProgress(CAMP);
    expect(held.currentStep).toBe(0); // cursor left in place
    expect(held.state).toBe('in_progress');

    // Once the target is connected, the same step fires.
    await store.target.setStage(TGT, 'connected');
    await tick.runTick(new Date());
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ type: 'message', payload: 'hi' });
  });

  it('holds a connect step when the same person is already contacted in another campaign', async () => {
    // A DIFFERENT campaign already has this person at a contacted stage (invited).
    await store.target.create({
      id: 'tgt-other',
      campaignId: 'camp-other',
      prospectRef: 'p1',
      linkedinUrn: 'urn:li:person:p1', // same canonical key as TGT
      externalContext: {},
      stage: 'invited',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const events: string[] = [];
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
      log: {
        async recordEvent(kind: string) {
          events.push(kind);
          return undefined;
        },
      },
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0); // never contacted
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'cross_campaign_active' });
    expect(events).toContain('step_held_cross_campaign');
    // Cursor left in place: if the other campaign goes terminal, a later tick releases this.
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.currentStep).toBe(0);
    expect(progress.state).toBe('in_progress');
  });

  it('does not hold when the other-campaign target is only sourced (not yet contacted)', async () => {
    // Two pre-contact enrollments must not deadlock: whichever fires first wins.
    await store.target.create({
      id: 'tgt-other',
      campaignId: 'camp-other',
      prospectRef: 'p1',
      linkedinUrn: 'urn:li:person:p1',
      externalContext: {},
      stage: 'sourced',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(1); // connect fired
    expect(res.outcomes[0]).toMatchObject({ kind: 'awaiting_connection' });
  });

  it('ejects the target (no send, no livelock) when the person is already landed in another campaign', async () => {
    // 'connected' can be a permanent resting state, so holding would livelock.
    await store.target.create({
      id: 'tgt-other',
      campaignId: 'camp-other',
      prospectRef: 'p1',
      linkedinUrn: 'urn:li:person:p1',
      externalContext: {},
      stage: 'connected',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.target.setStage(TGT, 'connected');

    const executor = new RecordingExecutor();
    const events: string[] = [];
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
      log: {
        async recordEvent(kind: string) {
          events.push(kind);
          return undefined;
        },
      },
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'cross_campaign_contacted' });
    expect(events).toContain('target_skipped_cross_campaign');
    // Terminally ejected, not held forever: progress is skipped and the target lost.
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('skipped');
    expect((await store.target.findById(TGT))!.stage).toBe('lost');
  });

  it('ejects rather than livelocks when the person already replied/won in another campaign', async () => {
    // The exact terminal case: 'won' never leaves that stage, so a hold would
    // burn a tick forever. The target must be resolved once and left alone.
    await store.target.create({
      id: 'tgt-other',
      campaignId: 'camp-other',
      prospectRef: 'p1',
      linkedinUrn: 'urn:li:person:p1',
      externalContext: {},
      stage: 'won',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'cross_campaign_contacted' });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('skipped'); // resolved, will not be re-picked
  });

  it('gate deny leaves the cursor in place for a later retry', async () => {
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'view_profile',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'delay',
      delaySeconds: 0,
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      messages: store.message,
      gate: makeGate(executor, { kind: 'deny', reason: 'budget' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.currentStep).toBe(0); // unchanged
    expect(progress.state).toBe('in_progress');
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'denied' });

    // A later tick with allow now advances it.
    const tick2 = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });
    await tick2.runTick(new Date());
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.currentStep).toBe(1);
    expect(executor.calls).toHaveLength(1);
  });

  it('parks a queued step in awaiting_approval so it is not re-enqueued each tick', async () => {
    // Supervised: a message step queues for approval. The cursor must move to
    // awaiting_approval (not stay due), or the next tick enqueues a duplicate.
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    // Connected, so the message gate lets it through to the approval queue.
    await store.target.setStage(TGT, 'connected');

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeSupervisedGate(executor),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'queued' });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('awaiting_approval');
    expect(progress.currentStep).toBe(0); // held at the pending step

    // Parked cursors are no longer due, so a second tick does nothing (no dup).
    expect(await store.sequence.dueTargetProgress(new Date())).toHaveLength(0);
    const res2 = await tick.runTick(new Date());
    expect(res2.ran).toBe(0);
  });

  it('a mint-time safety defer leaves the cursor in_progress for retry, never failed', async () => {
    // The gate ALLOWS at step 1, but the executor re-checks safety at token-mint
    // time and the anti-burst pacer has since flipped it to defer. The runner
    // SafetyPort signals this with a typed SafetyDeferredError. This must behave
    // like any other deferral: the cursor stays in_progress on the same step and
    // is NOT marked failed (the bug this fix addresses).
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'view_profile',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'delay',
      delaySeconds: 0,
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const until = new Date('2026-07-06T12:05:00Z');
    const executor = new ThrowingExecutor(new SafetyDeferredError({ kind: 'defer', until }));
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toBe(1); // the executor WAS reached (gate allowed)
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'deferred' });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('in_progress'); // NOT failed
    expect(progress.currentStep).toBe(0); // cursor left on the same step
    expect(progress.errorMessage ?? null).toBeNull();

    // A later tick that allows all the way through now advances it.
    const okExecutor = new RecordingExecutor();
    const tick2 = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(okExecutor, { kind: 'allow' }),
    });
    await tick2.runTick(new Date());
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.currentStep).toBe(1);
    expect(okExecutor.calls).toHaveLength(1);
  });

  it('a genuine executor error still marks the cursor failed', async () => {
    // A non-SafetyDeferredError throw is a real failure and must NOT be swallowed:
    // the cursor is marked failed with the error message, exactly as before.
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'view_profile',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new ThrowingExecutor(new Error('page crashed'));
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const res = await tick.runTick(new Date());

    expect(executor.calls).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ kind: 'failed', error: 'page crashed' });
    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('failed');
    expect(progress.errorMessage).toBe('page crashed');
    expect(progress.nextStepAt).toBeNull();
  });

  it('completes when the last step executes', async () => {
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'view_profile',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    await tick.runTick(new Date());

    const [progress] = await store.sequence.listTargetProgress(CAMP);
    expect(progress.state).toBe('completed');
    expect(progress.nextStepAt).toBeNull();
    expect(executor.calls).toHaveLength(1);

    // Completed cursors are no longer due.
    const due = await store.sequence.dueTargetProgress(new Date());
    expect(due).toHaveLength(0);
  });

  it('walks a full sequence across ticks: view_profile -> delay -> message -> completed', async () => {
    // The linear timer walk (connect is covered separately since it parks).
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'view_profile',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'delay',
      delaySeconds: 60,
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 2,
      stepType: 'message',
      body: 'b',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    // Connected, so the message step at the end fires.
    await store.target.setStage(TGT, 'connected');

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    const t0 = new Date('2026-07-06T12:00:00Z');
    await tick.runTick(t0); // view_profile -> cursor at delay, due at +60s (delay's own delaySeconds)
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
    expect(executor.calls.map((c) => c.type)).toEqual(['view_profile', 'message']);
  });
});

describe('DispatchTick pre-draft pass — draft at schedule time, send at due time', () => {
  const NOW = new Date('2026-07-06T12:00:00Z');
  const FUTURE = new Date('2026-07-07T09:00:00Z');

  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    await seedTargetRow(store);
  });

  it('drafts an upcoming message step immediately on a supervised campaign, keeping the future due time', async () => {
    // The state the acceptance tick leaves behind: connected target, cursor on
    // the message step, nextStepAt out in the future.
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    const p = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.target.setStage(TGT, 'connected');
    await store.sequence.advanceTargetProgress(p.id, { nextStepAt: FUTURE });

    const executor = new RecordingExecutor();
    const enqueued: Array<{ req: ActRequest; draftBody?: string }> = [];
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeSupervisedGate(executor, enqueued),
    });

    const res = await tick.runTick(NOW);

    expect(res.ran).toBe(0); // nothing was due
    expect(executor.calls).toHaveLength(0); // nothing sent
    expect(enqueued).toHaveLength(1); // the draft reached the approval queue NOW
    expect(enqueued[0]!.req).toMatchObject({ type: 'message', targetId: TGT });
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'queued' });

    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('awaiting_approval');
    expect(after.nextStepAt?.getTime()).toBe(FUTURE.getTime()); // the send time survives

    // Parked: a second tick does not enqueue a duplicate draft.
    await tick.runTick(NOW);
    expect(enqueued).toHaveLength(1);
  });

  it('holds an approved message with a future nextStepAt, then sends once it is due', async () => {
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    const p = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.target.setStage(TGT, 'connected');
    // The pre-draft pass parked it awaiting_approval; the operator approved.
    await store.sequence.advanceTargetProgress(p.id, {
      state: 'awaiting_approval',
      nextStepAt: FUTURE,
    });
    const req: ActRequest = {
      type: 'message',
      accountId: ACCT,
      targetId: TGT,
      campaignId: CAMP,
      payload: 'hi',
    };
    const msg = await store.message.create({
      accountId: ACCT,
      targetId: TGT,
      direction: 'outbound',
      body: 'hi',
      threadRef: `pending:${ACCT}:${TGT}`,
      status: 'approved',
      pendingReq: req as unknown as Json,
    });

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }),
    });

    await tick.runTick(NOW); // before the due time: held, still approved
    expect(executor.calls).toHaveLength(0);
    expect((await store.message.findById(msg.id))!.status).toBe('approved');

    await tick.runTick(FUTURE); // at the due time: sent
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ type: 'message', payload: 'hi' });
    expect((await store.message.findById(msg.id))!.status).toBe('sent');
  });

  it('gives up on an approved send after too many failures instead of retrying forever', async () => {
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    const p = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.target.setStage(TGT, 'connected');
    await store.sequence.advanceTargetProgress(p.id, {
      state: 'awaiting_approval',
      nextStepAt: null,
    });
    const req: ActRequest = {
      type: 'message',
      accountId: ACCT,
      targetId: TGT,
      campaignId: CAMP,
      payload: 'hi',
    };
    const msg = await store.message.create({
      accountId: ACCT,
      targetId: TGT,
      direction: 'outbound',
      body: 'hi',
      threadRef: `pending:${ACCT}:${TGT}`,
      status: 'approved',
      pendingReq: req as unknown as Json,
    });
    // Five prior failed sends for this target: the recipient overlay never matches.
    for (let i = 0; i < 5; i++) {
      await store.action.create({
        accountId: ACCT,
        targetId: TGT,
        campaignId: CAMP,
        type: 'message',
        scheduledAt: NOW,
        executedAt: NOW,
        result: 'failed',
        dedupKey: `fail-${i}`,
      });
    }

    const executor = new RecordingExecutor();
    const events: string[] = [];
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      actions: store.action,
      gate: makeGate(executor, { kind: 'allow' }),
      log: {
        async recordEvent(kind: string) {
          events.push(kind);
          return undefined;
        },
      },
    });

    const res = await tick.runTick(NOW);

    expect(executor.calls).toHaveLength(0); // no 6th live send attempt
    expect((await store.message.findById(msg.id))!.status).toBe('cancelled');
    expect(res.outcomes[0]).toMatchObject({ kind: 'cancelled', reason: 'send_failed_exhausted' });
    expect(events).toContain('approved_send_exhausted');
    // The cursor is marked FAILED (honest), not 'replied' — the send was
    // abandoned, the person did not reply.
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('failed');
  });

  it('does not pre-draft (or execute early) an upcoming message on an autonomous campaign', async () => {
    // Autonomous executes messages directly: an early step() call would SEND
    // now, so the pre-draft pass must skip it and leave due-time behavior.
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    const p = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.target.setStage(TGT, 'connected');
    await store.sequence.advanceTargetProgress(p.id, { nextStepAt: FUTURE });

    const executor = new RecordingExecutor();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor, { kind: 'allow' }), // autonomous
    });

    const res = await tick.runTick(NOW);

    expect(executor.calls).toHaveLength(0); // never sent early
    expect(res.outcomes).toHaveLength(0); // never even stepped
    let [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('in_progress');
    expect(after.nextStepAt?.getTime()).toBe(FUTURE.getTime());

    // At the due time the normal due path executes it.
    await tick.runTick(FUTURE);
    expect(executor.calls).toHaveLength(1);
    [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('completed');
  });

  it('leaves an upcoming connect-step cursor untouched (staggered invites never fire early)', async () => {
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'hello',
    });
    const p = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(p.id, { nextStepAt: FUTURE });

    const executor = new RecordingExecutor();
    const enqueued: Array<{ req: ActRequest; draftBody?: string }> = [];
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeSupervisedGate(executor, enqueued),
    });

    const res = await tick.runTick(NOW);

    expect(executor.calls).toHaveLength(0);
    expect(enqueued).toHaveLength(0); // not drafted early
    expect(res.outcomes).toHaveLength(0);
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('in_progress');
    expect(after.currentStep).toBe(0);
    expect(after.nextStepAt?.getTime()).toBe(FUTURE.getTime());
  });
});
