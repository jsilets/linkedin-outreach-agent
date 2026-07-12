// Live inbox shakeout: the first real exercise of the modern messenger read
// against a seeded LinkedIn account. READ ONLY — it never sends anything. It
// proves the three things unit tests can't:
//
//   1. The CURRENT messengerConversations queryId. LinkedIn rotates the hash per
//      web build and the code default is best-effort; this captures the real one
//      by sniffing the XHR the flagship /messaging/ page itself fires (Pass A).
//   2. That the direct voyagerMessagingGraphQL call authenticates and returns
//      real conversations with that queryId (Pass B). A 400 means stale hash.
//   3. The live payload field names — it runs the REAL normalizeInboxResponse
//      over BOTH captured bodies and dumps the raw JSON so field names can be
//      eyeballed and the parser adjusted (messages.elements[].body.text etc.).
//
// The runtime holds the account's browser profile lock, so STOP it first:
//
//   launchctl bootout gui/$(id -u)/com.loa.runtime
//   npm run inbox-shakeout -- <accountId>
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.loa.runtime.plist
//
// Flags: --count 10 (conversations to request on the direct read).

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProxyIdentity, resolveVaultKey } from '@loa/account-runner';
import {
  mailboxUrnFromMe,
  messengerConversationsPath,
  normalizeInboxResponse,
} from '../adapters/observe-live.js';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const GRAPHQL_MARKER = 'voyagerMessagingGraphQL/graphql';

function parseArgs(argv: string[]): { accountId: string; count: number } {
  const positional: string[] = [];
  let count = 10;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--count') {
      count = Number(argv[i + 1] ?? '10') || 10;
      i += 1;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { accountId: positional[0] ?? '', count };
}

/** Pull queryId=... out of a captured graphql request URL. */
function queryIdFromUrl(url: string): string | undefined {
  return url.match(/[?&]queryId=([A-Za-z0-9._-]+)/)?.[1];
}

function dump(label: string, accountId: string, body: unknown): string {
  const path = join(tmpdir(), `inbox-shakeout-${label}-${accountId}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(body ?? null, null, 2));
  return path;
}

async function main(): Promise<void> {
  const { accountId, count } = parseArgs(process.argv.slice(2));
  if (!accountId) {
    console.error('usage: inbox-shakeout <accountId> [--count 10]');
    process.exit(2);
  }

  const config = loadConfig();
  resolveVaultKey(); // fail fast before opening a browser
  const identity = resolveProxyIdentity();
  if (!identity && !config.allowNoProxy) {
    console.error(
      'refusing to open the account without a proxy: set PROXY_URL or LOA_ALLOW_NO_PROXY=true',
    );
    process.exit(2);
  }

  console.log(`[shakeout] account=${accountId}`);
  console.log(
    `[shakeout] mode=${identity ? `proxy ${identity.server}` : 'NO PROXY (local check)'}`,
  );

  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
    ...(identity ? { identityFor: () => identity } : {}),
  });

  let failed = false;
  try {
    const page = await provider.pageFor(accountId);

    // --- Pass A: sniff the flagship messaging page's own graphql XHR ---------
    // Arm the waiter BEFORE goto so the racing XHR can't be missed.
    console.log('\n[shakeout] --- Pass A: sniff /messaging/ ---');
    const sniffed = page
      .waitForResponse(GRAPHQL_MARKER, { timeoutMs: 20000 })
      .catch(() => undefined);
    await page.goto(MESSAGING_URL, { waitUntil: 'domcontentloaded' });
    const hit = await sniffed;

    let capturedQueryId: string | undefined;
    if (hit) {
      capturedQueryId = queryIdFromUrl(hit.url);
      console.log(`[shakeout] sniffed request: ${hit.url.slice(0, 160)}...`);
      console.log(`[shakeout] sniffed HTTP status: ${hit.status}`);
      console.log(`[shakeout] captured queryId: ${capturedQueryId ?? '(none in URL)'}`);
      const body = await hit.json().catch(() => undefined);
      if (body !== undefined) {
        const rawPath = dump('sniffed', accountId, body);
        const normalized = normalizeInboxResponse(body);
        console.log(`[shakeout] raw sniffed payload: ${rawPath}`);
        console.log(`[shakeout] normalizer over sniffed payload: ${normalized.length} inbound`);
      }
    } else {
      console.log('[shakeout] no voyagerMessagingGraphQL XHR observed within 20s');
    }

    // --- Pass B: direct read via the adapter path with the captured hash -----
    console.log('\n[shakeout] --- Pass B: direct messengerConversations read ---');
    if (capturedQueryId) process.env.LOA_INBOX_QUERY_ID = capturedQueryId;
    console.log(`[shakeout] queryId in use: ${process.env.LOA_INBOX_QUERY_ID || '(code default)'}`);

    const me = await page.voyagerGet('/voyager/api/me', { accept: 'application/json' });
    console.log(`[shakeout] /voyager/api/me HTTP status: ${me.status}`);
    const mailboxUrn = process.env.LOA_MAILBOX_URN?.trim() || mailboxUrnFromMe(me.body);
    console.log(`[shakeout] mailboxUrn: ${mailboxUrn ?? '(UNRESOLVED)'}`);
    if (!mailboxUrn) {
      const mePath = dump('me', accountId, me.body);
      console.log(`[shakeout] raw /me payload for eyeballing: ${mePath}`);
      failed = true;
    } else {
      const path = messengerConversationsPath(mailboxUrn, count);
      console.log(`[shakeout] request: ${path.slice(0, 160)}...`);
      const { status, body } = await page.voyagerGet(path, { accept: 'application/json' });
      const rawPath = dump('direct', accountId, body);
      const normalized = normalizeInboxResponse(body);
      console.log(`[shakeout] direct HTTP status: ${status}`);
      console.log(`[shakeout] raw direct payload: ${rawPath}`);
      console.log(`[shakeout] normalizer over direct payload: ${normalized.length} inbound`);
      normalized.slice(0, 5).forEach((m, i) => {
        console.log(
          `  ${i + 1}. from=${m.senderUrn} at=${m.receivedAt.toISOString()}` +
            `\n     "${m.text.slice(0, 80)}"`,
        );
      });
      if (status !== 200) failed = true;
      if (status === 200 && normalized.length === 0) {
        console.log(
          '[shakeout] 200 but zero inbound normalized — either the inbox truly has no ' +
            'counterparty messages in the window, or the parser field names are off; ' +
            'eyeball the raw payload above.',
        );
      }
    }

    if (capturedQueryId) {
      console.log(
        `\n[shakeout] SET THIS: LOA_INBOX_QUERY_ID=${capturedQueryId} (and update ` +
          'DEFAULT_INBOX_QUERY_ID in observe-live.ts)',
      );
    }
  } finally {
    await provider.close?.();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('[shakeout] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
