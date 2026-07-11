// Tool-level tests for discover_leads / score_leads driven through their real MCP
// handlers. Proves the feature flag gates them (reject when ports.discovery is
// absent) and that, wired, discover_leads runs the live-search -> heuristic ->
// write path and score_leads attaches agent scores. Backed by a fake observe and
// a real InMemoryStore, so only ports.observe + ports.discovery are exercised.

import { describe, expect, it } from 'vitest';
import { AGENT_CONTEXT, TOOLS_BY_NAME } from '@loa/mcp';
import type { PersonSearchResult, Ports } from '@loa/mcp';
import { InMemoryStore } from '../store/in-memory-store.js';
import { DiscoveryAdapter } from './index.js';

function person(n: number): PersonSearchResult {
  return {
    entityUrn: `urn:li:fsd_profile:P${n}`,
    linkedinUrn: `urn:li:fsd_profile:P${n}`,
    name: `Person ${n}`,
    headline: n === 1 ? 'Director of Field Operations' : 'Barista',
    profileUrl: `https://www.linkedin.com/in/p${n}/`,
    degree: '2nd',
    location: 'United States',
  };
}

const observe = { searchPeople: async (): Promise<PersonSearchResult[]> => [person(1), person(2)] };

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

describe('discover_leads / score_leads tool gating', () => {
  it('rejects when discovery is disabled (ports.discovery absent)', async () => {
    const ports = { observe } as unknown as Ports;
    await expect(run('discover_leads', { accountId: 'a', icp: ICP, listName: 'L' }, ports)).rejects.toThrow(
      /discovery is disabled/,
    );
    await expect(
      run('score_leads', { listId: 'x', scores: [{ linkedinUrn: 'u', score: 1 }] }, ports),
    ).rejects.toThrow(/discovery is disabled/);
  });

  it('discover_leads runs search -> heuristic -> ranked write when enabled', async () => {
    const store = new InMemoryStore();
    const discovery = new DiscoveryAdapter(store, observe);
    const ports = { observe, discovery } as unknown as Ports;

    const res = (await run('discover_leads', { accountId: 'a', icp: ICP, listName: 'Field ops' }, ports)) as {
      listId: string;
      discovered: number;
      inserted: number;
      topScore: number;
    };
    expect(res.discovered).toBe(2);
    expect(res.inserted).toBe(2);
    // The director outscores the barista, so it lands first.
    const members = await store.leadList.listMembers(res.listId);
    expect(members[0]!.headline).toBe('Director of Field Operations');
    expect((members[0]!.externalContext as { score: number }).score).toBeGreaterThan(
      (members[1]!.externalContext as { score: number }).score,
    );
  });

  it('score_leads attaches agent scores to list members', async () => {
    const store = new InMemoryStore();
    const discovery = new DiscoveryAdapter(store, observe);
    const ports = { observe, discovery } as unknown as Ports;
    // Populate a list first (discover_leads), then attach an agent score.
    const created = (await run('discover_leads', { accountId: 'a', icp: ICP, listName: 'L' }, ports)) as {
      listId: string;
    };

    const out = (await run(
      'score_leads',
      { listId: created.listId, scores: [{ linkedinUrn: 'urn:li:fsd_profile:P1', score: 95, reasons: ['ideal'] }] },
      ports,
    )) as { updated: number; missed: string[] };
    expect(out.updated).toBe(1);
    expect(out.missed).toEqual([]);
    const members = await store.leadList.listMembers(created.listId);
    const p1 = members.find((m) => m.linkedinUrn === 'urn:li:fsd_profile:P1')!;
    expect((p1.externalContext as { score: number }).score).toBe(95);
  });
});
