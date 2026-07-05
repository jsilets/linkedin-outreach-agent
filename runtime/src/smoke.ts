// Runnable smoke script: node --import tsx runtime/src/smoke.ts (or npm run
// smoke from the repo root). Drives the wired end-to-end scenario and prints a
// clear PASS/FAIL with the campaign/approval/event trace. Exit code is nonzero
// on any assertion failure.

import { runSmoke } from './smoke-scenario.js';

async function main(): Promise<void> {
  const t = await runSmoke();

  console.log('=== @loa/runtime smoke ===');
  console.log(`account:        ${t.accountId}`);
  console.log(`campaign:       ${t.campaignId} (supervised)`);
  console.log(`target:         ${t.targetId}`);
  console.log('');
  console.log('1) loop run -> personalized send queued for approval (human gate)');
  console.log(`   pending send ref:   ${t.sendPendingRef}`);
  console.log('2) operator approves -> dispatched via fake executor');
  console.log(`   dispatched action:  ${t.approvedActionId}`);
  console.log(`   send message status: ${t.sendMessageStatus}`);
  console.log('3) inbound reply fed -> classified + reply drafted (not auto-sent)');
  console.log(`   classified intent:   ${t.replyIntent}`);
  console.log(`   pending reply ref:   ${t.replyPendingRef}`);
  console.log(`   reply message status: ${t.replyMessageStatus}`);
  console.log('');
  console.log(`event trace (${t.eventKinds.length}): ${t.eventKinds.join(', ')}`);
  console.log('');

  if (t.failures.length === 0) {
    console.log('SMOKE PASS: ports connect end to end; human gate held; events append-only.');
    process.exit(0);
  }
  console.error(`SMOKE FAIL (${t.failures.length}):`);
  for (const f of t.failures) console.error(`  - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
