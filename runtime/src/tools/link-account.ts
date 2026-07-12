// Link an account from pasted session cookies (the CLI twin of the UI "Connect
// LinkedIn" flow). Prompts for the li_at and JSESSIONID cookies, builds the
// Playwright storage state, and seals it into the vault — no headful login.
//
// This is the fastest way to PROVE the paste path drives the browser: link with
// your real cookies, then `npm run search-shakeout -- <accountId>` against the
// same vault. Get the cookies from a logged-in LinkedIn tab:
//   DevTools -> Application -> Cookies -> https://www.linkedin.com
//   copy the VALUE of `li_at` and of `JSESSIONID`.
//
//   COOKIE_VAULT_KEY=... npm run link-account -- <accountId>
//
// Secrets are read from a prompt (not argv) so they do not land in shell history.

import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  buildStorageStateFromPastedCookies,
  extractSessionCookies,
  resolveVaultKey,
  saveStorageState,
} from '@loa/account-runner';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('usage: link-account <accountId>');
    process.exit(2);
  }
  const config = loadConfig();
  resolveVaultKey(); // fail fast if COOKIE_VAULT_KEY is missing/malformed

  const rl = createInterface({ input: stdin, output: stdout });
  const liAt = (await rl.question('Paste li_at value: ')).trim();
  const jsessionId = (await rl.question('Paste JSESSIONID value: ')).trim();
  rl.close();

  const state = buildStorageStateFromPastedCookies({ liAt, jsessionId });
  const vaultPath = join(config.vaultDir, `${accountId}.vault.json`);
  await saveStorageState(vaultPath, state);

  const { liAt: gotLiAt, jsessionId: gotJsession } = extractSessionCookies(state);
  console.log(`\n[link] sealed vault for ${accountId} -> ${vaultPath}`);
  console.log(
    `[link] li_at present: ${gotLiAt ? 'yes' : 'no'}, JSESSIONID present: ${gotJsession ? 'yes' : 'no'}`,
  );
  console.log(`[link] verify it drives the browser:`);
  console.log(
    `[link]   LOA_ALLOW_NO_PROXY=true npm run search-shakeout -- ${accountId} --keywords "field service operations"`,
  );
}

main().catch((err) => {
  console.error('[link] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
