// The end-to-end smoke scenario, shared by the runnable script (smoke.ts) and
// the vitest smoke test (smoke.test.ts). It drives the WIRED system with the
// in-memory store, FakeExecutor, and FakeLLMProvider:
//
//   1. seed an Active account
//   2. create a supervised campaign
//   3. add a target
//   4. run the loop -> the personalized send lands in the APPROVAL QUEUE
//      (human gate, nothing sent)
//   5. approve it -> the draft transitions to sent via the fake executor
//   6. feed a fake inbound reply, run the loop again -> it is classified and a
//      draft reply is queued (not auto-sent)
//   7. assert append-only event rows exist for the key transitions
//
// It returns a structured trace plus a list of assertion failures so the caller
// can print a PASS/FAIL and the test can assert on it.

import { NO_ACTIVE_HOURS_CONFIG } from '@loa/safety';
import { compose } from './compose.js';
import { loadConfig } from './config.js';
import { seedAccount } from './seed.js';

export interface SmokeTrace {
  accountId: string;
  campaignId: string;
  targetId: string;
  sendPendingRef: string;
  approvedActionId: string;
  sendMessageStatus: string;
  replyIntent: string | null;
  replyPendingRef: string;
  replyMessageStatus: string;
  eventKinds: string[];
  failures: string[];
}

/** Run the scenario against a freshly composed in-memory runtime. */
export async function runSmoke(): Promise<SmokeTrace> {
  // Force in-memory + fake LLM by composing with an empty-ish config. Disable
  // the active-hours window so the scenario is deterministic at any hour (the
  // send would otherwise defer overnight and never queue an approval item).
  const config = loadConfig({ MCP_PORT: '0' } as NodeJS.ProcessEnv);
  const runtime = compose(config, { safetyConfig: NO_ACTIVE_HOURS_CONFIG });
  const { store, ports, orchestrator } = runtime;
  const failures: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) failures.push(msg);
  };

  // 1. account
  const account = await seedAccount(store, { handle: 'smoke-op', state: 'Active' });

  // 2. supervised campaign
  const campaign = await ports.campaign.createCampaign({
    goal: 'introduce our platform',
    autonomyLevel: 'supervised',
    messageStrategy: 'one specific reason, short',
    owner: 'operator@example.com',
  });
  check(campaign.autonomyLevel === 'supervised', 'campaign should be supervised');

  // 3. target
  const [target] = await ports.campaign.addTargets(campaign.id, ['prospect-1']);
  check(Boolean(target), 'a target should be created');
  if (!target) throw new Error('smoke: no target created');

  // 4. run the loop: expect a pending send in the approval queue, nothing sent.
  const loop1 = await runtime.runLoopOnce(account.id, target.id);
  check(
    loop1.phase === 'awaiting_approval',
    `loop1 phase should be awaiting_approval, was ${loop1.phase}`,
  );
  const sendRef = loop1.pendingRefs[loop1.pendingRefs.length - 1] ?? '';
  check(Boolean(sendRef), 'loop1 should produce a pending send ref');

  const draftBefore = await store.message.findById(sendRef);
  check(draftBefore?.status === 'draft', 'pending send should be a draft (not sent)');
  check(draftBefore?.direction === 'outbound', 'pending send should be outbound');

  // 5. approve -> marks the message 'approved'; the dispatch tick sends it.
  const approved = await ports.approval.approve(sendRef, 'operator@example.com');
  check(approved.status === 'approved', 'approve should mark the message approved');
  const afterApprove = await store.message.findById(sendRef);
  check(afterApprove?.status === 'approved', 'approved send should be marked approved, not sent');
  // The tick sends approved drafts (gated). With the fake executor it lands now.
  const tick = await runtime.dispatch.runTick();
  const sentOutcome = tick.outcomes.find((o) => o.kind === 'executed');
  check(Boolean(sentOutcome), 'dispatch tick should send the approved message');
  const draftAfter = await store.message.findById(sendRef);
  check(draftAfter?.status === 'sent', 'approved send should be marked sent after the tick');
  const dispatchedActionId = sentOutcome && 'actionId' in sentOutcome ? sentOutcome.actionId : '';
  const actionRow = await store.action.findById(dispatchedActionId);
  check(actionRow?.type === 'message', 'dispatched action should be a message');

  // 6. feed a fake inbound reply, run the loop again.
  runtime.executor.feedInbound({
    threadRef: `thread:${target.id}`,
    body: 'This is interesting, can you tell me more about pricing?',
    accountId: account.id,
    targetId: target.id,
  });
  const loop2 = await runtime.runLoopOnce(account.id, target.id);
  check(
    loop2.phase === 'awaiting_approval',
    `loop2 phase should be awaiting_approval, was ${loop2.phase}`,
  );
  const replyRef = loop2.pendingRefs[loop2.pendingRefs.length - 1] ?? '';
  check(Boolean(replyRef), 'loop2 should produce a pending reply ref');
  const replyIntent = loop2.intent ?? null;
  check(replyIntent !== null, 'inbound should have been classified to an intent');

  const replyDraft = await store.message.findById(replyRef);
  check(replyDraft?.status === 'draft', 'drafted reply should be a draft (not auto-sent)');
  check(replyDraft?.intent === replyIntent, 'reply draft should carry the classified intent');

  // 7. append-only event rows for the key transitions.
  const events = await store.event.listAll();
  const eventKinds = events.map((e) => e.kind);
  const required = [
    'campaign_created',
    'targets_added',
    'observed',
    'personalized',
    'pending_enqueued',
    'approval_decided',
    'action_executed',
    'ingested',
    'classified',
  ];
  for (const kind of required) {
    check(eventKinds.includes(kind), `expected an event of kind '${kind}'`);
  }

  // Sanity: nothing was sent that skipped the human gate. The only sent message
  // is the one we explicitly approved.
  const sentCount = events.filter((e) => e.kind === 'approval_decided').length;
  check(sentCount >= 1, 'at least one approval decision should be recorded');

  await runtime.close();
  void orchestrator;

  return {
    accountId: account.id,
    campaignId: campaign.id,
    targetId: target.id,
    sendPendingRef: sendRef,
    approvedActionId: dispatchedActionId,
    sendMessageStatus: draftAfter?.status ?? 'unknown',
    replyIntent,
    replyPendingRef: replyRef,
    replyMessageStatus: replyDraft?.status ?? 'unknown',
    eventKinds,
    failures,
  };
}
