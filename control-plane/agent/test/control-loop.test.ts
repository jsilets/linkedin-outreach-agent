import { describe, expect, it } from 'vitest';
import {
  initialState,
  runToStop,
  type LoopPorts,
} from '../src/index.js';
import {
  FakeExecutor,
  FakeLLM,
  FakePersistence,
  FakeSafety,
  FakeScheduler,
  fakeAccount,
  fakeCampaign,
  fakeTarget,
} from './fakes.js';

function ports(overrides: Partial<LoopPorts> = {}): {
  ports: LoopPorts;
  safety: FakeSafety;
  executor: FakeExecutor;
  persistence: FakePersistence;
  scheduler: FakeScheduler;
  llm: FakeLLM;
} {
  const safety = (overrides.safety as FakeSafety) ?? new FakeSafety();
  const executor = (overrides.executor as FakeExecutor) ?? new FakeExecutor();
  const persistence = (overrides.persistence as FakePersistence) ?? new FakePersistence();
  const scheduler = (overrides.scheduler as FakeScheduler) ?? new FakeScheduler();
  const llm = (overrides.llm as FakeLLM) ?? new FakeLLM();
  return {
    ports: { safety, executor, scheduler, persistence, llm },
    safety,
    executor,
    persistence,
    scheduler,
    llm,
  };
}

const ctx = () => ({ account: fakeAccount(), campaign: fakeCampaign(), target: fakeTarget() });

describe('control loop under supervised autonomy', () => {
  it('stops at the human gate for a send and never auto-acts', async () => {
    const { ports: p, executor, persistence, safety } = ports();
    const end = await runToStop(initialState(ctx()), p);

    expect(end.phase).toBe('awaiting_approval');
    // A pending send was enqueued; nothing was sent through the executor.
    expect(persistence.pendingSends).toHaveLength(1);
    expect(executor.acted).toHaveLength(0);
    expect(end.pendingRefs).toHaveLength(1);
    // Safety was consulted before the (gated) act.
    expect(safety.calls).toHaveLength(1);
  });

  it('defers when safety says defer, surfacing the retry time', async () => {
    const until = new Date('2026-07-06T09:00:00Z');
    const safety = new FakeSafety({ kind: 'defer', until });
    const { ports: p, persistence } = ports({ safety });
    const end = await runToStop(initialState(ctx()), p);

    expect(end.phase).toBe('deferred');
    expect(end.deferUntil).toEqual(until);
    expect(persistence.pendingSends).toHaveLength(0);
  });

  it('does nothing for a suppressed target', async () => {
    const persistence = new FakePersistence(['tgt-1']);
    const { ports: p } = ports({ persistence });
    const end = await runToStop(initialState(ctx()), p);

    expect(end.phase).toBe('suppressed');
    expect(persistence.pendingSends).toHaveLength(0);
  });

  it('ingests, classifies, and drafts a reply behind the gate when inbound exists', async () => {
    const executor = new FakeExecutor([
      { threadRef: 'thread-1', body: 'yes lets talk', accountId: 'acct-1', targetId: 'tgt-1' },
    ]);
    const llm = new FakeLLM({ intent: 'Interested', reply: 'Great, how is Tuesday?' });
    const { ports: p, persistence } = ports({ executor, llm });
    const end = await runToStop(initialState(ctx()), p);

    expect(end.phase).toBe('awaiting_approval');
    // Inbound persisted, classified, and a reply queued for approval (not sent).
    expect(persistence.inbound).toHaveLength(1);
    expect(llm.classified).toHaveLength(1);
    expect(persistence.pendingReplies).toHaveLength(1);
    expect(persistence.pendingSends).toHaveLength(0);
    const kinds = persistence.events.map((e) => e.kind);
    expect(kinds).toContain('classified');
    expect(kinds).toContain('pending_reply_enqueued');
  });
});
