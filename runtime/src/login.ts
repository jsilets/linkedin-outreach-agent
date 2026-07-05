// Assisted-login CLI: the hands-on, human-in-the-loop step that seeds an
// account's encrypted session vault (runbook step 3). It opens a headful,
// proxy-bound patchright Chromium at the LinkedIn login page, waits for a human
// to log in by hand, then persists the resulting session to the vault.
//
// Run it on a machine with a visible display (so you can see and drive the
// browser). Set the account's proxy env so LinkedIn sees the login from the
// account's sticky IP — never log a real account in off its proxy.
//
//   COOKIE_VAULT_KEY=... PROXY_URL=... PROXY_USERNAME=... PROXY_PASSWORD=... \
//   PROXY_TIMEZONE=America/New_York PROXY_LOCALE=en-US \
//   PROXY_LAT=40.7128 PROXY_LNG=-74.006 \
//   npm run login -- <accountId>
//
// LOA_ALLOW_NO_PROXY=true drops the proxy requirement for local checks only.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import {
  BrowserContextFactory,
  bootstrap,
  createPatchrightLauncher,
  resolveProxyIdentity,
  resolveVaultKey,
  type LaunchConfigInput,
  type SessionDeps,
} from '@loa/account-runner';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('usage: login <accountId>');
    process.exit(2);
  }
  const config = loadConfig();
  // Fail fast with a clear message if the vault key is missing or malformed.
  resolveVaultKey();

  const identity = resolveProxyIdentity();
  if (!identity && !config.allowNoProxy) {
    console.error(
      'refusing to log in without a proxy: set PROXY_URL (+ geo) so LinkedIn ' +
        'sees the account from its sticky IP, or LOA_ALLOW_NO_PROXY=true for a ' +
        'local check only.',
    );
    process.exit(2);
  }

  const factory = new BrowserContextFactory(createPatchrightLauncher());
  const vaultPath = join(config.vaultDir, `${accountId}.vault.json`);
  const deps: SessionDeps = {
    factory,
    vaultPath,
    accountId,
    raiseHumanTask: (task) => {
      console.log(`\n[login] ${task.kind} for ${task.accountId}: ${task.reason}`);
      if (task.atUrl) console.log(`[login] browser is at: ${task.atUrl}`);
    },
  };
  const input: LaunchConfigInput = {
    userDataDir: join(config.profileDir, accountId),
    ...(identity ? { identity } : {}),
  };

  console.log(
    `[login] opening headful Chromium for ${accountId} ` +
      `(${identity ? 'via proxy ' + identity.server : 'NO PROXY — local check'})`,
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const state = await bootstrap(deps, input, async () => {
    await rl.question(
      '\n[login] Log in to LinkedIn in the opened window. Clear any email/SMS ' +
        'check. When you see the feed, press Enter here to save the session... ',
    );
  });
  rl.close();

  const cookieCount = state.cookies.length;
  console.log(`[login] session saved to ${vaultPath} (${cookieCount} cookies).`);
  if (cookieCount === 0) {
    console.warn('[login] WARNING: zero cookies captured — login likely did not complete.');
  }
  process.exit(cookieCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[login] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
