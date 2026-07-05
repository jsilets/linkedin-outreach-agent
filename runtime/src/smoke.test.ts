// Smoke test: proves the WIRED system connects end to end, not just compiles.
// Same scenario as the runnable smoke.ts, asserted with vitest.

import { describe, expect, it } from 'vitest';
import { runSmoke } from './smoke-scenario.js';

describe('@loa/runtime end-to-end smoke', () => {
  it('drives account -> campaign -> target -> loop -> approval -> send -> reply', async () => {
    const t = await runSmoke();

    // No assertion in the scenario failed.
    expect(t.failures).toEqual([]);

    // The human gate held: the send was a draft until approved, then sent.
    expect(t.sendPendingRef).not.toBe('');
    expect(t.sendMessageStatus).toBe('sent');
    expect(t.approvedActionId).not.toBe('');

    // The inbound reply was classified and a reply queued (not auto-sent).
    expect(t.replyIntent).not.toBeNull();
    expect(t.replyPendingRef).not.toBe('');
    expect(t.replyMessageStatus).toBe('draft');

    // Append-only events exist for the key transitions.
    for (const kind of [
      'campaign_created',
      'targets_added',
      'personalized',
      'pending_enqueued',
      'approval_decided',
      'action_executed',
      'classified',
    ]) {
      expect(t.eventKinds).toContain(kind);
    }
  });
});
