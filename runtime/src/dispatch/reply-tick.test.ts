// Reply-tick unit tests. They exercise the tick against the in-memory store and
// the SAME orchestrator wiring the runtime composes (makeOrchestratorServices,
// with store.sequence passed to the ReplyRouter), plus fakes for the two live
// seams the tick cannot run offline: the inbox reader and the LLM classifier.
//
// Covered: an inbound reply from an enrolled target is classified and routed,
// pulling the target out of the funnel; a sender that is not an enrolled target
// is left alone; an already-seen message is not re-routed on the next tick.

import { describe, expect, it } from 'vitest';
import type { Intent, LLMProvider, Message } from '@loa/shared';
import type { SchedulerLikePort } from '@loa/orchestrator';
import { InMemoryStore } from '../store/in-memory-store.js';
import { makeOrchestratorServices } from '../adapters/orchestrator.js';
import type { InboundMessage, InboxReaderPort } from '../adapters/observe-live.js';
import { ReplyTick } from './reply-tick.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';
const TGT = 'tgt-1';

const noopScheduler: SchedulerLikePort = {
  async enqueueFollowUp() {
    /* not used */
  },
};

// --- fakes ------------------------------------------------------------------

/** Returns a fixed inbound list once, then empty (so a second tick reads no new
 * messages unless configured otherwise). */
class FakeInbox implements InboxReaderPort {
  readonly calls: string[] = [];
  constructor(private readonly messages: InboundMessage[]) {}
  async readInbox(accountId: string): Promise<InboundMessage[]> {
    this.calls.push(accountId);
    return this.messages;
  }
}

/** Classifies every message as a fixed intent, and records what it saw. */
class FakeLLM implements Partial<LLMProvider> {
  readonly seen: Message[] = [];
  constructor(private readonly intent: Intent) {}
  async classifyReply(msg: Message): Promise<Intent> {
    this.seen.push(msg);
    return this.intent;
  }
}

function llm(intent: Intent): LLMProvider {
  return new FakeLLM(intent) as unknown as LLMProvider;
}

async function seedEnrolledTarget(store: InMemoryStore): Promise<void> {
  await store.target.create({
    id: TGT,
    campaignId: CAMP,
    prospectRef: 'p1',
    linkedinUrn: 'urn:li:person:p1',
    externalContext: {},
    stage: 'invited',
  });
  await store.sequence.enrollTarget(CAMP, TGT, ACCT);
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    threadUrn: 'urn:li:msg_conversation:t1',
    senderUrn: 'urn:li:person:p1', // matches the enrolled target's linkedinUrn
    text: 'sure, happy to chat',
    receivedAt: new Date('2026-07-06T12:00:00Z'),
    ...over,
  };
}

function activeEnrollments(store: InMemoryStore) {
  return { activeEnrollments: () => store.sequence.activeEnrollments() };
}

describe('ReplyTick', () => {
  it('classifies an enrolled prospect reply and pulls them out of the funnel', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);

    const fakeLlm = new FakeLLM('Interested');
    const tick = new ReplyTick({
      inbox: new FakeInbox([inbound()]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: fakeLlm as unknown as LLMProvider,
    });

    const res = await tick.runTick();

    expect(res.accounts).toBe(1);
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ kind: 'routed', targetId: TGT, intent: 'Interested' });
    // The classifier saw the inbound body.
    expect(fakeLlm.seen.map((m) => m.body)).toEqual(['sure, happy to chat']);
    // The target was pulled out of the funnel (terminal 'replied' progress).
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('replied');
    expect(after.errorMessage).toBe('reply');
    // No longer due, so the dispatch tick would skip it.
    expect(await store.sequence.dueTargetProgress(new Date())).toHaveLength(0);
  });

  it('leaves a message from a non-enrolled sender alone', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);

    const tick = new ReplyTick({
      inbox: new FakeInbox([inbound({ senderUrn: 'urn:li:person:stranger' })]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('Interested'),
    });

    const res = await tick.runTick();

    expect(res.outcomes[0]).toMatchObject({ kind: 'unmatched' });
    // Still enrolled and active — nothing was pulled out.
    const [after] = await store.sequence.listTargetProgress(CAMP);
    expect(after.state).toBe('in_progress');
  });

  it('routes a reply from a lead parked in awaiting_approval', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    // The lead is parked waiting on a human approval when it replies; the reply
    // tick must still see it (activeEnrollments covers awaiting_approval) and pull
    // it out of the funnel.
    const prog = await store.sequence.getTargetProgressByTarget(TGT);
    await store.sequence.advanceTargetProgress(prog!.id, { state: 'awaiting_approval' });
    const orchestrator = makeOrchestratorServices(store, noopScheduler);

    const tick = new ReplyTick({
      inbox: new FakeInbox([inbound()]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('Interested'),
    });

    const res = await tick.runTick();

    expect(res.outcomes[0]).toMatchObject({ kind: 'routed', targetId: TGT });
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');
  });

  it('probeTarget finds and routes a reply newer than since, and reports one exists', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);
    const target = (await store.target.findById(TGT))!;

    const tick = new ReplyTick({
      inbox: new FakeInbox([inbound({ receivedAt: new Date('2026-07-06T12:00:00Z') })]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('Interested'),
    });

    // A reply newer than `since` -> true, and it is routed (funnel pulled).
    const before = new Date('2026-07-06T11:00:00Z');
    expect(await tick.probeTarget(ACCT, target, before)).toBe(true);
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');

    // A `since` after the reply -> no newer reply -> false.
    const store2 = new InMemoryStore();
    await seedEnrolledTarget(store2);
    const orchestrator2 = makeOrchestratorServices(store2, noopScheduler);
    const target2 = (await store2.target.findById(TGT))!;
    const tick2 = new ReplyTick({
      inbox: new FakeInbox([inbound({ receivedAt: new Date('2026-07-06T12:00:00Z') })]),
      enrollments: activeEnrollments(store2),
      targets: store2.target,
      router: orchestrator2.replyRouter,
      llm: llm('Interested'),
    });
    const after = new Date('2026-07-06T13:00:00Z');
    expect(await tick2.probeTarget(ACCT, target2, after)).toBe(false);
    expect((await store2.sequence.getTargetProgressByTarget(TGT))!.state).toBe('in_progress');
  });

  it('routes a message once and marks a repeat of it as already-seen', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);

    // The inbox read returns the SAME message twice (LinkedIn surfaces it in the
    // thread and, e.g., an overlapping page). The seen-set must route it once
    // and report the duplicate as 'seen' rather than classifying/routing again.
    const fakeLlm = new FakeLLM('Interested');
    const tick = new ReplyTick({
      inbox: new FakeInbox([inbound(), inbound()]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: fakeLlm as unknown as LLMProvider,
    });

    const res = await tick.runTick();

    expect(res.outcomes[0]).toMatchObject({ kind: 'routed' });
    expect(res.outcomes[1]).toMatchObject({ kind: 'seen' });
    // Classified exactly once despite the duplicate.
    expect(fakeLlm.seen).toHaveLength(1);
  });
});
