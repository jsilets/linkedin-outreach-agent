// The search -> dedup -> write core behind both the source_to_list MCP tool and
// the source-to-list CLI. It speaks only the mcp ports (ObservePort +
// LeadListPort), so it stays agnostic to which store/observe backs them, and it
// lives in @loa/mcp because that is the one layer both callers reach: the tool
// handler is in this package, and the runtime CLI already depends on it.

import type { LeadListPort, ObservePort, PeopleQuery } from './ports.js';

/** Result of a source-to-list run: how many were found and how many landed. */
export interface SourceToListResult {
  listId: string;
  found: number;
  inserted: number;
  duplicates: number;
}

/**
 * Resolve the target list (creating one when only a name is given), run a live
 * people search, and write the matches into the list. The write is idempotent on
 * (listId, linkedinUrn), so re-running is safe. Returns the found/inserted/
 * duplicate counts.
 */
export async function sourceToList(
  deps: { observe: Pick<ObservePort, 'searchPeople'>; lists: LeadListPort },
  params: { accountId: string; listId?: string; listName?: string; query: PeopleQuery },
): Promise<SourceToListResult> {
  const { accountId, listId: listIdArg, listName, query } = params;
  if (!listIdArg && !listName) {
    throw new Error('source-to-list: provide either a listId or listName');
  }

  const listId = listIdArg ?? (await deps.lists.createList({ name: listName! })).id;
  const people = await deps.observe.searchPeople(accountId, query, query.limit ?? 25);
  if (people.length === 0) {
    return { listId, found: 0, inserted: 0, duplicates: 0 };
  }
  const { inserted, duplicates } = await deps.lists.insertMembers(listId, people);
  return { listId, found: people.length, inserted, duplicates };
}
