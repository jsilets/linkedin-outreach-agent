// Source leads into a list: run a live people-search and write the results into
// a lead_lists / lead_list_members row set in Postgres, so they show up in the
// web UI's Lists view. This is the "lead gen visible in the UI" path end to end:
// search (proven) -> DB -> UI.
//
//   COOKIE_VAULT_KEY=... DATABASE_URL=... LOA_ALLOW_NO_PROXY=true \
//   npm run source-to-list -- <accountId> --list-name "EV charging ops" \
//     --keywords "ev charging operations" --limit 25
//
// Target an existing list with --list-id <uuid> instead of --list-name. Facets
// match search-shakeout: --title a,b  --company a,b  --company-urn 1,2  --geo id
// --network S,O  --limit N. Re-running is safe: a person already in the list is
// skipped (unique on list_id + linkedin_urn).

import { PostgresDb } from '@loa/orchestrator';
import { db as shared } from '@loa/shared';
import { resolveProxyIdentity, resolveVaultKey } from '@loa/account-runner';
import type { PeopleQuery, PersonSearchResult } from '@loa/mcp';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';
import { LiveObserve, InMemorySearchBudget } from '../adapters/observe-live.js';

const { leadLists, leadListMembers } = shared.schema;

function csv(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseArgs(argv: string[]): {
  accountId: string;
  listId?: string;
  listName?: string;
  query: PeopleQuery;
} {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      flags.set(a.slice(2), argv[i + 1] ?? '');
      i += 1;
    } else {
      positional.push(a);
    }
  }
  const network = csv(flags.get('network')).filter(
    (n): n is 'F' | 'S' | 'O' => n === 'F' || n === 'S' || n === 'O',
  );
  const query: PeopleQuery = { limit: flags.has('limit') ? Number(flags.get('limit')) : 25 };
  const keywords = flags.get('keywords')?.trim();
  if (keywords) query.keywords = keywords;
  const title = csv(flags.get('title'));
  if (title.length) query.titleKeywords = title;
  const company = csv(flags.get('company'));
  if (company.length) query.companyKeywords = company;
  const companyUrn = csv(flags.get('company-urn'));
  if (companyUrn.length) query.companyUrns = companyUrn;
  const geo = flags.get('geo')?.trim();
  if (geo) query.geoUrn = geo;
  if (network.length) query.network = network;

  return {
    accountId: positional[0] ?? '',
    ...(flags.get('list-id')?.trim() ? { listId: flags.get('list-id')!.trim() } : {}),
    ...(flags.get('list-name')?.trim() ? { listName: flags.get('list-name')!.trim() } : {}),
    query,
  };
}

function toMemberRow(listId: string, p: PersonSearchResult) {
  return {
    listId,
    linkedinUrn: p.entityUrn || p.linkedinUrn || p.profileUrl,
    name: p.name ?? null,
    headline: p.headline ?? null,
    profileUrl: p.profileUrl ?? null,
    degree: p.degree ?? null,
    location: p.location ?? null,
    currentCompany: p.currentCompany ?? null,
  };
}

async function main(): Promise<void> {
  const { accountId, listId: listIdArg, listName, query } = parseArgs(process.argv.slice(2));
  if (!accountId || (!listIdArg && !listName)) {
    console.error(
      'usage: source-to-list <accountId> (--list-name "..." | --list-id <uuid>) ' +
        '--keywords "..." [--title a,b] [--company a,b] [--company-urn 1,2] [--geo id] ' +
        '[--network S,O] [--limit N]',
    );
    process.exit(2);
  }

  const config = loadConfig();
  resolveVaultKey();
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set; source-to-list writes leads to Postgres.');
    process.exit(2);
  }
  const identity = resolveProxyIdentity();
  if (!identity && !config.allowNoProxy) {
    console.error('refusing to open the account without a proxy; set LOA_ALLOW_NO_PROXY=true for a local check.');
    process.exit(2);
  }

  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
    ...(identity ? { identityFor: () => identity } : {}),
  });
  const pdb = new PostgresDb({ url: config.databaseUrl });

  try {
    // Resolve the target list (create it when only a name was given).
    let listId = listIdArg;
    if (!listId && listName) {
      const [row] = await pdb.handle
        .insert(leadLists)
        .values({ name: listName })
        .returning({ id: leadLists.id });
      listId = row?.id;
      console.log(`[source] created list "${listName}" -> ${listId}`);
    }
    if (!listId) throw new Error('could not resolve a list id');

    console.log(`[source] account=${accountId} query=${JSON.stringify(query)}`);
    const observe = new LiveObserve(provider, new InMemorySearchBudget());
    const people = await observe.searchPeople(accountId, query, query.limit ?? 25);
    console.log(`[source] search returned ${people.length} people`);
    if (people.length === 0) {
      console.log('[source] nothing to add.');
      return;
    }

    const rows = people.map((p) => toMemberRow(listId!, p)).filter((r) => !!r.linkedinUrn);
    // Skip anyone already in the list (unique on list_id + linkedin_urn).
    const inserted = await pdb.handle
      .insert(leadListMembers)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: leadListMembers.id });

    console.log(`[source] added ${inserted.length} new leads to list ${listId} (${people.length - inserted.length} already present)`);
    console.log(`SOURCE_TO_LIST_RESULT ${JSON.stringify({ listId, found: people.length, added: inserted.length })}`);
  } finally {
    await provider.close().catch(() => {});
    await pdb.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[source] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
