// Reply-tick unit tests. They exercise the tick against the in-memory store and
// the SAME orchestrator wiring the runtime composes (makeOrchestratorServices,
// with store.sequence passed to the ReplyRouter), plus fakes for the two live
// seams the tick cannot run offline: the inbox reader and the LLM classifier.
//
// Covered: an inbound reply from an enrolled target is classified and routed,
// pulling the target out of the funnel; a sender that is not an enrolled target
// is left alone; an already-seen message is not re-routed on the next tick; only
// the newest message in a thread routes, while older ones still reach the
// transcript.

import type { SchedulerLikePort } from '@loa/orchestrator';
import type { Intent, LLMProvider, Message } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import type { InboundMessage, InboxReaderPort, InboxThread } from '../adapters/observe-live.js';
import { makeOrchestratorServices } from '../adapters/orchestrator.js';
import { InMemoryStore } from '../store/in-memory-store.js';
import { type ReplyOutcome, type ReplyScan, ReplyTick } from './reply-tick.js';

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

/** Represents the real history lane: the mailbox row's newest event is ours,
 * but the conversation detail still contains the prospect's older reply. */
class HistoryInbox implements InboxReaderPort {
  readonly historyCalls: string[] = [];
  constructor(private readonly history: InboundMessage[]) {}
  async readInbox(): Promise<InboundMessage[]> {
    return [];
  }
  async readThreads(): Promise<InboxThread[]> {
    return [{ threadUrn: 'urn:li:msg_conversation:t1', participantUrn: 'urn:li:person:p1' }];
  }
  async readThreadHistory(_accountId: string, threadUrn: string): Promise<InboundMessage[]> {
    this.historyCalls.push(threadUrn);
    return this.history;
  }
}

/** Classifies each message by its body, so one thread can carry two intents. */
class ScriptedLLM implements Partial<LLMProvider> {
  readonly seen: Message[] = [];
  constructor(private readonly byBody: Record<string, Intent>) {}
  async classifyReply(msg: Message): Promise<Intent> {
    this.seen.push(msg);
    const intent = this.byBody[msg.body];
    if (!intent) throw new Error(`no scripted intent for: ${msg.body}`);
    return intent;
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
      messages: store.message,
    });

    const res = await tick.runTick();

    expect(res.accounts).toBe(1);
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ kind: 'routed', targetId: TGT, intent: 'Interested' });
    // The classifier saw the inbound body.
    expect(fakeLlm.seen.map((m) => m.body)).toEqual(['sure, happy to chat']);
    // The exact observed inbound is retained in the local message history for
    // the unified inbox, independently of the funnel state change.
    const recorded = await store.message.listByThread('urn:li:msg_conversation:t1');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ direction: 'inbound', body: 'sure, happy to chat' });
    expect(recorded[0]!.createdAt).toEqual(new Date('2026-07-06T12:00:00Z'));
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

  it('uses mapped thread history when a later outbound hides the prospect reply in the inbox list', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);
    const target = (await store.target.findById(TGT))!;
    const inbox = new HistoryInbox([inbound({ receivedAt: new Date('2026-07-06T12:00:00Z') })]);
    const tick = new ReplyTick({
      inbox,
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('Interested'),
      messages: store.message,
    });

    // The prospect reply predates the human's later outbound, but it is still
    // enough to block a newly due automated message.
    expect(await tick.probeTarget(ACCT, target, new Date('2026-07-06T13:00:00Z'))).toBe(true);
    expect(inbox.historyCalls).toEqual(['urn:li:msg_conversation:t1']);
    expect((await store.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');

    // The periodic sweep uses the identical history lane, not a latest-message
    // snippet, so a fresh tick also observes the same reply.
    const store2 = new InMemoryStore();
    await seedEnrolledTarget(store2);
    const orchestrator2 = makeOrchestratorServices(store2, noopScheduler);
    const tick2 = new ReplyTick({
      inbox: new HistoryInbox([inbound()]),
      enrollments: activeEnrollments(store2),
      targets: store2.target,
      router: orchestrator2.replyRouter,
      llm: llm('Interested'),
    });
    const result = await tick2.runTick();
    expect(result.outcomes[0]).toMatchObject({ kind: 'routed', targetId: TGT });
    expect((await store2.sequence.getTargetProgressByTarget(TGT))!.state).toBe('replied');
  });

  it('routes only the newest message in a thread history, and records the rest', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const followUps: { targetId: string; reason: string }[] = [];
    const orchestrator = makeOrchestratorServices(store, {
      async enqueueFollowUp(input) {
        followUps.push({ targetId: input.targetId, reason: input.reason });
      },
    });

    // The prospect put us off, then changed their mind five minutes later. The
    // history read hands both back newest-first.
    const scriptedLlm = new ScriptedLLM({
      'not right now, ping me in Q3': 'NotNow',
      "actually, I'm interested": 'Interested',
    });
    const outcomes: ReplyOutcome[] = [];
    const tick = new ReplyTick({
      inbox: new HistoryInbox([
        inbound({ text: "actually, I'm interested", receivedAt: new Date('2026-07-06T10:05:00Z') }),
        inbound({
          text: 'not right now, ping me in Q3',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        }),
      ]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: scriptedLlm as unknown as LLMProvider,
      messages: store.message,
      onOutcome: (o) => outcomes.push(o),
    });

    await tick.runTick();

    // Only the newest message reached the classifier and the router, so the
    // stage is the one the prospect's latest message asked for.
    expect(scriptedLlm.seen.map((m) => m.body)).toEqual(["actually, I'm interested"]);
    expect((await store.target.findById(TGT))!.stage).toBe('in_conversation');
    // The stale NotNow does not get to schedule an automated ping at someone who
    // has since said they are interested.
    expect(followUps).toEqual([]);
    expect(outcomes).toEqual([
      { kind: 'recorded', targetId: TGT, threadUrn: 'urn:li:msg_conversation:t1' },
      {
        kind: 'routed',
        targetId: TGT,
        threadUrn: 'urn:li:msg_conversation:t1',
        intent: 'Interested',
      },
    ]);
    // Not routing the older message must not lose it: the transcript still holds
    // the whole conversation, in the order the prospect wrote it.
    const recorded = await store.message.listByThread('urn:li:msg_conversation:t1');
    expect(recorded.map((row) => row.body)).toEqual([
      'not right now, ping me in Q3',
      "actually, I'm interested",
    ]);
    expect(recorded.map((row) => row.createdAt)).toEqual([
      new Date('2026-07-06T10:00:00Z'),
      new Date('2026-07-06T10:05:00Z'),
    ]);
  });

  it('still enqueues the paced follow-up when the newest message is the NotNow', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const followUps: { targetId: string; reason: string }[] = [];
    const orchestrator = makeOrchestratorServices(store, {
      async enqueueFollowUp(input) {
        followUps.push({ targetId: input.targetId, reason: input.reason });
      },
    });

    const tick = new ReplyTick({
      inbox: new HistoryInbox([inbound({ text: 'not right now, ping me in Q3' })]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('NotNow'),
      messages: store.message,
    });

    await tick.runTick();

    expect((await store.target.findById(TGT))!.stage).toBe('replied');
    expect(followUps).toEqual([{ targetId: TGT, reason: 'not_now_followup' }]);
  });

  it('probeTarget reports a reply and routes only the newest of a thread history', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const followUps: { targetId: string; reason: string }[] = [];
    const orchestrator = makeOrchestratorServices(store, {
      async enqueueFollowUp(input) {
        followUps.push({ targetId: input.targetId, reason: input.reason });
      },
    });
    const target = (await store.target.findById(TGT))!;

    const scriptedLlm = new ScriptedLLM({
      'not right now, ping me in Q3': 'NotNow',
      "actually, I'm interested": 'Interested',
    });
    const tick = new ReplyTick({
      inbox: new HistoryInbox([
        inbound({ text: "actually, I'm interested", receivedAt: new Date('2026-07-06T10:05:00Z') }),
        inbound({
          text: 'not right now, ping me in Q3',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        }),
      ]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: scriptedLlm as unknown as LLMProvider,
      messages: store.message,
    });

    // Fail-closed: any inbound in the mapped thread blocks the due send, whether
    // or not it routed.
    expect(await tick.probeTarget(ACCT, target, null)).toBe(true);
    expect(scriptedLlm.seen.map((m) => m.body)).toEqual(["actually, I'm interested"]);
    expect(followUps).toEqual([]);
    const recorded = await store.message.listByThread('urn:li:msg_conversation:t1');
    expect(recorded.map((row) => row.body)).toEqual([
      'not right now, ping me in Q3',
      "actually, I'm interested",
    ]);
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

  it('reports completed scan coverage so an empty inbox is distinguishable from an unrun scan', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);
    const scans: ReplyScan[] = [];
    const tick = new ReplyTick({
      inbox: new HistoryInbox([inbound()]),
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('Interested'),
      onScan: (scan) => scans.push(scan),
    });

    await tick.runTick();

    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({
      kind: 'succeeded',
      accounts: 1,
      enrollments: 1,
      listedThreads: 1,
      mappedThreads: 1,
      unmatchedThreads: 0,
      historyReads: 1,
      routed: 1,
    });
  });

  it('reports a failed read with its phase instead of swallowing it as no replies', async () => {
    const store = new InMemoryStore();
    await seedEnrolledTarget(store);
    const orchestrator = makeOrchestratorServices(store, noopScheduler);
    const scans: ReplyScan[] = [];
    const tick = new ReplyTick({
      inbox: {
        readInbox: async () => {
          throw new Error('LinkedIn session expired');
        },
      },
      enrollments: activeEnrollments(store),
      targets: store.target,
      router: orchestrator.replyRouter,
      llm: llm('Interested'),
      onScan: (scan) => scans.push(scan),
    });

    await expect(tick.runTick()).rejects.toThrow('LinkedIn session expired');
    expect(scans).toEqual([
      expect.objectContaining({
        kind: 'failed',
        phase: 'inbox_list',
        accountId: ACCT,
        error: 'LinkedIn session expired',
      }),
    ]);
  });
});
