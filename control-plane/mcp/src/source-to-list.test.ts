// Unit tests for the sourceToList core: search -> already-known filter -> write.
// The already-known filter (knownUrns) is what keeps people already in the
// system — a target in any campaign or a member of any list — from being
// re-surfaced and re-scored; only genuinely-new candidates are written.

import { describe, expect, it, vi } from 'vitest';
import type { InsertMembersResult, LeadListPort, PersonSearchResult } from './ports.js';
import { sourceToList } from './source-to-list.js';

/** A person-search result carrying a wrapped entityUrn, the shape the live
 * search emits. The bare `urn:li:fsd_profile:<id>` is the canonical key. */
function person(id: string): PersonSearchResult {
  const bare = `urn:li:fsd_profile:${id}`;
  return {
    entityUrn: `urn:li:fsd_entityResultViewModel:(${bare},SEARCH_SRP,DEFAULT)`,
    linkedinUrn: bare,
    profileUrl: `https://www.linkedin.com/in/${id}`,
    name: id,
  };
}

/** A LeadListPort fake: `known` models urns already in the system elsewhere
 * (targets / other lists); `listMembers` models who is already in the target
 * list, so insertMembers can report within-list duplicates. */
function fakeLists(opts: {
  known: Set<string>;
  listMembers: Set<string>;
}): LeadListPort & { knownUrns: ReturnType<typeof vi.fn> } {
  const knownUrns = vi.fn(async (urns: string[]) => {
    return new Set(urns.filter((u) => opts.known.has(u)));
  });
  return {
    createList: async () => ({ id: 'list-1', name: 'x' }),
    updateList: async () => null,
    deleteList: async () => ({ deleted: false, removedMembers: 0 }),
    listLists: async () => [],
    getList: async () => null,
    async insertMembers(
      _listId: string,
      people: PersonSearchResult[],
    ): Promise<InsertMembersResult> {
      let inserted = 0;
      for (const p of people) {
        const key = p.linkedinUrn ?? p.entityUrn;
        if (opts.listMembers.has(key)) continue;
        opts.listMembers.add(key);
        inserted += 1;
      }
      return { inserted, duplicates: people.length - inserted };
    },
    removeMembers: async () => ({ removed: 0 }),
    knownUrns,
  };
}

describe('sourceToList', () => {
  it('drops already-known people, counts within-list dups, inserts only the new', async () => {
    // A: already a target/other-list member (already known). B: already in the
    // target list (within-list dup). C, D: genuinely new.
    const alreadyKnown = 'urn:li:fsd_profile:A';
    const withinList = 'urn:li:fsd_profile:B';
    const lists = fakeLists({
      known: new Set([alreadyKnown]),
      listMembers: new Set([withinList]),
    });
    const observe = {
      searchPeople: vi.fn(async () => [person('A'), person('B'), person('C'), person('D')]),
    };

    const result = await sourceToList(
      { observe, lists },
      { accountId: 'acct-1', listId: 'list-1', query: { keywords: 'ops', limit: 25 } },
    );

    expect(result).toEqual({
      listId: 'list-1',
      found: 4,
      inserted: 2,
      duplicates: 1,
      alreadyKnown: 1,
    });
    // knownUrns is asked with the canonical bare keys, not the wrapped entityUrns.
    expect(lists.knownUrns).toHaveBeenCalledWith([
      'urn:li:fsd_profile:A',
      'urn:li:fsd_profile:B',
      'urn:li:fsd_profile:C',
      'urn:li:fsd_profile:D',
    ]);
  });

  it('returns zeros without writing when every candidate is already known', async () => {
    const lists = fakeLists({
      known: new Set(['urn:li:fsd_profile:A', 'urn:li:fsd_profile:B']),
      listMembers: new Set(),
    });
    const insertSpy = vi.spyOn(lists, 'insertMembers');
    const observe = { searchPeople: vi.fn(async () => [person('A'), person('B')]) };

    const result = await sourceToList(
      { observe, lists },
      { accountId: 'acct-1', listId: 'list-1', query: {} },
    );

    expect(result).toEqual({
      listId: 'list-1',
      found: 2,
      inserted: 0,
      duplicates: 0,
      alreadyKnown: 2,
    });
    // No write attempt when nothing is fresh.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('does not query knownUrns when the search returns nobody', async () => {
    const lists = fakeLists({ known: new Set(), listMembers: new Set() });
    const observe = { searchPeople: vi.fn(async () => []) };

    const result = await sourceToList(
      { observe, lists },
      { accountId: 'acct-1', listName: 'New list', query: {} },
    );

    expect(result).toEqual({
      listId: 'list-1',
      found: 0,
      inserted: 0,
      duplicates: 0,
      alreadyKnown: 0,
    });
    expect(lists.knownUrns).not.toHaveBeenCalled();
  });
});
