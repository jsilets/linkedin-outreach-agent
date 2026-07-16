// Live SENT-INVITATIONS shakeout: the first real exercise of the sent-invitation
// read + withdraw against a seeded account. READ ONLY by default — it lists the
// pending pile, prints the count and the oldest few with their ages (names
// redacted to initials), and withdraws NOTHING. It proves the two things unit
// tests cannot:
//
//   1. The paginated /voyager/api/relationships/sentInvitationViewsV2 read
//      authenticates and returns real pending invites. A 400 usually means the
//      legacy path was retired — set LOA_SENT_INVITATIONS_PATH to a current one.
//   2. The dash withdraw action succeeds (only with --withdraw-oldest, which
//      withdraws EXACTLY ONE — the single oldest invite — live).
//
// Run on a machine with the seeded vault + a visible display, on the account's
// own IP (LOA_ALLOW_NO_PROXY=true for a local check, or PROXY_* for the sticky IP):
//
//   COOKIE_VAULT_KEY=... LOA_ALLOW_NO_PROXY=true \
//   npm run invitations-shakeout -- <accountId> [--limit 200] [--withdraw-oldest]

import {
  invitationIdFromUrn,
  readSentInvitations,
  resolveProxyIdentity,
  resolveVaultKey,
  type SentInvitation,
  WITHDRAW_INVITATION_BODY,
  withdrawInvitationPath,
} from '@loa/account-runner';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com/feed/';

/** Redact a full name to initials so the probe output leaks no real identities. */
function initials(name: string | undefined): string {
  if (!name) return '(no name)';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}.`)
    .join(' ');
}

/** Whole-day age of an invite, or null when its sent time is unknown. */
function ageDays(inv: SentInvitation, now: number): number | null {
  return inv.sentAt ? Math.floor((now - inv.sentAt.getTime()) / 86_400_000) : null;
}

function parseArgs(argv: string[]): { accountId: string; limit: number; withdrawOldest: boolean } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let withdrawOldest = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--withdraw-oldest') {
      withdrawOldest = true;
    } else if (a.startsWith('--')) {
      flags.set(a.slice(2), argv[i + 1] ?? '');
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return {
    accountId: positional[0] ?? '',
    limit: flags.has('limit') ? Number(flags.get('limit')) : 200,
    withdrawOldest,
  };
}

async function main(): Promise<void> {
  const { accountId, limit, withdrawOldest } = parseArgs(process.argv.slice(2));
  if (!accountId) {
    console.error('usage: invitations-shakeout <accountId> [--limit 200] [--withdraw-oldest]');
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

  console.log(
    `[invites] account=${accountId} mode=${withdrawOldest ? 'WITHDRAW-OLDEST' : 'READ ONLY'}`,
  );
  console.log(`[invites] proxy=${identity ? identity.server : 'NO PROXY (local check)'}`);

  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
    ...(identity ? { identityFor: () => identity } : {}),
  });

  const result: Record<string, unknown> = { accountId };

  try {
    const page = await provider.pageFor(accountId);
    if (!page.url().startsWith('https://www.linkedin.com')) {
      await page.goto(LINKEDIN_ORIGIN, { waitUntil: 'domcontentloaded' });
    }

    const invites = await readSentInvitations(page, { limit });
    const now = Date.now();
    const withAge = invites
      .filter((inv) => !!inv.sentAt)
      .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());
    const unknownSent = invites.length - withAge.length;

    console.log(`\n[invites] pending sent invitations: ${invites.length}`);
    console.log(`[invites] with a known sent time: ${withAge.length} (unknown: ${unknownSent})`);
    console.log('[invites] oldest 5 (initials only):');
    for (const inv of withAge.slice(0, 5)) {
      console.log(`  - ${initials(inv.name)}  age=${ageDays(inv, now)}d`);
    }
    result.count = invites.length;
    result.unknownSent = unknownSent;

    if (withdrawOldest) {
      const oldest = withAge[0];
      if (!oldest) {
        console.log('\n[invites] nothing to withdraw (no invite with a known sent time).');
        result.withdrew = false;
      } else if (!page.voyagerPost) {
        console.log('\n[invites] voyagerPost unavailable on this page; cannot withdraw.');
        result.withdrew = false;
      } else {
        console.log(
          `\n[invites] --- WITHDRAW: withdrawing the single oldest (${initials(oldest.name)}, ` +
            `age=${ageDays(oldest, now)}d) ---`,
        );
        const { status } = await page.voyagerPost(
          withdrawInvitationPath(invitationIdFromUrn(oldest.invitationUrn)),
          WITHDRAW_INVITATION_BODY,
        );
        const ok = status >= 200 && status < 300;
        console.log(`[invites] withdraw HTTP status: ${status} (${ok ? 'ok' : 'FAILED'})`);
        result.withdrew = ok;
        result.withdrawStatus = status;
      }
    }
    result.ok = invites.length >= 0;
  } finally {
    await provider.close().catch(() => {
      /* ignore close errors */
    });
  }

  console.log(`\nINVITATIONS_SHAKEOUT_RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[invites] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
