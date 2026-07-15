// Repair leads whose stored name is a LinkedIn-truncated stub.
//
// A lead sourced from people-search carries whatever LinkedIn shows a stranger,
// which for an out-of-network person is an abbreviated surname ("R S.", "Joe D.").
// Once the invite is accepted the person is 1st-degree and their real name is
// visible, so AcceptanceTick now captures it at the moment of acceptance
// (dispatch/acceptance-tick.ts). That fix is forward-only: leads that were
// already released before it landed still hold their stub, and the composer
// addresses recipients by typing the name into LinkedIn's typeahead — a stub
// finds nobody. This script repairs those.
//
// Reads the live connections list through the RUNNING runtime's MCP server, so
// it reuses that process's authenticated session rather than contending for the
// Chrome profile lock. Writes only external_context.name, only on targets whose
// stored name is truncated and for which the connections list offers a better one.
//
//   npm run repair-names -- --dry-run    # print the plan, write nothing
//   npm run repair-names                 # apply
//
// Idempotent: a repaired name is no longer truncated, so a second run is a no-op.

import { isTruncatedName } from '@loa/shared';
import postgres from 'postgres';

const MCP_URL = `http://127.0.0.1:${process.env.MCP_PORT ?? 8090}/mcp`;
const TOKEN = process.env.LOA_MCP_TOKEN ?? '';
const CONNECTIONS_LIMIT = 100;

interface RecentConnection {
  entityUrn: string;
  profileUrl?: string;
  name?: string;
}

/** The bare fsd_profile/person id inside a urn, for identity matching. */
function idTail(urn: string | undefined): string | undefined {
  return urn?.match(/urn:li:(?:fsd_profile|person|member):([A-Za-z0-9_-]+)/)?.[1];
}

/** The /in/<vanity> slug of a profile url. */
function vanityOf(url: string | undefined): string | undefined {
  return url?.match(/\/in\/([^/?#]+)/)?.[1]?.toLowerCase();
}

/** Call one MCP tool over the running server's HTTP endpoint. */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${name} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  // The server may answer as SSE; take the last data: line either way.
  const payload = text.includes('data:')
    ? (
        text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .pop() ?? ''
      ).replace(/^data:\s*/, '')
    : text;
  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(`MCP ${name} -> ${JSON.stringify(parsed.error)}`);
  const content = parsed.result?.content?.[0];
  if (content?.type === 'text') return JSON.parse(content.text);
  return parsed.result?.structuredContent ?? parsed.result;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url);

  try {
    const accounts = await sql<{ id: string; handle: string }[]>`
      select id, handle from accounts
    `;

    let repaired = 0;
    let unmatched = 0;

    for (const account of accounts) {
      // Every target this account has an enrollment for, whose stored name is a
      // stub. Scoped to the account so a connections list only ever repairs the
      // leads that account actually owns.
      const rows = await sql<
        { id: string; linkedin_urn: string; prospect_ref: string; name: string | null }[]
      >`
        select distinct t.id, t.linkedin_urn, t.prospect_ref,
               t.external_context->>'name' as name
        from targets t
        join target_progress tp on tp.target_id = t.id
        where tp.account_id = ${account.id}
      `;
      const stubs = rows.filter((r) => isTruncatedName(r.name));
      if (stubs.length === 0) {
        console.log(`[${account.handle}] no truncated names; nothing to repair`);
        continue;
      }

      console.log(`[${account.handle}] ${stubs.length} truncated name(s); reading connections...`);
      const connections = (await callTool('list_recent_connections', {
        accountId: account.id,
        limit: CONNECTIONS_LIMIT,
      })) as RecentConnection[];
      console.log(`[${account.handle}] connections read: ${connections.length}`);

      for (const stub of stubs) {
        // Match on the same two identities the acceptance tick uses: the profile
        // urn's id, or the /in/ vanity.
        const wantId = idTail(stub.linkedin_urn);
        const wantVanity = stub.prospect_ref.toLowerCase();
        const hit = connections.find((c) => {
          const cid = idTail(c.entityUrn);
          return (
            (wantId && cid && cid === wantId) ||
            (wantVanity && vanityOf(c.profileUrl) === wantVanity)
          );
        });

        if (!hit?.name) {
          console.log(
            `  SKIP  "${stub.name}" (${stub.prospect_ref}) — not in the connections list`,
          );
          unmatched++;
          continue;
        }
        if (isTruncatedName(hit.name)) {
          console.log(
            `  SKIP  "${stub.name}" (${stub.prospect_ref}) — connection name is also a stub`,
          );
          unmatched++;
          continue;
        }

        console.log(
          `  ${dryRun ? 'WOULD' : 'FIX  '} "${stub.name}" -> "${hit.name}" (${stub.prospect_ref})`,
        );
        if (!dryRun) {
          await sql`
            update targets
               set external_context = external_context || ${sql.json({ name: hit.name })},
                   updated_at = now()
             where id = ${stub.id}
          `;
          await sql`
            insert into events (kind, account_id, payload)
            values ('lead_name_refreshed', ${account.id},
                    ${sql.json({ targetId: stub.id, from: stub.name, to: hit.name, via: 'backfill' })})
          `;
        }
        repaired++;
      }
    }

    console.log(
      `\n${dryRun ? '[dry run] would repair' : 'repaired'}: ${repaired}; unmatched: ${unmatched}`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
