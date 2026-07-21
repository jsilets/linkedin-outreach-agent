// Tests for the lead-sourcing MCP tools (source_people, create_list, list_lists,
// get_list, source_to_list) driven through their real tool handlers, backed by a
// fake observe returning canned PersonSearchResult[] and a LeadListAdapter over
// an InMemoryStore. Also covers the sourceToList core the CLI reuses. Only
// ports.observe and ports.lists are exercised, so the rest of Ports is stubbed.

import type { PeopleQuery, PersonSearchResult, Ports } from '@loa/mcp';
import { AGENT_CONTEXT, sourceToList, TOOLS_BY_NAME } from '@loa/mcp';
import { DefaultSafetyGate } from '@loa/safety';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { CampaignAdapter, LeadListAdapter } from './mcp-ports.js';

const ACCT = 'acct-1';

// Two canned people; the second is returned twice across calls to prove dedup.
function person(n: number): PersonSearchResult {
  return {
    entityUrn: `urn:li:fsd_profile:P${n}`,
    linkedinUrn: `urn:li:fsd_profile:P${n}`,
    publicId: `person-${n}`,
    name: `Person ${n}`,
    headline: `Head of ${n}`,
    profileUrl: `https://www.linkedin.com/in/person-${n}/`,
    degree: '2nd',
    location: 'United States',
  };
}

/** A fake observe that returns a fixed list and records the query it got. */
class FakeObserve {
  lastQuery: PeopleQuery | undefined;
  constructor(private readonly people: PersonSearchResult[]) {}
  async searchPeople(_accountId: string, query: PeopleQuery): Promise<PersonSearchResult[]> {
    this.lastQuery = query;
    return this.people;
  }
}

/** Build a Ports object wired only for the sourcing tools; the rest is unused. */
function makePorts(people: PersonSearchResult[]): {
  ports: Ports;
  store: InMemoryStore;
  observe: FakeObserve;
} {
  const store = new InMemoryStore();
  const observe = new FakeObserve(people);
  const ports = {
    observe,
    lists: new LeadListAdapter(store),
  } as unknown as Ports;
  return { ports, store, observe };
}

function run(tool: string, args: Record<string, unknown>, ports: Ports) {
  const def = TOOLS_BY_NAME.get(tool);
  if (!def) throw new Error(`no such tool: ${tool}`);
  return def.handler(args as never, ports, AGENT_CONTEXT);
}

describe('list_accounts tool', () => {
  it('lists every sender account with the id/handle/state a caller needs', async () => {
    const store = new InMemoryStore();
    const today = new Date().toISOString().slice(0, 10);
    const caps = {
      connect: 10,
      message: 10,
      view_profile: 10,
      follow: 10,
      withdraw_invite: 10,
      react: 10,
    };
    const used = {
      connect: 0,
      message: 0,
      view_profile: 0,
      follow: 0,
      withdraw_invite: 0,
      react: 0,
    };
    await store.account.create({
      id: ACCT,
      handle: 'acme-operator',
      state: 'Active',
      proxyBinding: { proxyId: 'p', region: 'us-east', sticky: true },
      health: {
        acceptanceRate: 0.6,
        replyRate: 0.3,
        challengesLast7d: 0,
        lastCheckedAt: new Date(),
      },
      budget: { date: today, caps, used },
    });
    // Only the store is exercised; the orchestrator services are unused here.
    const ports = {
      campaign: new CampaignAdapter(
        {} as never,
        store,
        new DefaultSafetyGate({ allowMissingCounters: true }),
      ),
    } as unknown as Ports;

    const accounts = (await run('list_accounts', {}, ports)) as Array<{
      id: string;
      handle: string;
      state: string;
    }>;

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: ACCT, handle: 'acme-operator', state: 'Active' });
  });
});

describe('source_people tool', () => {
  it('returns the search results and passes the facets through as a PeopleQuery', async () => {
    const { ports, observe } = makePorts([person(1), person(2)]);
    const out = (await run(
      'source_people',
      {
        accountId: ACCT,
        titleKeywords: ['director'],
        geoUrn: '103644278',
        network: ['S'],
        limit: 25,
      },
      ports,
    )) as PersonSearchResult[];

    expect(out).toHaveLength(2);
    expect(out[0]!.entityUrn).toBe('urn:li:fsd_profile:P1');
    // Facets fold into the PeopleQuery the observe backend receives.
    expect(observe.lastQuery).toMatchObject({
      titleKeywords: ['director'],
      geoUrn: '103644278',
      network: ['S'],
      limit: 25,
    });
  });

  it('passes a multi-geo geoUrns facet through to the observe backend', async () => {
    const { ports, observe } = makePorts([person(1)]);
    await run(
      'source_people',
      { accountId: ACCT, geoUrns: ['103644278', '101174742'], limit: 25 },
      ports,
    );
    // US + Canada targeted in one pass rather than two separate runs.
    expect(observe.lastQuery?.geoUrns).toEqual(['103644278', '101174742']);
  });
});

describe('create_list / list_lists / get_list round-trip', () => {
  let ports: Ports;
  let store: InMemoryStore;

  beforeEach(() => {
    ({ ports, store } = makePorts([]));
  });

  it('creates a list, lists it with a member count, and reads it back empty', async () => {
    const created = (await run(
      'create_list',
      { name: 'Field ops', description: 'ICP A' },
      ports,
    )) as {
      id: string;
      name: string;
    };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Field ops');

    const lists = (await run('list_lists', {}, ports)) as Array<{
      id: string;
      name: string;
      memberCount: number;
    }>;
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: created.id, name: 'Field ops', memberCount: 0 });

    const detail = (await run('get_list', { listId: created.id }, ports)) as {
      id: string;
      description: string | null;
      members: unknown[];
    };
    expect(detail.id).toBe(created.id);
    expect(detail.description).toBe('ICP A');
    expect(detail.members).toHaveLength(0);
    // The write landed in the same table the web UI reads.
    expect(await store.leadList.findById(created.id)).toBeTruthy();
  });

  it('returns null from get_list for an unknown list', async () => {
    expect(await run('get_list', { listId: 'nope' }, ports)).toBeNull();
  });
});

describe('source_to_list tool', () => {
  it('creates a list by name, writes matches, and dedups on a re-run', async () => {
    const { ports, store } = makePorts([person(1), person(2)]);

    const first = (await run(
      'source_to_list',
      { accountId: ACCT, listName: 'sourced', query: 'field service operations', limit: 25 },
      ports,
    )) as {
      listId: string;
      found: number;
      inserted: number;
      duplicates: number;
      alreadyKnown: number;
    };

    expect(first.found).toBe(2);
    expect(first.inserted).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(first.alreadyKnown).toBe(0);

    // Both landed in the members table under the new list.
    const members = await store.leadList.listMembers(first.listId);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.linkedinUrn).sort()).toEqual([
      'urn:li:fsd_profile:P1',
      'urn:li:fsd_profile:P2',
    ]);

    // Re-running re-finds the same people: they are now list members, so the
    // already-known filter drops them before the write (counted in alreadyKnown,
    // not duplicates), and nothing new is inserted.
    const second = (await run(
      'source_to_list',
      { accountId: ACCT, listId: first.listId, query: 'field service operations', limit: 25 },
      ports,
    )) as { found: number; inserted: number; duplicates: number; alreadyKnown: number };
    expect(second.found).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(0);
    expect(second.alreadyKnown).toBe(2);
    expect(await store.leadList.listMembers(first.listId)).toHaveLength(2);
  });

  it('rejects when neither listId nor listName is given', async () => {
    const { ports } = makePorts([person(1)]);
    await expect(run('source_to_list', { accountId: ACCT, limit: 25 }, ports)).rejects.toThrow(
      /listId or listName/,
    );
  });
});

describe('sourceToList core (shared by the CLI)', () => {
  it('runs search -> dedup -> write against the mcp ports', async () => {
    const store = new InMemoryStore();
    const lists = new LeadListAdapter(store);
    const observe = new FakeObserve([person(1), person(2)]);

    const query: PeopleQuery = { keywords: 'field service operations', limit: 25 };
    const result = await sourceToList(
      { observe, lists },
      { accountId: ACCT, listName: 'cli-list', query },
    );

    expect(result.found).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(await store.leadList.listMembers(result.listId)).toHaveLength(2);
  });

  it('returns zeros and skips the write when the search is empty', async () => {
    const store = new InMemoryStore();
    const lists = new LeadListAdapter(store);
    const observe = new FakeObserve([]);

    const result = await sourceToList(
      { observe, lists },
      { accountId: ACCT, listName: 'empty', query: { limit: 25 } },
    );
    expect(result).toMatchObject({ found: 0, inserted: 0, duplicates: 0 });
    // The list was still created; it is just empty.
    expect(await store.leadList.findById(result.listId)).toBeTruthy();
  });
});
