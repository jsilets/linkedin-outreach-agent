// Tool-level tests for the list-scoring tools (score_list, score_leads) driven
// through their real MCP handlers. Sourcing is a separate step, so these operate
// on members already in a list; neither makes a live search. Backed by a real
// InMemoryStore + a DiscoveryAdapter.

import type { Ports } from '@loa/mcp';
import { AGENT_CONTEXT, TOOLS_BY_NAME } from '@loa/mcp';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import type { CompanyEnricher, EnrichedCompany } from './enrich.js';
import { DiscoveryAdapter } from './index.js';

function run(tool: string, args: Record<string, unknown>, ports: Ports) {
  const def = TOOLS_BY_NAME.get(tool);
  if (!def) throw new Error(`no such tool: ${tool}`);
  return def.handler(args as never, ports, AGENT_CONTEXT);
}

const ICP = {
  name: 'Ops leaders',
  query: { keywords: 'field operations' },
  attributes: [{ field: 'title', match: ['director'], weight: 2 }],
};

async function seed(store: InMemoryStore) {
  const list = await store.leadList.createList({ name: 'sourced' });
  await store.leadList.insertMembers([
    {
      listId: list.id,
      linkedinUrn: 'urn:li:P1',
      name: 'P1',
      headline: 'Director of Field Operations',
    },
    { listId: list.id, linkedinUrn: 'urn:li:P2', name: 'P2', headline: 'Barista' },
  ]);
  return list.id;
}

describe('list scoring tools', () => {
  it('discover_leads no longer exists (sourcing and scoring are separate)', () => {
    expect(TOOLS_BY_NAME.get('discover_leads')).toBeUndefined();
    expect(TOOLS_BY_NAME.get('rescore_list')).toBeUndefined();
    expect(TOOLS_BY_NAME.get('score_list')).toBeDefined();
  });

  it('score_list runs the heuristic over a list and counts off-ICP', async () => {
    const store = new InMemoryStore();
    const ports = { discovery: new DiscoveryAdapter(store) } as unknown as Ports;
    const listId = await seed(store);

    const res = (await run('score_list', { listId, icp: ICP }, ports)) as {
      scored: number;
      offIcp: number;
      topScore: number;
    };
    expect(res.scored).toBe(2);
    // The barista is below the fit threshold; the director is not.
    expect(res.offIcp).toBe(1);
    const members = await store.leadList.listMembers(listId);
    const director = members.find((m) => m.linkedinUrn === 'urn:li:P1')!;
    const barista = members.find((m) => m.linkedinUrn === 'urn:li:P2')!;
    expect((director.externalContext as { score: number }).score).toBeGreaterThan(
      (barista.externalContext as { score: number }).score,
    );
    expect((barista.externalContext as { score: number }).score).toBeLessThan(50);
  });

  it('score_leads attaches agent-supplied scores', async () => {
    const store = new InMemoryStore();
    const ports = { discovery: new DiscoveryAdapter(store) } as unknown as Ports;
    const listId = await seed(store);

    const out = (await run(
      'score_leads',
      { listId, scores: [{ linkedinUrn: 'urn:li:P1', score: 95, reasons: ['ideal'] }] },
      ports,
    )) as { updated: number; missed: string[] };
    expect(out.updated).toBe(1);
    expect(out.missed).toEqual([]);
    const members = await store.leadList.listMembers(listId);
    const p1 = members.find((m) => m.linkedinUrn === 'urn:li:P1')!;
    expect((p1.externalContext as { score: number }).score).toBe(95);
    expect((p1.externalContext as { scoreModel: string }).scoreModel).toBe('harness');
  });

  it('score_leads reports urns with no matching member in missed', async () => {
    const store = new InMemoryStore();
    const ports = { discovery: new DiscoveryAdapter(store) } as unknown as Ports;
    const listId = await seed(store);

    const out = (await run(
      'score_leads',
      { listId, scores: [{ linkedinUrn: 'urn:missing', score: 80 }] },
      ports,
    )) as { updated: number; missed: string[] };
    expect(out.updated).toBe(0);
    expect(out.missed).toEqual(['urn:missing']);
  });

  it('score_leads merges into external_context rather than replacing it', async () => {
    const store = new InMemoryStore();
    const ports = { discovery: new DiscoveryAdapter(store) } as unknown as Ports;
    const list = await store.leadList.createList({ name: 'sourced' });
    await store.leadList.insertMembers([
      {
        listId: list.id,
        linkedinUrn: 'urn:li:P1',
        name: 'P1',
        headline: 'Director',
        externalContext: { enrichment: 'kept' },
      },
    ]);

    await run(
      'score_leads',
      { listId: list.id, scores: [{ linkedinUrn: 'urn:li:P1', score: 88 }] },
      ports,
    );
    const members = await store.leadList.listMembers(list.id);
    const p1 = members.find((m) => m.linkedinUrn === 'urn:li:P1')!;
    // The pre-existing key survives alongside the new score fields.
    expect((p1.externalContext as { enrichment: string }).enrichment).toBe('kept');
    expect((p1.externalContext as { score: number }).score).toBe(88);
  });

  it('score_list verifies the company off the profile before it decides fit', async () => {
    // ICP that rejects Tesla and rewards a director title. P1's STORED company is
    // "Tesla" (a headline guess); the profile says they are actually a director at
    // aetherEV. Enrichment must flip the decision from off-ICP to on-ICP.
    const icpNeg = {
      name: 'Ops leaders, not Tesla',
      query: { keywords: 'field operations' },
      attributes: [
        { field: 'company', match: ['tesla'], weight: 3, negative: true },
        { field: 'title', match: ['director'], weight: 2 },
      ],
    };
    const enriched: EnrichedCompany = {
      currentCompany: 'aetherEV',
      currentTitle: 'Director of Field Operations',
      companySource: 'profile',
    };
    const enrich = vi.fn(async (): Promise<EnrichedCompany | null> => enriched);
    const enricher: CompanyEnricher = { enrich };
    const store = new InMemoryStore();
    const ports = { discovery: new DiscoveryAdapter(store, { enricher }) } as unknown as Ports;
    const list = await store.leadList.createList({ name: 'sourced' });
    await store.leadList.insertMembers([
      {
        listId: list.id,
        linkedinUrn: 'urn:li:P1',
        name: 'P1',
        headline: 'Director of Field Operations',
        currentCompany: 'Tesla',
      },
    ]);

    const res = (await run('score_list', { listId: list.id, icp: icpNeg }, ports)) as {
      scored: number;
      offIcp: number;
      enriched: number;
    };
    expect(enrich).toHaveBeenCalledWith('urn:li:P1');
    expect(res.enriched).toBe(1);
    // Scored against aetherEV, not Tesla, so the person is on-ICP.
    expect(res.offIcp).toBe(0);
    const [p1] = await store.leadList.listMembers(list.id);
    const ec = p1!.externalContext as Record<string, unknown>;
    expect(ec.companySource).toBe('profile');
    expect(ec.currentCompany).toBe('aetherEV');
    expect(ec.currentTitle).toBe('Director of Field Operations');
    expect(ec.score as number).toBeGreaterThanOrEqual(50);

    // A second run does NOT re-fetch: the member is already profile-verified.
    await run('score_list', { listId: list.id, icp: icpNeg, overwrite: true }, ports);
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('score_list keeps the enrichment even when it skips another scorer', async () => {
    const enrich = vi.fn(
      async (): Promise<EnrichedCompany | null> => ({
        currentCompany: 'aetherEV',
        currentTitle: 'COO',
        companySource: 'profile',
      }),
    );
    const store = new InMemoryStore();
    const ports = {
      discovery: new DiscoveryAdapter(store, { enricher: { enrich } }),
    } as unknown as Ports;
    const list = await store.leadList.createList({ name: 'sourced' });
    await store.leadList.insertMembers([
      {
        listId: list.id,
        linkedinUrn: 'urn:li:P1',
        name: 'P1',
        headline: 'Director',
        externalContext: { score: 90, scoreModel: 'harness' },
      },
    ]);

    const res = (await run('score_list', { listId: list.id, icp: ICP }, ports)) as {
      scored: number;
      skippedOtherScorer: number;
      enriched: number;
    };
    expect(res.skippedOtherScorer).toBe(1);
    expect(res.enriched).toBe(1);
    const [p1] = await store.leadList.listMembers(list.id);
    const ec = p1!.externalContext as Record<string, unknown>;
    // Harness score untouched, but the verified company was still persisted.
    expect(ec.scoreModel).toBe('harness');
    expect(ec.companySource).toBe('profile');
    expect(ec.currentCompany).toBe('aetherEV');
  });

  it('score_list skips a member already scored by another scorer unless overwrite', async () => {
    const store = new InMemoryStore();
    const ports = { discovery: new DiscoveryAdapter(store) } as unknown as Ports;
    const list = await store.leadList.createList({ name: 'sourced' });
    await store.leadList.insertMembers([
      {
        listId: list.id,
        linkedinUrn: 'urn:li:P1',
        name: 'P1',
        headline: 'Director of Field Operations',
        externalContext: { score: 90, scoreModel: 'harness' },
      },
    ]);

    const res = (await run('score_list', { listId: list.id, icp: ICP }, ports)) as {
      scored: number;
      skippedOtherScorer: number;
    };
    expect(res.scored).toBe(0);
    expect(res.skippedOtherScorer).toBe(1);
    // The harness score is left intact.
    const before = await store.leadList.listMembers(list.id);
    expect((before[0]!.externalContext as { scoreModel: string }).scoreModel).toBe('harness');

    // overwrite=true re-scores it with the heuristic.
    const res2 = (await run(
      'score_list',
      { listId: list.id, icp: ICP, overwrite: true },
      ports,
    )) as { scored: number; skippedOtherScorer: number };
    expect(res2.scored).toBe(1);
    expect(res2.skippedOtherScorer).toBe(0);
    const after = await store.leadList.listMembers(list.id);
    expect((after[0]!.externalContext as { scoreModel: string }).scoreModel).toBe('heuristic-v1');
  });
});
