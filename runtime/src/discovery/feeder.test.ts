// Tests for the discovery feeder and the DiscoveryAdapter. A fake data source
// yields fixed candidates and a fake qualifier assigns fixed scores, so ranking,
// the minScore cutoff, and the written external_context are all deterministic.
// The store is a real InMemoryStore, so these also cover the score persistence
// path end to end (members land in lead_list_members with the score in the blob).

import { describe, expect, it } from 'vitest';
import type { Icp } from '@loa/mcp';
import { InMemoryStore } from '../store/in-memory-store.js';
import { DiscoveryAdapter } from './index.js';
import { discoverAndScore } from './feeder.js';
import type { Candidate, DataSourcePort, LeadScore, QualifierPort } from './types.js';

const ICP: Icp = { name: 'Ops leaders', query: {}, attributes: [{ field: 'title', match: ['director'] }] };

function candidate(n: number): Candidate {
  return {
    entityUrn: `urn:li:fsd_profile:P${n}`,
    profileUrl: `https://www.linkedin.com/in/p${n}/`,
    name: `Person ${n}`,
    headline: `Director ${n}`,
    currentCompany: `Co ${n}`,
    location: 'United States',
    degree: '2nd',
  };
}

/** Data source returning a fixed candidate set and recording the ICP it saw. */
class FakeDataSource implements DataSourcePort {
  lastLimit = 0;
  constructor(private readonly people: Candidate[]) {}
  async discover(_accountId: string, _icp: Icp, limit: number): Promise<Candidate[]> {
    this.lastLimit = limit;
    return this.people;
  }
}

/** Qualifier that scores by a lookup keyed on entityUrn, so tests set the rank. */
class FakeQualifier implements QualifierPort {
  constructor(private readonly byUrn: Record<string, number>) {}
  async score(c: Candidate): Promise<LeadScore> {
    return { score: this.byUrn[c.entityUrn] ?? 0, reasons: ['fake'], model: 'fake-v1' };
  }
}

describe('discoverAndScore', () => {
  it('writes candidates ranked by score, with the score in external_context', async () => {
    const store = new InMemoryStore();
    const dataSource = new FakeDataSource([candidate(1), candidate(2), candidate(3)]);
    const qualifier = new FakeQualifier({
      'urn:li:fsd_profile:P1': 40,
      'urn:li:fsd_profile:P2': 90,
      'urn:li:fsd_profile:P3': 65,
    });

    const res = await discoverAndScore(
      { dataSource, qualifier, lists: store.leadList },
      { accountId: 'acct-1', icp: ICP, listName: 'Field ops' },
    );

    expect(res.discovered).toBe(3);
    expect(res.scored).toBe(3);
    expect(res.inserted).toBe(3);
    expect(res.topScore).toBe(90);

    const members = await store.leadList.listMembers(res.listId);
    // Written highest-first.
    expect(members.map((m) => (m.externalContext as { score: number }).score)).toEqual([90, 65, 40]);
    const top = members[0]!.externalContext as { score: number; scoreModel: string; profileUrl: string };
    expect(top.scoreModel).toBe('fake-v1');
    expect(top.profileUrl).toBe('https://www.linkedin.com/in/p2/');
  });

  it('drops candidates below icp.minScore', async () => {
    const store = new InMemoryStore();
    const dataSource = new FakeDataSource([candidate(1), candidate(2)]);
    const qualifier = new FakeQualifier({ 'urn:li:fsd_profile:P1': 20, 'urn:li:fsd_profile:P2': 80 });

    const res = await discoverAndScore(
      { dataSource, qualifier, lists: store.leadList },
      { accountId: 'acct-1', icp: { ...ICP, minScore: 50 }, listName: 'High only' },
    );

    expect(res.discovered).toBe(2);
    expect(res.scored).toBe(1);
    const members = await store.leadList.listMembers(res.listId);
    expect(members).toHaveLength(1);
    expect(members[0]!.linkedinUrn).toBe('urn:li:fsd_profile:P2');
  });

  it('is idempotent on re-run (dedup on listId + urn)', async () => {
    const store = new InMemoryStore();
    const dataSource = new FakeDataSource([candidate(1), candidate(2)]);
    const qualifier = new FakeQualifier({ 'urn:li:fsd_profile:P1': 60, 'urn:li:fsd_profile:P2': 70 });
    const deps = { dataSource, qualifier, lists: store.leadList };

    const first = await discoverAndScore(deps, { accountId: 'a', icp: ICP, listName: 'L' });
    const again = await discoverAndScore(deps, { accountId: 'a', icp: ICP, listId: first.listId });

    expect(first.inserted).toBe(2);
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(2);
    expect(await store.leadList.listMembers(first.listId)).toHaveLength(2);
  });

  it('passes icp.limit through to the data source', async () => {
    const store = new InMemoryStore();
    const dataSource = new FakeDataSource([candidate(1)]);
    await discoverAndScore(
      { dataSource, qualifier: new FakeQualifier({ 'urn:li:fsd_profile:P1': 50 }), lists: store.leadList },
      { accountId: 'a', icp: { ...ICP, limit: 7 }, listName: 'L' },
    );
    expect(dataSource.lastLimit).toBe(7);
  });

  it('requires a listId or listName', async () => {
    const store = new InMemoryStore();
    await expect(
      discoverAndScore(
        { dataSource: new FakeDataSource([]), qualifier: new FakeQualifier({}), lists: store.leadList },
        { accountId: 'a', icp: ICP },
      ),
    ).rejects.toThrow(/listId or a listName/);
  });
});

describe('DiscoveryAdapter.scoreLeads (harness-driven path)', () => {
  it('merges agent scores into existing members and reports misses', async () => {
    const store = new InMemoryStore();
    const list = await store.leadList.createList({ name: 'L' });
    await store.leadList.insertMembers([
      { listId: list.id, linkedinUrn: 'urn:1', name: 'A', externalContext: { profileUrl: 'u1' } },
      { listId: list.id, linkedinUrn: 'urn:2', name: 'B', externalContext: {} },
    ] as never);

    // observe is unused on this path; a bare stub satisfies the constructor.
    const adapter = new DiscoveryAdapter(store, { searchPeople: async () => [] });
    const res = await adapter.scoreLeads(list.id, [
      { linkedinUrn: 'urn:1', score: 88, reasons: ['strong fit'] },
      { linkedinUrn: 'urn:missing', score: 50 },
    ]);

    expect(res.updated).toBe(1);
    expect(res.missed).toEqual(['urn:missing']);
    const members = await store.leadList.listMembers(list.id);
    const scored = members.find((m) => m.linkedinUrn === 'urn:1')!;
    const ctx = scored.externalContext as { score: number; scoreModel: string; profileUrl: string };
    expect(ctx.score).toBe(88);
    expect(ctx.scoreModel).toBe('harness');
    // Merge preserved the pre-existing blob field.
    expect(ctx.profileUrl).toBe('u1');
  });
});
