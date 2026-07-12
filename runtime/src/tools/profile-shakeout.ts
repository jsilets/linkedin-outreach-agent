// Live profile shakeout: the first real exercise of getProfile against a seeded
// LinkedIn account after the migration off the deprecated profileView endpoint
// (which now returns HTTP 410 Gone) to the modern
// voyagerIdentityDashProfileComponents graphql query. It is a READ ONLY probe —
// it never sends anything — so it is the lowest-risk way to prove the two things
// unit tests can't:
//
//   1. That the direct /voyager/api/graphql profile-components call authenticates
//      and returns the real experience section. Signal: HTTP 200 with positions.
//      A 400 usually means the hardcoded queryId is stale — capture a fresh
//      voyagerIdentityDashProfileComponents.<hash> and set LOA_PROFILE_QUERY_ID.
//   2. The component field names in the live payload (titleV2.text.text,
//      subtitle/caption/metadata.text, the pagedListComponent nesting) — it runs
//      the REAL normalizer over the REAL body and dumps the raw JSON so field
//      names can be eyeballed.
//
// Run it on a machine with the seeded vault + a visible display, on the account's
// own IP (LOA_ALLOW_NO_PROXY=true for a local check on your home connection, or
// set PROXY_* for the account's sticky proxy):
//
//   COOKIE_VAULT_KEY=... LOA_ALLOW_NO_PROXY=true \
//   node --import tsx src/tools/profile-shakeout.ts <accountId> <profileUrnOrId>
//
// The known-good target is C.J. Berg:
//   node --import tsx src/tools/profile-shakeout.ts \
//     58db1bd8-9676-4e10-89b8-04035fb39e8d urn:li:fsd_profile:ACoAABdW_WEBzkhpA61qPDWsZzaOE677Nl8ABeQ

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProxyIdentity, resolveVaultKey } from '@loa/account-runner';
import {
  InMemorySearchBudget,
  LiveObserve,
  normalizeProfileResponse,
  profileComponentsPath,
  profileIdFromUrn,
} from '../adapters/observe-live.js';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com/feed/';

async function main(): Promise<void> {
  const [accountId, urn] = process.argv.slice(2);
  if (!accountId || !urn) {
    console.error('usage: profile-shakeout <accountId> <profileUrnOrId>');
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

  const path = profileComponentsPath(profileIdFromUrn(urn));
  console.log(`[shakeout] account=${accountId}`);
  console.log(`[shakeout] urn=${urn}`);
  console.log(`[shakeout] queryId=${process.env.LOA_PROFILE_QUERY_ID || '(default)'}`);
  console.log(`[shakeout] request=${path}`);
  console.log(
    `[shakeout] mode=${identity ? `proxy ${identity.server}` : 'NO PROXY (local check)'}`,
  );

  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
    ...(identity ? { identityFor: () => identity } : {}),
  });

  const result: Record<string, unknown> = { accountId, urn };

  try {
    // --- Pass A: direct authenticated call, raw dump ------------------------
    const page = await provider.pageFor(accountId);
    if (!page.url().startsWith('https://www.linkedin.com')) {
      await page.goto(LINKEDIN_ORIGIN, { waitUntil: 'domcontentloaded' });
    }
    const { status, body } = await page.voyagerGet(path, { accept: 'application/json' });

    const rawPath = join(tmpdir(), `profile-shakeout-${accountId}-${Date.now()}.json`);
    writeFileSync(rawPath, JSON.stringify(body ?? null, null, 2));

    const profile = normalizeProfileResponse(body, urn);
    console.log('\n[shakeout] --- Pass A: direct voyager profile-components call ---');
    console.log(`[shakeout] HTTP status: ${status}`);
    console.log(`[shakeout] currentTitle:   ${profile.currentTitle ?? '(none)'}`);
    console.log(`[shakeout] currentCompany: ${profile.currentCompany ?? '(none)'}`);
    console.log(`[shakeout] positions parsed: ${profile.positions?.length ?? 0}`);
    console.log(`[shakeout] raw payload written to: ${rawPath}`);
    if (status !== 200) {
      console.log(
        `[shakeout] WARNING: HTTP ${status}. A 400/410 usually means a stale queryId or\n` +
          '           a dead endpoint. Capture a fresh voyagerIdentityDashProfileComponents.<hash>\n' +
          '           from a browser Network tab and re-run with LOA_PROFILE_QUERY_ID=... set.',
      );
    } else if ((profile.positions?.length ?? 0) === 0) {
      console.log(
        '[shakeout] WARNING: 200 but zero positions parsed — either the profile has no\n' +
          '           experience section, or the component field names drifted. Inspect the\n' +
          '           raw payload above.',
      );
    }
    (profile.positions ?? []).slice(0, 5).forEach((p, i) => {
      console.log(
        `  ${String(i + 1).padStart(2, ' ')}. ${p.title ?? '(no title)'} — ${p.company ?? '(no company)'}` +
          `${p.dateRange ? `  [${p.dateRange}]` : ''}${p.current ? ' *current*' : ''}`,
      );
    });
    result.passA = {
      status,
      currentTitle: profile.currentTitle ?? null,
      currentCompany: profile.currentCompany ?? null,
      positions: profile.positions?.length ?? 0,
      rawPath,
    };

    // --- Pass B: the real production getProfile path ------------------------
    if (status === 200) {
      const observe = new LiveObserve(provider, new InMemorySearchBudget());
      const p = await observe.getProfile(accountId, urn);
      console.log('\n[shakeout] --- Pass B: LiveObserve.getProfile ---');
      console.log(`[shakeout] headline: ${p.headline || '(none)'}`);
      console.log(`[shakeout] currentCompany: ${p.currentCompany ?? '(none)'}`);
      result.passB = { headline: p.headline, positions: p.positions?.length ?? 0 };
      result.ok = (p.positions?.length ?? 0) > 0;
    } else {
      result.ok = false;
    }
  } finally {
    await provider.close().catch(() => {
      /* ignore close errors */
    });
  }

  console.log(`\nPROFILE_SHAKEOUT_RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[shakeout] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
