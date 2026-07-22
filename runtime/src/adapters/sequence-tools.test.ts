// Tests for the campaign-sequence MCP tools backed by CampaignAdapter: define
// (replace) the step template, read it back, and enroll targets (including the
// cap-driven nextStepAt stagger). These only use store.sequence and
// store.account, so the orchestrator services are stubbed.

import { DefaultSafetyGate } from '@loa/safety';
import { DEFAULT_SCHEDULE } from '@loa/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyEnricher, EnrichedCompany } from '../discovery/enrich.js';
import { dueAfterDelay } from '../dispatch/advance.js';
import { InMemoryStore } from '../store/in-memory-store.js';
import { CampaignAdapter } from './mcp-ports.js';
import type { OrchestratorServices } from './orchestrator.js';

const CAMP = 'camp-1';
const ACCT = 'acct-1';

const noServices = {} as unknown as OrchestratorServices;

describe('CampaignAdapter.addTargets mapping', () => {
  it('maps bare refs and search-result people to service inputs', async () => {
    const recorded: Array<{ prospectRef: string; linkedinUrn: string; externalContext?: unknown }> =
      [];
    const services = {
      campaigns: {
        async addTargets(_campaignId: string, inputs: typeof recorded) {
          recorded.push(...inputs);
          return inputs.map((i) => ({ id: `tgt-${i.prospectRef}`, ...i }));
        },
      },
    } as unknown as OrchestratorServices;
    const adapter = new CampaignAdapter(
      services,
      new InMemoryStore(),
      new DefaultSafetyGate({ allowMissingCounters: true }),
    );

    await adapter.addTargets(CAMP, [
      'manual-ref',
      {
        prospectRef: 'jane-doe',
        linkedinUrn: 'urn:li:fsd_profile:ABC123',
        profileUrl: 'https://www.linkedin.com/in/jane-doe/',
        name: 'Jane Doe',
        headline: 'Head of Ops',
      },
    ]);

    // Bare string: deterministic urn, no external context.
    expect(recorded[0]).toMatchObject({
      prospectRef: 'manual-ref',
      linkedinUrn: 'urn:li:person:manual-ref',
    });
    // Structured: real urn kept, extras land in external context.
    expect(recorded[1]!.prospectRef).toBe('jane-doe');
    expect(recorded[1]!.linkedinUrn).toBe('urn:li:fsd_profile:ABC123');
    expect(recorded[1]!.externalContext).toMatchObject({
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      name: 'Jane Doe',
      headline: 'Head of Ops',
    });
  });
});

describe('CampaignAdapter sequence surface', () => {
  let store: InMemoryStore;
  let campaign: CampaignAdapter;

  beforeEach(() => {
    store = new InMemoryStore();
    campaign = new CampaignAdapter(
      noServices,
      store,
      new DefaultSafetyGate({ allowMissingCounters: true }),
    );
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

describe('CampaignAdapter enroll-time company enrichment', () => {
  it('verifies an unverified company off the profile, skips an already-verified one', async () => {
    const store = new InMemoryStore();
    // A target that skipped list scoring (company is a headline guess) and one
    // that was already profile-verified upstream.
    const guessed = await store.target.create({
      campaignId: CAMP,
      prospectRef: 'guessed',
      linkedinUrn: 'urn:li:person:GUESS',
      externalContext: { currentCompany: 'Tesla', companySource: 'headline' },
    });
    const verified = await store.target.create({
      campaignId: CAMP,
      prospectRef: 'verified',
      linkedinUrn: 'urn:li:person:VERIF',
      externalContext: { currentCompany: 'aetherEV', companySource: 'profile' },
    });

    const attached: Array<{ id: string; context: unknown }> = [];
    const services = {
      campaigns: {
        async attachExternalContext(id: string, context: unknown) {
          attached.push({ id, context });
          return store.target.mergeExternalContext(id, context as Record<string, never>);
        },
      },
    } as unknown as OrchestratorServices;

    const enrich = vi.fn(
      async (): Promise<EnrichedCompany | null> => ({
        currentCompany: 'RealCorp',
        currentTitle: 'VP Ops',
        companySource: 'profile',
      }),
    );
    const enricher: CompanyEnricher = { enrich };
    const campaign = new CampaignAdapter(
      services,
      store,
      new DefaultSafetyGate({ allowMissingCounters: true }),
      enricher,
    );

    await campaign.enrollTargets(CAMP, [guessed.id, verified.id], ACCT);

    // Only the unverified target was fetched, and with the enrolling sender.
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith('urn:li:person:GUESS', ACCT);
    expect(attached).toHaveLength(1);
    expect(attached[0]!.id).toBe(guessed.id);
    expect(attached[0]!.context).toEqual({
      companySource: 'profile',
      currentCompany: 'RealCorp',
      currentTitle: 'VP Ops',
    });
    // The verified target keeps its company untouched.
    const after = await store.target.findById(verified.id);
    expect((after!.externalContext as Record<string, unknown>).currentCompany).toBe('aetherEV');
  });
});

describe('CampaignAdapter enrollment stagger', () => {
  let store: InMemoryStore;
  let campaign: CampaignAdapter;

  /** The account's connect cap for these tests; small so a batch overflows it. */
  const CONNECT_CAP = 2;

  beforeEach(async () => {
    store = new InMemoryStore();
    campaign = new CampaignAdapter(
      noServices,
      store,
      new DefaultSafetyGate({ allowMissingCounters: true }),
    );
    const zero = {
      connect: 0,
      message: 0,
      view_profile: 0,
      follow: 0,
      withdraw_invite: 0,
      react: 0,
    };
    await store.account.create({
      id: ACCT,
      handle: 'op',
      proxyBinding: { proxyId: 'p', region: 'us', sticky: true },
      health: {
        acceptanceRate: 0.6,
        replyRate: 0.3,
        challengesLast7d: 0,
        lastCheckedAt: new Date(),
      },
      budget: { date: new Date().toISOString().slice(0, 10), caps: zero, used: zero },
      limits: {
        caps: { ...zero, connect: CONNECT_CAP, message: 20 },
      },
    });
  });

  /** nextStepAt per enrolled progress id, in enrollment order. */
  async function nextStepAts(progressIds: string[]): Promise<Array<Date | null>> {
    const rows = await store.sequence.listTargetProgress(CAMP);
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    return progressIds.map((id) => byId.get(id)!.nextStepAt);
  }

  it('staggers a batch past the first-step daily cap onto later working mornings', async () => {
    await campaign.defineCampaignSteps(CAMP, [{ stepType: 'connect' }]);
    const now = new Date();
    const res = await campaign.enrollTargets(CAMP, ['t1', 't2', 't3', 't4', 't5'], ACCT);
    expect(res.enrolled).toBe(5);

    const ats = await nextStepAts(res.progressIds);
    // First `cap` are due now (today's budget); the tail lands on working mornings.
    expect(ats[0]).toBeNull();
    expect(ats[1]).toBeNull();
    expect(ats[2]).toEqual(dueAfterDelay(now, 86_400, DEFAULT_SCHEDULE));
    expect(ats[3]).toEqual(dueAfterDelay(now, 86_400, DEFAULT_SCHEDULE));
    expect(ats[4]).toEqual(dueAfterDelay(now, 2 * 86_400, DEFAULT_SCHEDULE));
  });

  it('appends a second batch after the first batch commitments, never past a day cap', async () => {
    await campaign.defineCampaignSteps(CAMP, [{ stepType: 'connect' }]);
    const now = new Date();
    // Batch 1 (cap 2): two due now, one on day 1.
    await campaign.enrollTargets(CAMP, ['t1', 't2', 't3'], ACCT);
    // Batch 2: today is full (2 nulls), day 1 has one slot left -> fill it,
    // then overflow to day 2. Nothing restarts at day 0 or overbooks day 1.
    const second = await campaign.enrollTargets(CAMP, ['t4', 't5', 't6'], ACCT);

    const ats = await nextStepAts(second.progressIds);
    expect(ats[0]).toEqual(dueAfterDelay(now, 86_400, DEFAULT_SCHEDULE)); // day 1 fills to cap
    expect(ats[1]).toEqual(dueAfterDelay(now, 2 * 86_400, DEFAULT_SCHEDULE)); // overflow
    expect(ats[2]).toEqual(dueAfterDelay(now, 2 * 86_400, DEFAULT_SCHEDULE));
  });

  it('enrolls all-null when the campaign has no steps yet', async () => {
    const res = await campaign.enrollTargets(CAMP, ['t1', 't2', 't3', 't4', 't5'], ACCT);
    const ats = await nextStepAts(res.progressIds);
    expect(ats).toEqual([null, null, null, null, null]);
  });

  it('does not let skipped-removed targets consume slots', async () => {
    await campaign.defineCampaignSteps(CAMP, [{ stepType: 'connect' }]);
    const removed = await store.target.create({
      campaignId: CAMP,
      prospectRef: 'gone',
      linkedinUrn: 'urn:li:person:gone',
      externalContext: { removed: true },
    });
    const now = new Date();
    // cap 2: with the removed target skipped, t2+t3 take today's two slots and
    // t4 rolls to day 1. If the removed target consumed a slot, t3 would roll.
    const res = await campaign.enrollTargets(CAMP, [removed.id, 't2', 't3', 't4'], ACCT);
    expect(res.skippedRemoved).toBe(1);
    expect(res.enrolled).toBe(3);

    const ats = await nextStepAts(res.progressIds);
    expect(ats[0]).toBeNull();
    expect(ats[1]).toBeNull();
    expect(ats[2]).toEqual(dueAfterDelay(now, 86_400, DEFAULT_SCHEDULE));
  });

  it('does not enroll a person already being contacted by another campaign', async () => {
    await campaign.defineCampaignSteps(CAMP, [{ stepType: 'connect' }]);
    const urn = 'urn:li:fsd_profile:DUP';
    // The same person, already invited under a different campaign.
    await store.target.create({
      campaignId: 'other-campaign',
      prospectRef: 'dup',
      linkedinUrn: urn,
      stage: 'invited',
    });
    const dup = await store.target.create({
      campaignId: CAMP,
      prospectRef: 'dup',
      linkedinUrn: urn,
      stage: 'sourced',
    });
    const fresh = await store.target.create({
      campaignId: CAMP,
      prospectRef: 'fresh',
      linkedinUrn: 'urn:li:fsd_profile:FRESH',
      stage: 'sourced',
    });

    const res = await campaign.enrollTargets(CAMP, [dup.id, fresh.id], ACCT);
    expect(res.skippedCrossCampaign).toBe(1);
    expect(res.enrolled).toBe(1);
    expect(res.progressIds).toHaveLength(1);
  });

  it('still enrolls when the other-campaign copy has not been contacted yet', async () => {
    await campaign.defineCampaignSteps(CAMP, [{ stepType: 'connect' }]);
    const urn = 'urn:li:fsd_profile:SRC';
    // A pre-contact stage in another campaign is not a lock — only invited+ is.
    await store.target.create({
      campaignId: 'other-campaign',
      prospectRef: 'src',
      linkedinUrn: urn,
      stage: 'sourced',
    });
    const t = await store.target.create({
      campaignId: CAMP,
      prospectRef: 'src',
      linkedinUrn: urn,
      stage: 'sourced',
    });

    const res = await campaign.enrollTargets(CAMP, [t.id], ACCT);
    expect(res.skippedCrossCampaign).toBe(0);
    expect(res.enrolled).toBe(1);
  });

  it('enrolls all-null when the first enabled step is a delay', async () => {
    await campaign.defineCampaignSteps(CAMP, [
      { stepType: 'delay', delaySeconds: 86_400 },
      { stepType: 'connect' },
    ]);
    const res = await campaign.enrollTargets(CAMP, ['t1', 't2', 't3'], ACCT);
    const ats = await nextStepAts(res.progressIds);
    expect(ats).toEqual([null, null, null]);
  });
});
