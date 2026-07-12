// The shared removal decision both the runtime and web remove paths apply.
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_TARGET_REMOVAL_REASON,
  planCampaignTargetRemoval,
  wasTargetContacted,
} from './campaign-removal.js';

describe('planCampaignTargetRemoval', () => {
  it('marks only contacted targets lost and leaves pre-contact stages alone', () => {
    const plan = planCampaignTargetRemoval('camp-1', [
      { id: 't-sourced', linkedinUrn: 'urn:a', stage: 'sourced' },
      { id: 't-queued', linkedinUrn: 'urn:b', stage: 'queued' },
      { id: 't-invited', linkedinUrn: 'urn:c', stage: 'invited' },
      { id: 't-won', linkedinUrn: 'urn:d', stage: 'won' },
    ]);
    // Only the contacted stages (invited, won) land in lostTargetIds.
    expect(plan.lostTargetIds).toEqual(['t-invited', 't-won']);
    // Every target still gets a decision + event, in input order.
    expect(plan.decisions.map((d) => d.targetId)).toEqual([
      't-sourced',
      't-queued',
      't-invited',
      't-won',
    ]);
    expect(plan.decisions.map((d) => d.wasContacted)).toEqual([false, false, true, true]);
  });

  it('defaults the reason and stamps it on every event', () => {
    const plan = planCampaignTargetRemoval('camp-1', [
      { id: 't-1', linkedinUrn: 'urn:a', stage: 'invited' },
    ]);
    expect(plan.reason).toBe(CAMPAIGN_TARGET_REMOVAL_REASON);
    expect(plan.events).toEqual([
      {
        kind: 'target_removed',
        accountId: null,
        payload: {
          campaignId: 'camp-1',
          targetId: 't-1',
          linkedinUrn: 'urn:a',
          reason: CAMPAIGN_TARGET_REMOVAL_REASON,
          wasContacted: true,
        },
      },
    ]);
  });

  it('carries a caller-supplied reason through to cursors and events', () => {
    const plan = planCampaignTargetRemoval(
      'camp-1',
      [{ id: 't-1', linkedinUrn: 'urn:a', stage: 'sourced' }],
      'off-ICP',
    );
    expect(plan.reason).toBe('off-ICP');
    expect(plan.events[0]!.payload.reason).toBe('off-ICP');
    expect(plan.events[0]!.payload.wasContacted).toBe(false);
  });

  it('is empty for an empty target set', () => {
    const plan = planCampaignTargetRemoval('camp-1', []);
    expect(plan.decisions).toEqual([]);
    expect(plan.lostTargetIds).toEqual([]);
    expect(plan.events).toEqual([]);
  });

  it('wasTargetContacted matches the contacted-stage list', () => {
    expect(wasTargetContacted('invited')).toBe(true);
    expect(wasTargetContacted('connected')).toBe(true);
    expect(wasTargetContacted('sourced')).toBe(false);
    expect(wasTargetContacted('queued')).toBe(false);
  });
});
