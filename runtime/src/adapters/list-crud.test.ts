// Tool-level tests for the lead-list edit/delete surface: update_list edits a
// list's name and/or description, and delete_list drops a list and cascades its
// members. Backed by a real InMemoryStore, driven through the MCP tools the same
// way list-hygiene.test.ts drives the hygiene surface.

import type { Ports } from '@loa/mcp';
import { AGENT_CONTEXT, TOOLS_BY_NAME } from '@loa/mcp';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { LeadListAdapter } from './mcp-ports.js';

function run(tool: string, args: Record<string, unknown>, ports: Ports) {
  const def = TOOLS_BY_NAME.get(tool);
  if (!def) throw new Error(`no such tool: ${tool}`);
  return def.handler(args as never, ports, AGENT_CONTEXT);
}

describe('lead-list edit/delete tools', () => {
  let store: InMemoryStore;
  let ports: Ports;

  beforeEach(() => {
    store = new InMemoryStore();
    ports = { lists: new LeadListAdapter(store) } as unknown as Ports;
  });

  async function seedList(name: string, description?: string) {
    const list = await store.leadList.createList(description ? { name, description } : { name });
    await store.leadList.insertMembers([
      {
        listId: list.id,
        linkedinUrn: 'urn:li:one',
        name: 'One',
        headline: 'Director of Field Operations',
        profileUrl: 'https://www.linkedin.com/in/one/',
      },
      {
        listId: list.id,
        linkedinUrn: 'urn:li:two',
        name: 'Two',
        headline: 'Head of Reliability',
        profileUrl: 'https://www.linkedin.com/in/two/',
      },
    ]);
    return list.id;
  }

  it('update_list edits name and description', async () => {
    const listId = await seedList('old name', 'old desc');
    const res = (await run(
      'update_list',
      { listId, name: 'new name', description: 'new desc' },
      ports,
    )) as { id: string; name: string; description: string | null; memberCount: number };

    expect(res.name).toBe('new name');
    expect(res.description).toBe('new desc');
    // The summary carries the live member count.
    expect(res.memberCount).toBe(2);

    const row = await store.leadList.findById(listId);
    expect(row?.name).toBe('new name');
    expect(row?.description).toBe('new desc');
  });

  it('update_list leaves the unpassed field untouched', async () => {
    const listId = await seedList('keep name', 'keep desc');
    await run('update_list', { listId, name: 'renamed' }, ports);

    const row = await store.leadList.findById(listId);
    expect(row?.name).toBe('renamed');
    // description was not passed, so it stays as seeded.
    expect(row?.description).toBe('keep desc');
  });

  it('update_list can clear the description with null', async () => {
    const listId = await seedList('has desc', 'to be cleared');
    await run('update_list', { listId, description: null }, ports);
    const row = await store.leadList.findById(listId);
    expect(row?.description ?? null).toBeNull();
  });

  it('update_list with no fields to change throws', async () => {
    const listId = await seedList('unchanged');
    // The handler validates before touching the store, so it throws synchronously.
    expect(() => run('update_list', { listId }, ports)).toThrow(/name and\/or description/);
  });

  it('update_list on a missing list returns null', async () => {
    const res = await run('update_list', { listId: 'nope', name: 'x' }, ports);
    expect(res).toBeNull();
  });

  it('delete_list removes the list and cascades its members', async () => {
    const listId = await seedList('doomed');
    const res = (await run('delete_list', { listId }, ports)) as {
      deleted: boolean;
      removedMembers: number;
    };
    expect(res.deleted).toBe(true);
    expect(res.removedMembers).toBe(2);

    // Both the list and its members are gone.
    expect(await store.leadList.findById(listId)).toBeUndefined();
    expect(await store.leadList.listMembers(listId)).toEqual([]);
    const lists = await store.leadList.listWithCounts();
    expect(lists.map((l) => l.id)).not.toContain(listId);
  });

  it('delete_list on a missing list reports deleted false', async () => {
    const res = (await run('delete_list', { listId: 'nope' }, ports)) as {
      deleted: boolean;
      removedMembers: number;
    };
    expect(res.deleted).toBe(false);
    expect(res.removedMembers).toBe(0);
  });

  it('delete_list only touches the named list', async () => {
    const keepId = await seedList('keep');
    const dropId = await seedList('drop');

    const res = (await run('delete_list', { listId: dropId }, ports)) as { deleted: boolean };
    expect(res.deleted).toBe(true);

    // The other list and its members survive.
    expect(await store.leadList.findById(keepId)).toBeDefined();
    const members = await store.leadList.listMembers(keepId);
    expect(members).toHaveLength(2);
  });
});
