// Selector live-scan (runbook step 5): verify the shared selector map against a
// live LinkedIn page before trusting it in production. It resumes a vaulted
// account session, opens a profile URL, and reports for every selector whether
// it currently matches the live DOM. The verify-live selectors (the restriction
// and challenge signals the detector depends on) are called out explicitly, so
// an operator can confirm they still fire before a run.
//
// This resumes a real session, so it needs a prior assisted login (runbook step
// 3) to have seeded the account's vault. It cannot be exercised without a seeded
// session and browser binaries.
//
//   COOKIE_VAULT_KEY=... LOA_VAULT_DIR=... LOA_PROFILE_DIR=... \
//   npm run -w runtime selector-scan -- <accountId> <profileUrl>
//
// LOA_ALLOW_NO_PROXY=true drops the proxy requirement for local checks only.

import { SELECTORS, type SelectorKey } from '@loa/account-runner';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';

// The verify-live keys: DOM facts the detector leans on that MUST be re-checked
// against a live page after any LinkedIn markup change (see selectors.ts).
const VERIFY_LIVE: readonly SelectorKey[] = [
  'weeklyLimitAlert',
  'viewLimitWarning',
  'challengeContainer',
  'banBanner',
];

/** Per-selector scan outcome: matched (with count), missed, or errored. */
type ScanState =
  | { readonly kind: 'match'; readonly count: number }
  | { readonly kind: 'miss' }
  | { readonly kind: 'error'; readonly message: string };

interface ScanRow {
  readonly key: SelectorKey;
  readonly selector: string;
  readonly verifyLive: boolean;
  readonly state: ScanState;
}

function stateLabel(state: ScanState): string {
  switch (state.kind) {
    case 'match':
      return `MATCH ${state.count}`;
    case 'miss':
      return 'MISS';
    case 'error':
      return `ERR (${state.message})`;
  }
}

async function main(): Promise<void> {
  const accountId = process.argv[2];
  const profileUrl = process.argv[3];
  if (!accountId || !profileUrl) {
    console.error('usage: selector-scan <accountId> <profileUrl>');
    process.exit(2);
  }

  const config = loadConfig();
  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
  });

  try {
    console.log(`[scan] resuming session for ${accountId}`);
    const page = await provider.pageFor(accountId);

    console.log(`[scan] navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    // Short settle so lazy client-rendered markup has a chance to attach.
    await page.waitForTimeout(2000);
    console.log(`[scan] landed at ${page.url()}`);

    const keys = Object.keys(SELECTORS) as SelectorKey[];
    const rows: ScanRow[] = [];
    for (const key of keys) {
      const selector = SELECTORS[key];
      const verifyLive = VERIFY_LIVE.includes(key);
      let state: ScanState;
      try {
        const count = await page.locator(selector).count();
        state = count > 0 ? { kind: 'match', count } : { kind: 'miss' };
      } catch (err) {
        state = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
      rows.push({ key, selector, verifyLive, state });
    }

    // Human-readable report. Verify-live rows are marked with a leading '*'.
    const keyWidth = Math.max(...rows.map((r) => r.key.length));
    console.log('\n[scan] results (* = verify-live selector the detector depends on):\n');
    for (const row of rows) {
      const mark = row.verifyLive ? '*' : ' ';
      const label = stateLabel(row.state).padEnd(12);
      console.log(`${mark} ${row.key.padEnd(keyWidth)}  [${label}]  ${row.selector}`);
    }

    const matched = rows.filter((r) => r.state.kind === 'match').length;
    const missed = rows.filter((r) => r.state.kind === 'miss').length;
    const verifyLive: Record<string, string> = {};
    for (const row of rows.filter((r) => r.verifyLive)) {
      verifyLive[row.key] = stateLabel(row.state);
    }

    console.log(
      '\nSELECTOR_SCAN_RESULT ' +
        JSON.stringify({ total: rows.length, matched, missed, verifyLive }),
    );
  } finally {
    await provider.close();
  }
}

main().catch((err) => {
  console.error('[scan] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
