// Tool-level tests for the ICP list-hygiene surface: get_list surfaces the fit
// score, remove_from_list ejects members, enroll_from_list gates enrollment by
// score, and remove_from_campaign logically removes an enrolled target. Backed by
// a real InMemoryStore + real orchestrator services, driven through the MCP tools.

import type { Ports } from '@loa/mcp';
import { AGENT_CONTEXT, TOOLS_BY_NAME } from '@loa/mcp';
import { DefaultSafetyGate } from '@loa/safety';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { CampaignAdapter, LeadListAdapter } from './mcp-ports.js';
import { makeOrchestratorServices } from './orchestrator.js';

const ACCT = 'acct-1';

function run(tool: string, args: Record<string, unknown>, ports: Ports) {
  const def = TOOLS_BY_NAME.get(tool);
  if (!def) throw new Error(`no such tool: ${tool}`);
  return def.handler(args as never, ports, AGENT_CONTEXT);
}

describe('ICP list-hygiene tools', () => {
  let store: InMemoryStore;
  let ports: Ports;

  beforeEach(() => {
    store = new InMemoryStore();
    const services = makeOrchestratorServices(store, { enqueueFollowUp: async () => {} });
    const campaign = new CampaignAdapter(
      services,
      store,
      new DefaultSafetyGate({ allowMissingCounters: true }),
    );
    const lists = new LeadListAdapter(store);
    ports = { lists, campaign } as unknown as Ports;
  });

  async function seedList(name: string) {
    const list = await store.leadList.createList({ name });
    await store.leadList.insertMembers([
      {
        listId: list.id,
        linkedinUrn: 'urn:li:fit',
        name: 'Fit Lead',
        headline: 'Director of Field Operations',
        profileUrl: 'https://www.linkedin.com/in/fit/',
        externalContext: { score: 80, scoreReasons: ['title match'], icp: 'Ops' },
      },
      {
        listId: list.id,
        linkedinUrn: 'urn:li:unfit',
        name: 'Unfit Lead',
        headline: 'Barista',
        profileUrl: 'https://www.linkedin.com/in/unfit/',
        externalContext: { score: 20, scoreReasons: ['no title match'], icp: 'Ops' },
      },
    ]);
    return list.id;
  }

  it('get_list surfaces the score and off-ICP flag', async () => {
    const listId = await seedList('surface');
    const detail = (await run('get_list', { listId }, ports)) as {
      members: Array<{ linkedinUrn: string; score: number | null; offIcp: boolean }>;
    };
    const fit = detail.members.find((m) => m.linkedinUrn === 'urn:li:fit')!;
    const unfit = detail.members.find((m) => m.linkedinUrn === 'urn:li:unfit')!;
    expect(fit.score).toBe(80);
    expect(fit.offIcp).toBe(false);
    expect(unfit.score).toBe(20);
    expect(unfit.offIcp).toBe(true);
  });

  it('insertMembers stores the canonical bare urn and dedups across wrapper forms', async () => {
    const listAdapter = new LeadListAdapter(store);
    const list = await store.leadList.createList({ name: 'canon' });

    // Only the search wrapper is carried (no bare linkedinUrn), as free-tier
    // search cards arrive; the write site must still persist the bare person key.
    const personA = {
      entityUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACo9,SEARCH_SRP,DEFAULT)',
      profileUrl: 'https://www.linkedin.com/in/dana/',
      name: 'Dana',
    };
    const r1 = await listAdapter.insertMembers(list.id, [personA]);
    expect(r1.inserted).toBe(1);
    const members = await store.leadList.listMembers(list.id);
    expect(members[0]!.linkedinUrn).toBe('urn:li:fsd_profile:ACo9'); // bare, never the wrapper

    // The same person via a different search wrapper collapses to the same key.
    const personB = {
      entityUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACo9,PEOPLE,DEFAULT)',
      profileUrl: 'https://www.linkedin.com/in/dana/',
      name: 'Dana',
    };
    const r2 = await listAdapter.insertMembers(list.id, [personB]);
    expect(r2.inserted).toBe(0);
    expect(r2.duplicates).toBe(1);
  });

  it('remove_from_list ejects a member by urn', async () => {
    const listId = await seedList('remove');
    const res = (await run(
      'remove_from_list',
      { listId, linkedinUrns: ['urn:li:unfit'] },
      ports,
    )) as {
      removed: number;
    };
    expect(res.removed).toBe(1);
    const members = await store.leadList.listMembers(listId);
    expect(members.map((m) => m.linkedinUrn)).toEqual(['urn:li:fit']);
  });

  it('enroll_from_list gates enrollment by minScore and carries the score', async () => {
    const listId = await seedList('enroll');
    const res = (await run(
      'enroll_from_list',
      { listId, minScore: 50, goal: 'Book a call', accountId: ACCT },
      ports,
    )) as {
      campaignId: string;
      eligible: number;
      skippedBelowScore: number;
      added: number;
      enrolled: number;
    };

    expect(res.eligible).toBe(1);
    expect(res.skippedBelowScore).toBe(1);
    expect(res.added).toBe(1);
    expect(res.enrolled).toBe(1);

    // Only the fit lead became a target, and its score rode across.
    const targets = await store.listTargetsByCampaign(res.campaignId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.linkedinUrn).toBe('urn:li:fit');
    expect((targets[0]!.externalContext as { score: number }).score).toBe(80);
  });

  it('remove_from_campaign logically removes a pre-contact target (stage unchanged, progress skipped)', async () => {
    const listId = await seedList('camp');
    // Enroll everyone (minScore 0) so we have a target to remove.
    const enroll = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'Book a call', accountId: ACCT },
      ports,
    )) as { campaignId: string };

    // Capture the pre-removal stage: the target has not been contacted yet, so
    // removal must leave the stage as-is (not 'lost', which getMetrics would
    // count as invited).
    const before = await store.listTargetsByCampaign(enroll.campaignId);
    const stageBefore = before.find((t) => t.linkedinUrn === 'urn:li:unfit')!.stage;

    const res = (await run(
      'remove_from_campaign',
      { campaignId: enroll.campaignId, linkedinUrns: ['urn:li:unfit'], reason: 'off-ICP' },
      ports,
    )) as { removed: number; notFound: string[] };
    expect(res.removed).toBe(1);
    expect(res.notFound).toEqual([]);

    const targets = await store.listTargetsByCampaign(enroll.campaignId);
    const removedTarget = targets.find((t) => t.linkedinUrn === 'urn:li:unfit')!;
    expect(removedTarget.stage).toBe(stageBefore);
    expect(removedTarget.stage).not.toBe('lost');
    const prog = await store.sequence.getTargetProgressByTarget(removedTarget.id);
    // Ejected, not replied: terminal 'skipped' keeps reply metrics honest.
    expect(prog?.state).toBe('skipped');
  });

  it('remove_from_campaign marks a contacted target lost', async () => {
    const listId = await seedList('camp-contacted');
    const enroll = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'Book a call', accountId: ACCT },
      ports,
    )) as { campaignId: string };

    // Move the target past first contact before removing it.
    const before = await store.listTargetsByCampaign(enroll.campaignId);
    const target = before.find((t) => t.linkedinUrn === 'urn:li:unfit')!;
    await store.target.setStage(target.id, 'invited');

    const res = (await run(
      'remove_from_campaign',
      { campaignId: enroll.campaignId, linkedinUrns: ['urn:li:unfit'], reason: 'off-ICP' },
      ports,
    )) as { removed: number };
    expect(res.removed).toBe(1);

    const targets = await store.listTargetsByCampaign(enroll.campaignId);
    const removedTarget = targets.find((t) => t.linkedinUrn === 'urn:li:unfit')!;
    expect(removedTarget.stage).toBe('lost');
    const prog = await store.sequence.getTargetProgressByTarget(removedTarget.id);
    expect(prog?.state).toBe('skipped');
  });

  it('remove_from_campaign cancels an approved-but-unsent outbound message', async () => {
    const listId = await seedList('camp-msg');
    const enroll = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'Book a call', accountId: ACCT },
      ports,
    )) as { campaignId: string };
    const before = await store.listTargetsByCampaign(enroll.campaignId);
    const target = before.find((t) => t.linkedinUrn === 'urn:li:unfit')!;

    // An approved outbound draft queued for this target must not fire after
    // removal; it is cancelled along with the funnel stop.
    const msg = await store.message.create({
      accountId: ACCT,
      targetId: target.id,
      direction: 'outbound',
      body: 'hi there',
      threadRef: `pending:${ACCT}:${target.id}`,
      status: 'approved',
    });

    const res = (await run(
      'remove_from_campaign',
      { campaignId: enroll.campaignId, linkedinUrns: ['urn:li:unfit'], reason: 'off-ICP' },
      ports,
    )) as { removed: number };
    expect(res.removed).toBe(1);

    const after = await store.message.findById(msg.id);
    expect(after?.status).toBe('cancelled');
  });

  it('remove_from_campaign is idempotent on re-removal', async () => {
    const listId = await seedList('camp-idem');
    const enroll = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'Book a call', accountId: ACCT },
      ports,
    )) as { campaignId: string };
    const before = await store.listTargetsByCampaign(enroll.campaignId);
    const target = before.find((t) => t.linkedinUrn === 'urn:li:unfit')!;
    await store.target.setStage(target.id, 'invited');

    const first = (await run(
      'remove_from_campaign',
      { campaignId: enroll.campaignId, targetIds: [target.id] },
      ports,
    )) as { removed: number };
    expect(first.removed).toBe(1);

    // Removing the same target again does not change its end state: the cursor
    // stays terminal 'skipped', the stage stays 'lost', and the removed marker
    // stays set. (The selector still resolves it, so removed is reported as 1.)
    const second = (await run(
      'remove_from_campaign',
      { campaignId: enroll.campaignId, targetIds: [target.id] },
      ports,
    )) as { removed: number };
    expect(second.removed).toBe(1);

    const after = (await store.listTargetsByCampaign(enroll.campaignId)).find(
      (t) => t.id === target.id,
    )!;
    expect(after.stage).toBe('lost');
    expect((after.externalContext as { removed?: boolean }).removed).toBe(true);
    const prog = await store.sequence.getTargetProgressByTarget(target.id);
    expect(prog?.state).toBe('skipped');
  });

  it('remove_from_campaign terminates every duplicate-urn row', async () => {
    // Two target rows can carry the same urn; removing by urn must terminate both,
    // not just the last one seen. Build them via the store directly, since
    // addTargets dedupes by urn.
    const campaign = await store.campaign.create({
      goal: 'dupes',
      messageStrategy: 's',
      owner: 'operator',
    });
    const urn = 'urn:li:dupe';
    const t1 = await store.target.create({
      campaignId: campaign.id,
      prospectRef: 'dupe-1',
      linkedinUrn: urn,
    });
    const t2 = await store.target.create({
      campaignId: campaign.id,
      prospectRef: 'dupe-2',
      linkedinUrn: urn,
    });
    await store.sequence.enrollTarget(campaign.id, t1.id, ACCT);
    await store.sequence.enrollTarget(campaign.id, t2.id, ACCT);

    const res = (await run(
      'remove_from_campaign',
      { campaignId: campaign.id, linkedinUrns: [urn] },
      ports,
    )) as { removed: number; notFound: string[] };
    expect(res.removed).toBe(2);

    const p1 = await store.sequence.getTargetProgressByTarget(t1.id);
    const p2 = await store.sequence.getTargetProgressByTarget(t2.id);
    expect(p1?.state).toBe('skipped');
    expect(p2?.state).toBe('skipped');
  });

  it('enroll_from_list re-run on the same campaign dedupes to added 0', async () => {
    const listId = await seedList('rerun');
    const first = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'Book a call', accountId: ACCT },
      ports,
    )) as { campaignId: string; eligible: number; added: number };
    expect(first.added).toBe(2);

    // Second run against the same campaign: every eligible member is already a
    // target, so nothing is added and the run does not throw.
    const second = (await run(
      'enroll_from_list',
      { listId, minScore: 0, campaignId: first.campaignId, accountId: ACCT },
      ports,
    )) as { campaignId: string; eligible: number; added: number; alreadyInCampaign: number };
    expect(second.added).toBe(0);
    expect(second.alreadyInCampaign).toBe(second.eligible);

    // The campaign still holds only the original rows.
    const targets = await store.listTargetsByCampaign(first.campaignId);
    expect(targets).toHaveLength(2);
  });

  it('a removed never-enrolled target cannot be swept back in by a later enroll', async () => {
    // enroll_from_list WITHOUT accountId: targets land at stage sourced with no
    // progress row. Removal must still stick when the campaign is enrolled later.
    const listId = await seedList('sweep');
    const first = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'Book a call' },
      ports,
    )) as { campaignId: string };

    const res = (await run(
      'remove_from_campaign',
      { campaignId: first.campaignId, linkedinUrns: ['urn:li:unfit'], reason: 'off-ICP' },
      ports,
    )) as { removed: number };
    expect(res.removed).toBe(1);

    // A later explicit enroll of every target id (what a campaign launch does)
    // skips the removed one and reports it.
    const targets = await store.listTargetsByCampaign(first.campaignId);
    const enroll = (await run(
      'enroll_targets',
      { campaignId: first.campaignId, targetIds: targets.map((t) => t.id), accountId: ACCT },
      ports,
    )) as { enrolled: number; skippedRemoved: number };
    expect(enroll.skippedRemoved).toBe(1);
    expect(enroll.enrolled).toBe(1);

    const removedTarget = targets.find((t) => t.linkedinUrn === 'urn:li:unfit')!;
    const prog = await store.sequence.getTargetProgressByTarget(removedTarget.id);
    expect(prog?.state ?? null).not.toBe('in_progress');
  });

  it('remove_from_campaign reports selectors not in the campaign', async () => {
    const listId = await seedList('camp2');
    const enroll = (await run(
      'enroll_from_list',
      { listId, minScore: 0, goal: 'g', accountId: ACCT },
      ports,
    )) as { campaignId: string };

    const res = (await run(
      'remove_from_campaign',
      { campaignId: enroll.campaignId, linkedinUrns: ['urn:li:nobody'] },
      ports,
    )) as { removed: number; notFound: string[] };
    expect(res.removed).toBe(0);
    expect(res.notFound).toEqual(['urn:li:nobody']);
  });
});
