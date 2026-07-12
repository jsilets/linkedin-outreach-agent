// Send-safety guard tests for the dispatch tick: the approve-once send path and
// the sequence message/connect steps must never fire against someone who replied,
// was suppressed, or went terminal. These exercise the tick against the in-memory
// store with a controllable gate, plus fake suppression + reply-probe seams.

import type { ActRequest, ExecutorPort, GateDeps } from '@loa/mcp';
import type { Account, Action, Campaign, Decision, Json, db as shared } from '@loa/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { DispatchTick, type SendTimeReplyCheck } from './tick.js';

type TargetRow = shared.TargetRow;

const ACCT = 'acct-1';
const CAMP = 'camp-1';
const TGT = 'tgt-1';

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
    autonomyLevel: 'autonomous', // direct execute, no queue
    messageStrategy: 's',
    owner: 'o',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** GateDeps whose safety allows every act and whose approval enqueue throws (the
 * autonomous path never queues). */
function makeGate(executor: ExecutorPort): GateDeps {
  const decision: Decision = { kind: 'allow' };
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
        throw new Error('enqueue should not be called on the autonomous path');
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
 * queues to approval (draft creation) instead of executing. */
function makeSupervisedGate(executor: ExecutorPort): GateDeps {
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
      async enqueue(req) {
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

/** A suppression port with a fixed answer, recording the ids it was asked about. */
class FakeSuppression {
  readonly asked: string[] = [];
  constructor(private readonly suppressed: boolean) {}
  async isSuppressed(targetId: string): Promise<boolean> {
    this.asked.push(targetId);
    return this.suppressed;
  }
}

/** A reply probe that either returns a fixed answer or throws. On a true answer
 * it pulls the target from the funnel, exactly as the real ReplyTick probe does
 * when it routes a reply. */
class FakeReplyProbe implements SendTimeReplyCheck {
  readonly calls: Array<{ accountId: string; targetId: string; since: Date | null }> = [];
  constructor(
    private readonly store: InMemoryStore,
    private readonly mode: 'reply' | 'none' | 'throw',
  ) {}
  async check(accountId: string, target: TargetRow, since: Date | null): Promise<boolean> {
    this.calls.push({ accountId, targetId: target.id, since });
    if (this.mode === 'throw') throw new Error('inbox read failed');
    if (this.mode === 'reply') {
      await this.store.sequence.pullTargetFromFunnel(target.id, 'reply');
      return true;
    }
    return false;
  }
}

/** Captures fire-and-forget audit events the tick records. */
class FakeLog {
  readonly events: Array<{ kind: string; accountId: string | null; payload: Json }> = [];
  async recordEvent(kind: string, accountId: string | null, payload: Json): Promise<unknown> {
    this.events.push({ kind, accountId, payload });
    return { id: 'e', ts: new Date() };
  }
}

// --- fixtures ---------------------------------------------------------------

async function seedTarget(store: InMemoryStore, stage: TargetRow['stage']): Promise<void> {
  await store.target.create({
    id: TGT,
    campaignId: CAMP,
    prospectRef: 'p1',
    linkedinUrn: 'urn:li:person:p1',
    externalContext: {},
    stage,
  });
}

function messageReq(): ActRequest {
  return { type: 'message', accountId: ACCT, targetId: TGT, campaignId: CAMP, payload: 'hi there' };
}

function connectReq(): ActRequest {
  return {
    type: 'connect',
    accountId: ACCT,
    targetId: TGT,
    campaignId: CAMP,
    payload: 'let us connect',
  };
}

/** Create an approved-but-unsent outbound message bound to an ActRequest, the
 * exact shape the dispatch tick's send-approved path reads. */
async function approvedMessage(store: InMemoryStore, req: ActRequest): Promise<shared.MessageRow> {
  const row = await store.message.create({
    accountId: ACCT,
    targetId: TGT,
    direction: 'outbound',
    body: req.type === 'message' ? String(req.payload) : 'note',
    threadRef: `pending:${ACCT}:${TGT}`,
    status: 'approved',
    pendingReq: req as unknown as Json,
  });
  return row;
}

// --- tests ------------------------------------------------------------------

describe('DispatchTick send-safety — approved send guards', () => {
  let store: InMemoryStore;
  let executor: RecordingExecutor;

  beforeEach(async () => {
    store = new InMemoryStore();
    executor = new RecordingExecutor();
  });

  it('a lead reply (pullTargetFromFunnel) cancels the approved message; the tick does not send', async () => {
    await seedTarget(store, 'connected');
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
    const msg = await approvedMessage(store, messageReq());

    // The lead replies: the reply router pulls the funnel, which cancels the
    // approved outbound message.
    await store.sequence.pullTargetFromFunnel(TGT, 'reply');
    expect((await store.message.findById(msg.id))!.status).toBe('cancelled');

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0); // nothing sent
    expect((await store.message.findById(msg.id))!.status).toBe('cancelled');
    expect(res.outcomes).toHaveLength(0); // cancelled messages are not in listApproved
  });

  it('a progress already in replied cancels the approved message pre-send', async () => {
    await seedTarget(store, 'connected');
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    // Force the progress terminal without touching the message (guard-only path).
    await store.sequence.advanceTargetProgress(prog.id, { state: 'replied' });
    const msg = await approvedMessage(store, messageReq());

    const log = new FakeLog();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      log,
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect((await store.message.findById(msg.id))!.status).toBe('cancelled');
    expect(res.outcomes[0]).toMatchObject({
      kind: 'cancelled',
      reason: 'replied',
      messageId: msg.id,
    });
    expect(log.events.map((e) => e.kind)).toContain('approved_send_cancelled');
  });

  it('a suppressed target cancels the approved send', async () => {
    await seedTarget(store, 'connected');
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
    const msg = await approvedMessage(store, messageReq());

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      suppression: new FakeSuppression(true),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect((await store.message.findById(msg.id))!.status).toBe('cancelled');
    expect(res.outcomes[0]).toMatchObject({ kind: 'cancelled', reason: 'suppressed' });
  });

  it('a wired reply probe that finds a reply holds the send (no execute) and the probe routes it', async () => {
    await seedTarget(store, 'connected');
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
    const msg = await approvedMessage(store, messageReq());

    const probe = new FakeReplyProbe(store, 'reply');
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      replyProbe: probe,
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0); // not sent
    expect(probe.calls).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'replied' });
    // The probe routed the reply, pulling the funnel (and cancelling the message).
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');
    expect((await store.message.findById(msg.id))!.status).toBe('cancelled');
  });

  it('a throwing reply probe fails closed: the message stays approved for retry', async () => {
    await seedTarget(store, 'connected');
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
    const msg = await approvedMessage(store, messageReq());

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      replyProbe: new FakeReplyProbe(store, 'throw'),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0); // fail closed: no send
    expect((await store.message.findById(msg.id))!.status).toBe('approved'); // intact for retry
    expect(res.outcomes).toHaveLength(0); // returned undefined, not surfaced
  });

  it('an approved connect executes then parks awaiting_connection (does not advance past connect)', async () => {
    await seedTarget(store, 'queued');
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'let us connect',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 1,
      stepType: 'message',
      body: 'follow',
    });
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_approval' });
    const msg = await approvedMessage(store, connectReq());

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ type: 'connect' });
    expect((await store.message.findById(msg.id))!.status).toBe('sent');
    expect((await store.target.findById(TGT))!.stage).toBe('invited');
    const after = (await store.sequence.getTargetProgressByTarget(TGT))!;
    expect(after.state).toBe('awaiting_connection');
    expect(after.currentStep).toBe(0); // still ON the connect step for the acceptance tick
    expect(res.outcomes[0]).toMatchObject({ kind: 'awaiting_connection' });
  });
});

describe('DispatchTick send-safety — sequence step guards', () => {
  let store: InMemoryStore;
  let executor: RecordingExecutor;

  beforeEach(() => {
    store = new InMemoryStore();
    executor = new RecordingExecutor();
  });

  it('a message step whose target is past connected pulls the target from the funnel', async () => {
    await seedTarget(store, 'in_conversation'); // human owns the thread
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0); // no send
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'stage_in_conversation' });
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied'); // pulled
  });

  it('a suppressed message step pulls the target from the funnel', async () => {
    await seedTarget(store, 'connected');
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      suppression: new FakeSuppression(true),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'suppressed' });
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');
  });

  it('a suppressed connect step pulls the target from the funnel', async () => {
    await seedTarget(store, 'queued');
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'connect',
      note: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      suppression: new FakeSuppression(true),
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'suppressed' });
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');
  });

  it('a message step reply probe that finds a reply holds and pulls the funnel', async () => {
    await seedTarget(store, 'connected');
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const probe = new FakeReplyProbe(store, 'reply');
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor),
      replyProbe: probe,
    });
    const res = await tick.runTick(new Date());

    expect(executor.calls).toHaveLength(0);
    expect(probe.calls).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'replied' });
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');
  });

  it('a message step reply probe that throws still creates the draft (draft-first, not held)', async () => {
    // A BROKEN reply lane must not freeze drafting: the probe throw is logged
    // (reply_probe_failed) but the step PROCEEDS to the gate, which queues the
    // draft awaiting_approval. The real send is separately fail-closed by the
    // send-time probe (see 'a throwing reply probe fails closed' above).
    await seedTarget(store, 'connected');
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const log = new FakeLog();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeSupervisedGate(executor),
      replyProbe: new FakeReplyProbe(store, 'throw'),
      log,
    });
    const res = await tick.runTick(new Date());

    // The throw was surfaced as an event, and the step proceeded to a queued draft.
    expect(log.events.map((e) => e.kind)).toContain('reply_probe_failed');
    expect(executor.calls).toHaveLength(0); // supervised: queued, not sent
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'queued' });
    const after = (await store.sequence.getTargetProgressByTarget(TGT))!;
    expect(after.state).toBe('awaiting_approval'); // parked as a draft, not left due
  });

  it('an AUTONOMOUS message step with a throwing probe stays fail-closed (held, no send)', async () => {
    // Draft-first only applies when a human gate sits between drafting and the
    // send. Under autonomous autonomy the gate executes immediately and no
    // send-time re-probe runs, so proceeding on a broken reply lane would send.
    // The step must hold exactly like the old behavior.
    await seedTarget(store, 'connected');
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'hi',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    const log = new FakeLog();
    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate: makeGate(executor), // autonomous: direct execute, no queue
      replyProbe: new FakeReplyProbe(store, 'throw'),
      log,
    });
    const res = await tick.runTick(new Date());

    expect(log.events.map((e) => e.kind)).toContain('reply_probe_failed');
    expect(executor.calls).toHaveLength(0); // nothing sent on a broken lane
    expect(res.outcomes[0]).toMatchObject({ kind: 'held', reason: 'reply_probe_failed' });
    const after = (await store.sequence.getTargetProgressByTarget(TGT))!;
    expect(after.state).toBe('in_progress'); // cursor left due for a later retry
  });

  it('personalizes {First}/{Company} in the queued draft so the operator reads real text', async () => {
    await store.target.create({
      id: TGT,
      campaignId: CAMP,
      prospectRef: 'p1',
      linkedinUrn: 'urn:li:person:p1',
      externalContext: { name: 'Kenney Tran', currentCompany: 'Globex' },
      stage: 'connected',
    });
    await store.sequence.upsertCampaignStep({
      campaignId: CAMP,
      stepOrder: 0,
      stepType: 'message',
      body: 'Hi {First}, how is {Company}?',
    });
    await store.sequence.enrollTarget(CAMP, TGT, ACCT);

    // A supervised gate that captures the draft body handed to approval.enqueue.
    let capturedDraft: string | undefined;
    const gate = makeSupervisedGate(executor);
    gate.approval.enqueue = async (req, level, draftBody) => {
      capturedDraft = draftBody;
      return { id: 'pending-1', req, autonomyLevel: level, createdAt: new Date() };
    };

    const tick = new DispatchTick({
      sequence: store.sequence,
      targets: store.target,
      messages: store.message,
      gate,
    });
    await tick.runTick(new Date());

    expect(capturedDraft).toBe('Hi Kenney, how is Globex?');
  });
});
