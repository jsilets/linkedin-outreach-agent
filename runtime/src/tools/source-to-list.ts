// Source leads into a list: run a live people-search and write the results into
// a lead_lists / lead_list_members row set in Postgres, so they show up in the
// web UI's Lists view. This is the "lead gen visible in the UI" path end to end:
// search (proven) -> DB -> UI.
//
//   COOKIE_VAULT_KEY=... DATABASE_URL=... LOA_ALLOW_NO_PROXY=true \
//   npm run source-to-list -- <accountId> --list-name "Field ops" \
//     --keywords "field service operations" --limit 25
//
// Target an existing list with --list-id <uuid> instead of --list-name. Facets
// match search-shakeout: --title a,b  --company a,b  --company-urn 1,2  --geo id1,id2
// --network S,O  --limit N. Re-running is safe: a person already in the list is
// skipped (unique on list_id + linkedin_urn).

import { resolveProxyIdentity, resolveVaultKey } from '@loa/account-runner';
import type { PeopleQuery } from '@loa/mcp';
import { sourceToList } from '@loa/mcp';
import { loadConfig } from '../config.js';
import { makePostgresStore } from '../store/index.js';
import { LeadListAdapter } from '../adapters/mcp-ports.js';
import { LiveSessionProvider } from '../executor/session-provider.js';
import { LiveObserve, InMemorySearchBudget } from '../adapters/observe-live.js';

function csv(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseArgs(argv: string[]): {
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
  const geo = csv(flags.get('geo'));
  if (geo.length) query.geoUrns = geo;
  if (network.length) query.network = network;

  return {
    accountId: positional[0] ?? '',
    ...(flags.get('list-id')?.trim() ? { listId: flags.get('list-id')!.trim() } : {}),
    ...(flags.get('list-name')?.trim() ? { listName: flags.get('list-name')!.trim() } : {}),
    query,
  };
}

async function main(): Promise<void> {
  const { accountId, listId: listIdArg, listName, query } = parseArgs(process.argv.slice(2));
  if (!accountId || (!listIdArg && !listName)) {
    console.error(
      'usage: source-to-list <accountId> (--list-name "..." | --list-id <uuid>) ' +
        '--keywords "..." [--title a,b] [--company a,b] [--company-urn 1,2] [--geo id1,id2] ' +
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
  // Reuse the SAME store + adapter the MCP source_to_list tool uses, so the CLI
  // and the tool share one search->dedup->write path and one write target.
  const store = makePostgresStore(config.databaseUrl);
  const lists = new LeadListAdapter(store);
  const observe = new LiveObserve(provider, new InMemorySearchBudget());

  try {
    console.log(`[source] account=${accountId} query=${JSON.stringify(query)}`);
    const result = await sourceToList(
      { observe, lists },
      {
        accountId,
        ...(listIdArg ? { listId: listIdArg } : {}),
        ...(listName ? { listName } : {}),
        query,
      },
    );
    if (listName && !listIdArg) {
      console.log(`[source] created list "${listName}" -> ${result.listId}`);
    }
    console.log(`[source] search returned ${result.found} people`);
    console.log(
      `[source] added ${result.inserted} new leads to list ${result.listId} ` +
        `(${result.duplicates} already present)`,
    );
    console.log(
      `SOURCE_TO_LIST_RESULT ${JSON.stringify({ listId: result.listId, found: result.found, added: result.inserted })}`,
    );
  } finally {
    await provider.close().catch(() => {});
    await store.close().catch(() => {});
  }
}

// Run main() only as a CLI entrypoint. The module is also imported (for
// parseArgs in tests), and importing it must not kick off a live search or call
// process.exit. The search->dedup->write core lives in @loa/mcp (sourceToList),
// shared with the source_to_list MCP tool.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[source] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
