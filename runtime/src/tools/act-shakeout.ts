// Live ACTION shakeout: fire exactly ONE real action (connect / message /
// view_profile) against ONE profile on a seeded account, to prove the send path
// end-to-end on your real account. It reuses the same session-resume that
// people-search proved, mints a one-shot allow-token, and calls the real
// account-runner action.
//
// SAFETY: DRY RUN by default. Without --send it resumes the session, opens the
// profile (which does register a profile view — that is itself a benign funnel
// step), and reports which action buttons are present. It does NOT connect or
// message. Pass --send to actually perform the action.
//
//   COOKIE_VAULT_KEY=... LOA_ALLOW_NO_PROXY=true \
//   npm run act-shakeout -- <accountId> <action> <profileUrlOrUrn> [flags]
//
//   <action>  connect | message | view_profile
//   --note "..."   connection note (connect only; omitted => send without a note)
//   --body "..."   message body (message only; required with --send)
//   --send         actually perform the action (otherwise dry-run)
//
// Examples:
//   npm run act-shakeout -- <accountId> view_profile https://www.linkedin.com/in/<public-id>
//   npm run act-shakeout -- <accountId> connect https://www.linkedin.com/in/<public-id>
//   npm run act-shakeout -- <accountId> connect https://www.linkedin.com/in/<public-id> --note "Hi" --send

import {
  type ActionContext,
  type AllowToken,
  connect,
  message,
  resolveProxyIdentity,
  resolveVaultKey,
  SELECTORS,
  visitProfile,
} from '@loa/account-runner';
import type { Action, ActionType } from '@loa/shared';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';

const SUPPORTED = new Set(['connect', 'message', 'view_profile']);

/** Parse `<accountId> <action> <profileArg> --flag value ...` argv. */
function parseArgs(argv: string[]): {
  accountId: string;
  action: string;
  profileArg: string;
  note?: string;
  body?: string;
  name?: string;
  send: boolean;
} {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let send = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--send') {
      send = true;
    } else if (a.startsWith('--')) {
      flags.set(a.slice(2), argv[i + 1] ?? '');
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return {
    accountId: positional[0] ?? '',
    action: positional[1] ?? '',
    profileArg: positional[2] ?? '',
    ...(flags.has('note') ? { note: flags.get('note') } : {}),
    ...(flags.has('body') ? { body: flags.get('body') } : {}),
    ...(flags.has('name') ? { name: flags.get('name') } : {}),
    send,
  };
}

/** Accept a full profile URL or a bare urn/publicId and return a profile URL. */
function toProfileUrl(arg: string): string {
  const ref = arg.trim();
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  const id = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  return `https://www.linkedin.com/in/${encodeURIComponent(id)}/`;
}

async function main(): Promise<void> {
  const { accountId, action, profileArg, note, body, name, send } = parseArgs(
    process.argv.slice(2),
  );
  if (!accountId || !SUPPORTED.has(action) || !profileArg) {
    console.error(
      'usage: act-shakeout <accountId> <connect|message|view_profile> <profileUrlOrUrn> ' +
        '[--note "..."] [--body "..."] [--name "Full Name"] [--send]',
    );
    process.exit(2);
  }
  if (action === 'message' && send && (!body || !name)) {
    console.error(
      'message --send requires --body "..." and --name "Full Name" (composer recipient)',
    );
    process.exit(2);
  }

  const config = loadConfig();
  resolveVaultKey(); // fail fast if the vault key is missing/malformed
  const identity = resolveProxyIdentity();
  if (!identity && !config.allowNoProxy) {
    console.error(
      'refusing to open the account without a proxy: set PROXY_URL (+ geo), or ' +
        'LOA_ALLOW_NO_PROXY=true for a local check on your own connection.',
    );
    process.exit(2);
  }

  const profileUrl = toProfileUrl(profileArg);
  console.log(
    `[act] account=${accountId} action=${action} mode=${send ? 'SEND (real)' : 'DRY RUN'}`,
  );
  console.log(`[act] profile=${profileUrl}`);
  console.log(`[act] proxy=${identity ? identity.server : 'NO PROXY (local check)'}`);

  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
    ...(identity ? { identityFor: () => identity } : {}),
  });

  const result: Record<string, unknown> = { accountId, action, profileUrl, send };

  try {
    const page = await provider.pageFor(accountId);

    if (!send) {
      // Dry run: open the profile and report which action buttons are present.
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const count = async (sel: string): Promise<number> => {
        try {
          return await page.locator(sel).count();
        } catch {
          return -1;
        }
      };
      const buttons = {
        connect: await count(SELECTORS.connectButton),
        moreMenu: await count(SELECTORS.moreActionsButton),
        message: await count(SELECTORS.messageButton),
      };
      console.log('\n[act] --- DRY RUN: profile opened, nothing sent ---');
      console.log(`[act] landed on: ${page.url()}`);
      console.log(`[act] Connect button matches: ${buttons.connect}`);
      console.log(`[act] More menu matches: ${buttons.moreMenu} (connect may live here)`);
      console.log(`[act] Message button matches: ${buttons.message} (present for 1st-degree)`);
      const canConnect = buttons.connect > 0 || buttons.moreMenu > 0;
      const canMessage = buttons.message > 0;
      const ready = action === 'message' ? canMessage : action === 'connect' ? canConnect : true;
      console.log(
        `[act] ${action} looks ${ready ? 'READY' : 'NOT available'} on this profile. ` +
          `Re-run with --send to perform it.`,
      );
      result.buttons = buttons;
      result.ready = ready;
      result.ok = ready;
    } else {
      // Real send: mint a one-shot allow-token bound to a synthetic action id.
      const now = Date.now();
      const act: Action = {
        id: `act-shakeout-${now}`,
        type: action as ActionType,
        scheduledAt: new Date(now),
        executedAt: null,
        result: 'pending',
        dedupKey: `act-shakeout:${accountId}:${action}:${now}`,
        accountId,
        targetId: 'act-shakeout',
        campaignId: 'act-shakeout',
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
      const token: AllowToken = {
        kind: 'allow',
        actionId: act.id,
        accountId,
        expiresAt: now + 120_000,
        nonce: 'act-shakeout',
      };
      const ctx: ActionContext = { page, token, action: act, accountId };

      console.log('\n[act] --- SEND: performing the real action ---');
      let outcome: { ok: boolean; detail?: string };
      if (action === 'connect') {
        outcome = await connect(ctx, { profileUrl, ...(note ? { note } : {}) });
      } else if (action === 'message') {
        const memberId = profileArg.includes(':')
          ? toProfileUrl(profileArg).match(/\/in\/([^/?#]+)/)?.[1]
          : undefined;
        outcome = await message(ctx, {
          profileUrl,
          body: body ?? '',
          recipientName: name ?? '',
          ...(memberId ? { memberId } : {}),
        });
      } else {
        await visitProfile(ctx, profileUrl);
        outcome = { ok: true, detail: 'profile viewed' };
      }
      console.log(`[act] result: ok=${outcome.ok}${outcome.detail ? ` (${outcome.detail})` : ''}`);
      result.outcome = outcome;
      result.ok = outcome.ok;
    }
  } finally {
    await provider.close().catch(() => {
      /* ignore close errors */
    });
  }

  console.log(`\nACT_SHAKEOUT_RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[act] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
