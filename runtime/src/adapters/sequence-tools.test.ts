// Tests for the campaign-sequence MCP tools backed by CampaignAdapter: define
// (replace) the step template, read it back, and enroll targets. These only use
// store.sequence, so the orchestrator services are stubbed.

import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { CampaignAdapter } from './mcp-ports.js';
import type { OrchestratorServices } from './orchestrator.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';

const noServices = {} as unknown as OrchestratorServices;

describe('CampaignAdapter sequence surface', () => {
  let store: InMemoryStore;
  let campaign: CampaignAdapter;

  beforeEach(() => {
    store = new InMemoryStore();
    campaign = new CampaignAdapter(noServices, store);
  });

  it('defines an ordered sequence and reads it back', async () => {
    const steps = await campaign.defineCampaignSteps(CAMP, [
      { stepType: 'connect', note: 'hi' },
      { stepType: 'delay', delaySeconds: 172_800 },
      { stepType: 'message', body: 'thanks for connecting' },
    ]);
    expect(steps.map((s) => s.stepType)).toEqual(['connect', 'delay', 'message']);
    expect(steps.map((s) => s.stepOrder)).toEqual([0, 1, 2]);

    const read = await campaign.listCampaignSteps(CAMP);
    expect(read.map((s) => s.stepType)).toEqual(['connect', 'delay', 'message']);
  });

  it('replaces the whole template on a second define', async () => {
    await campaign.defineCampaignSteps(CAMP, [
      { stepType: 'connect' },
      { stepType: 'message', body: 'a' },
    ]);
    const replaced = await campaign.defineCampaignSteps(CAMP, [{ stepType: 'view_profile' }]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.stepType).toBe('view_profile');
    expect(await campaign.listCampaignSteps(CAMP)).toHaveLength(1);
  });

  it('rejects a delay step without a positive delay, without mutating', async () => {
    await campaign.defineCampaignSteps(CAMP, [{ stepType: 'connect' }]);
    await expect(
      campaign.defineCampaignSteps(CAMP, [{ stepType: 'delay', delaySeconds: 0 }]),
    ).rejects.toThrow(/delay step needs delaySeconds/);
    // The prior template is untouched.
    expect(await campaign.listCampaignSteps(CAMP)).toHaveLength(1);
  });

  it('rejects a message step without a body', async () => {
    await expect(
      campaign.defineCampaignSteps(CAMP, [{ stepType: 'message', body: '  ' }]),
    ).rejects.toThrow(/message step needs a non-empty body/);
  });

  it('enrolls targets idempotently under a sender account', async () => {
    const first = await campaign.enrollTargets(CAMP, ['t1', 't2'], ACCT);
    expect(first.enrolled).toBe(2);
    expect(first.progressIds).toHaveLength(2);

    // A target already enrolled returns its existing cursor (idempotent).
    const again = await campaign.enrollTargets(CAMP, ['t1'], ACCT);
    expect(again.progressIds[0]).toBe(first.progressIds[0]);

    const rows = await store.sequence.listTargetProgress(CAMP);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === 'in_progress' && r.accountId === ACCT)).toBe(true);
  });
});
