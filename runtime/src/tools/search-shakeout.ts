// Live search shakeout: the first real exercise of people-search against a
// seeded LinkedIn account. It is a READ ONLY probe — it never sends anything —
// so it is the lowest-risk way to prove the two things unit tests can't:
//
//   1. That the direct /voyager/api/graphql call authenticates and returns the
//      real people-results cluster (not a decoy). Signal: HTTP 200 with people.
//      A 400 usually means the hardcoded queryId is stale — set LOA_SEARCH_QUERY_ID.
//   2. The entityResult field names in the live payload (title / primarySubtitle
//      / navigationUrl / memberDistance) — it runs the REAL normalizer over the
//      REAL body and dumps the raw JSON so field names can be eyeballed.
//
// Run it on a machine with the seeded vault + a visible display, on the account's
// own IP (LOA_ALLOW_NO_PROXY=true for a local check on your home connection, or
// set PROXY_* for the account's sticky proxy):
//
//   COOKIE_VAULT_KEY=... LOA_ALLOW_NO_PROXY=true \
//   npm run search-shakeout -- <accountId> --keywords "field service operations" --limit 25
//
// Flags (all optional except the positional accountId):
//   --keywords "..."          free-text search box
//   --title a,b,c             titleKeywords (also the manager+ seniority proxy)
//   --company a,b             companyKeywords (free text)
//   --company-urn 1035,2048   currentCompany facet entity ids
//   --geo 103644278           geoUrn (bare geo id; 103644278 = United States)
//   --network S,O             connection degree F=1st S=2nd O=3rd+
//   --limit 25                max results across pages

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProxyIdentity, resolveVaultKey } from '@loa/account-runner';
import type { PeopleQuery, PersonSearchResult } from '@loa/mcp';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';
import {
  LiveObserve,
  InMemorySearchBudget,
  buildVoyagerGraphqlPath,
  normalizeSearchResponse,
} from '../adapters/observe-live.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com/feed/';

/** Split a comma-separated flag value into a trimmed, non-empty array. */
function csv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse `<accountId> --flag value` argv into an account id + PeopleQuery. */
function parseArgs(argv: string[]): { accountId: string; query: PeopleQuery } {
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
  const accountId = positional[0] ?? '';

  const network = csv(flags.get('network')).filter(
    (n): n is 'F' | 'S' | 'O' => n === 'F' || n === 'S' || n === 'O',
  );
  const query: PeopleQuery = {
    limit: flags.has('limit') ? Number(flags.get('limit')) : 25,
  };
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

  // A totally empty query would page LinkedIn's "everyone" list; default to a
  // broad but meaningful keyword so the probe returns real people to inspect.
  if (
    !query.keywords &&
    !query.titleKeywords &&
    !query.companyKeywords &&
    !query.companyUrns &&
    !query.geoUrn &&
    !query.network
  ) {
    query.keywords = 'field service operations';
  }
  return { accountId, query };
}

function printPeople(people: PersonSearchResult[]): void {
  people.forEach((p, i) => {
    const n = String(i + 1).padStart(2, ' ');
    console.log(
      `  ${n}. ${p.name ?? '(no name)'} — ${p.headline ?? '(no headline)'}` +
        `\n       ${p.degree ? `[${p.degree}] ` : ''}${p.location ?? ''}` +
        `\n       ${p.profileUrl || '(no url)'}`,
    );
  });
}

async function main(): Promise<void> {
  const { accountId, query } = parseArgs(process.argv.slice(2));
  if (!accountId) {
    console.error(
      'usage: search-shakeout <accountId> [--keywords "..."] [--title a,b] ' +
        '[--company a,b] [--company-urn 1,2] [--geo 103644278] [--network S,O] [--limit 25]',
    );
    process.exit(2);
  }

  const config = loadConfig();
  // Fail fast with a clear message before we open a browser.
  resolveVaultKey();
  const identity = resolveProxyIdentity();
  if (!identity && !config.allowNoProxy) {
    console.error(
      'refusing to open the account without a proxy: set PROXY_URL (+ geo) so ' +
        'LinkedIn sees the account from its sticky IP, or LOA_ALLOW_NO_PROXY=true ' +
        'for a local check on your own connection.',
    );
    process.exit(2);
  }

  const path = buildVoyagerGraphqlPath(query, 0, 10);
  console.log(`[shakeout] account=${accountId}`);
  console.log(`[shakeout] query=${JSON.stringify(query)}`);
  console.log(`[shakeout] queryId=${process.env.LOA_SEARCH_QUERY_ID || '(default)'}`);
  console.log(`[shakeout] page-1 request=${path}`);
  console.log(
    `[shakeout] mode=${identity ? 'proxy ' + identity.server : 'NO PROXY (local check)'}`,
  );

  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
    ...(identity ? { identityFor: () => identity } : {}),
  });

  const result: Record<string, unknown> = { accountId, query };

  try {
    // --- Pass A: direct authenticated call, page 1, raw dump ----------------
    const page = await provider.pageFor(accountId);
    // Same-origin fetch needs the page on linkedin.com so cookies attach.
    if (!page.url().startsWith('https://www.linkedin.com')) {
      await page.goto(LINKEDIN_ORIGIN, { waitUntil: 'domcontentloaded' });
    }
    const { status, body } = await page.voyagerGet(path, { accept: 'application/json' });

    const rawPath = join(tmpdir(), `search-shakeout-${accountId}-${Date.now()}.json`);
    writeFileSync(rawPath, JSON.stringify(body ?? null, null, 2));

    const normalized = normalizeSearchResponse(body);
    console.log('\n[shakeout] --- Pass A: direct voyager call (page 1) ---');
    console.log(`[shakeout] HTTP status: ${status}`);
    console.log(`[shakeout] normalized people on page 1: ${normalized.length}`);
    console.log(`[shakeout] raw payload written to: ${rawPath}`);
    if (status !== 200) {
      console.log(
        `[shakeout] WARNING: HTTP ${status}. A 400/401 usually means a stale queryId\n` +
          '           or an invalid session. Capture a fresh voyagerSearchDashClusters.<hash>\n' +
          '           from a browser Network tab and re-run with LOA_SEARCH_QUERY_ID=... set.',
      );
    } else if (normalized.length === 0) {
      console.log(
        '[shakeout] WARNING: 200 but zero people parsed — either the query matched\n' +
          '           nothing, or the entityResult field names drifted. Inspect the raw\n' +
          '           payload above.',
      );
    }
    if (normalized.length > 0) {
      console.log('[shakeout] first 3 normalized:');
      printPeople(normalized.slice(0, 3));
    }
    result.passA = {
      status,
      page1Count: normalized.length,
      rawPath,
      fieldsPopulated: {
        name: normalized.some((p) => !!p.name),
        headline: normalized.some((p) => !!p.headline),
        profileUrl: normalized.some((p) => !!p.profileUrl),
        degree: normalized.some((p) => !!p.degree),
        location: normalized.some((p) => !!p.location),
      },
    };

    // --- Pass B: the real production searchPeople path (paginates + dedup) --
    if (status === 200) {
      const observe = new LiveObserve(provider, new InMemorySearchBudget());
      const people = await observe.searchPeople(accountId, query, query.limit ?? 25);
      console.log('\n[shakeout] --- Pass B: LiveObserve.searchPeople ---');
      console.log(`[shakeout] returned ${people.length} people:`);
      printPeople(people);
      result.passB = { returned: people.length };
      result.ok = people.length > 0;
    } else {
      result.ok = false;
    }
  } finally {
    await provider.close().catch(() => {
      /* ignore close errors */
    });
  }

  console.log(`\nSEARCH_SHAKEOUT_RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[shakeout] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
