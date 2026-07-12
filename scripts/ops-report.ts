// Ops report: a read-only, at-a-glance health dump of the local runtime, printed
// as markdown to stdout. It is the offline half of the observability seam — where
// GET /api/errors gives the web UI a live errors feed, this gives a Claude Code
// "dogfood-review" session (or a human at a terminal) a single scan over the
// last N hours: what failed, what is stuck, how sends are landing, how close
// accounts are to their caps, and how stale the approval queue is.
//
// It NEVER mutates: every statement is a SELECT. Run it against the same Postgres
// the runtime uses:
//
//   npm run ops:report                 # last 24h
//   npm run ops:report -- --hours 72   # last 72h
//
// or directly:
//
//   node --env-file-if-exists=.env --import tsx scripts/ops-report.ts --hours 48
//
// The failure-kind set and the active-progress-state set are imported from
// @loa/shared so this script and the runtime never drift on what "a failure" or
// "an active cursor" means.

import {
  ACTION_TYPES,
  ACTIVE_PROGRESS_STATES,
  type ActionType,
  isFailureEventKind,
} from '@loa/shared';
import postgres from 'postgres';

const STUCK_THRESHOLD_MINUTES = 30;

interface Caps {
  caps?: Partial<Record<ActionType, number>>;
}
interface Budget {
  date?: string;
  used?: Partial<Record<ActionType, number>>;
}

/** Parse `--hours N` out of argv; default 24, floor 1. */
function parseHours(argv: string[]): number {
  const i = argv.indexOf('--hours');
  if (i === -1) return 24;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.floor(n);
}

/** ms -> compact "2d 3h" / "45m" / "12s" for age columns. */
function humanizeAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function iso(ts: unknown): string {
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

/** A markdown table from a header + rows; a placeholder line when empty. */
function table(headers: string[], rows: string[][], emptyNote: string): string {
  if (rows.length === 0) return `_${emptyNote}_\n`;
  const sep = headers.map(() => '---');
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return `${[line(headers), line(sep), ...rows.map(line)].join('\n')}\n`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Point it at the runtime Postgres (see .env).');
    process.exit(2);
  }
  const hours = parseHours(process.argv.slice(2));
  const now = Date.now();

  // Read-only connection. A single connection is plenty for a sequential report.
  const sql = postgres(url, { max: 1 });

  const out: string[] = [];
  const p = (s = '') => out.push(s);

  p(`# Ops report`);
  p();
  p(`- Generated: ${new Date(now).toISOString()}`);
  p(`- Window: last ${hours}h`);
  p(`- Database: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  p();

  try {
    // --- 1. Errors by kind ---------------------------------------------------
    // Failure-ish events (classified by the shared suffix rule) plus failed
    // actions, each rolled up with first/last seen. A quiet, repeating kind
    // (the reply_probe_failed incident) shows here as one high-count row.
    const eventKindRows = await sql<
      { kind: string; count: number; first_seen: Date; last_seen: Date }[]
    >`
      select kind, count(*)::int as count, min(ts) as first_seen, max(ts) as last_seen
      from events
      where ts >= now() - (${hours} * interval '1 hour')
      group by kind
    `;
    const failedActionRows = await sql<
      { type: string; count: number; first_seen: Date; last_seen: Date }[]
    >`
      select type, count(*)::int as count,
             min(coalesce(executed_at, scheduled_at)) as first_seen,
             max(coalesce(executed_at, scheduled_at)) as last_seen
      from actions
      where result = 'failed'
        and coalesce(executed_at, scheduled_at) >= now() - (${hours} * interval '1 hour')
      group by type
    `;
    const errorRows = [
      ...eventKindRows
        .filter((r) => isFailureEventKind(r.kind))
        .map((r) => ({ kind: r.kind, count: r.count, first: r.first_seen, last: r.last_seen })),
      ...failedActionRows.map((r) => ({
        kind: `action_failed:${r.type}`,
        count: r.count,
        first: r.first_seen,
        last: r.last_seen,
      })),
    ].sort((a, b) => b.count - a.count);
    const errorTotal = errorRows.reduce((sum, r) => sum + r.count, 0);

    p(`## Errors by kind (${errorTotal} total)`);
    p();
    p(
      table(
        ['Kind', 'Count', 'First seen', 'Last seen'],
        errorRows.map((r) => [r.kind, String(r.count), iso(r.first), iso(r.last)]),
        `No failures in the last ${hours}h.`,
      ),
    );

    // --- 2. Stuck pipeline ---------------------------------------------------
    // Enrollment cursors in an active state whose due time (or, when null, last
    // update) is more than 30 minutes in the past: they should have advanced and
    // did not. coalesce(next_step_at, updated_at) unifies "overdue" and
    // "null-and-idle" into one reference time. Grouped by campaign.
    const stuckRows = await sql<
      { campaign_id: string; goal: string | null; count: number; oldest_ref: Date }[]
    >`
      select tp.campaign_id,
             c.goal,
             count(*)::int as count,
             min(coalesce(tp.next_step_at, tp.updated_at)) as oldest_ref
      from target_progress tp
      left join campaigns c on c.id = tp.campaign_id
      where tp.state::text = any(${sql.array([...ACTIVE_PROGRESS_STATES])})
        and coalesce(tp.next_step_at, tp.updated_at)
            < now() - (${STUCK_THRESHOLD_MINUTES} * interval '1 minute')
      group by tp.campaign_id, c.goal
      order by count desc
    `;
    const stuckTotal = stuckRows.reduce((sum, r) => sum + r.count, 0);

    p(`## Stuck pipeline (${stuckTotal} cursors >${STUCK_THRESHOLD_MINUTES}m overdue)`);
    p();
    p(
      table(
        ['Campaign', 'Goal', 'Stuck cursors', 'Oldest'],
        stuckRows.map((r) => [
          r.campaign_id,
          r.goal ?? '(unknown)',
          String(r.count),
          humanizeAge(now - new Date(r.oldest_ref).getTime()),
        ]),
        'No stuck cursors: every active cursor is due in the future or recently updated.',
      ),
    );

    // --- 3. Action success/failure rates by type -----------------------------
    // Over the same window. filter() partitions each type's count without a
    // second scan. A high failure share on one type flags a broken adapter.
    const rateRows = await sql<
      { type: string; success: number; failed: number; other: number; total: number }[]
    >`
      select type,
             count(*) filter (where result = 'success')::int as success,
             count(*) filter (where result = 'failed')::int  as failed,
             count(*) filter (where result not in ('success', 'failed'))::int as other,
             count(*)::int as total
      from actions
      where coalesce(executed_at, scheduled_at) >= now() - (${hours} * interval '1 hour')
      group by type
      order by total desc
    `;

    p(`## Action outcomes by type`);
    p();
    p(
      table(
        ['Type', 'Success', 'Failed', 'Other', 'Total', 'Success rate'],
        rateRows.map((r) => [
          r.type,
          String(r.success),
          String(r.failed),
          String(r.other),
          String(r.total),
          r.total > 0 ? `${Math.round((r.success / r.total) * 100)}%` : 'n/a',
        ]),
        `No actions executed in the last ${hours}h.`,
      ),
    );

    // --- 4. Account cap utilization ------------------------------------------
    // budget.used (today's running tally) against limits.caps (the operator-set
    // daily cap). budget.date is shown so a stale tally (used from an earlier
    // day) is obvious. Zero-cap actions are omitted to keep the table legible.
    const accountRows = await sql<
      { id: string; handle: string; state: string; budget: Budget; limits: Caps }[]
    >`select id, handle, state, budget, limits from accounts order by handle`;

    p(`## Account cap utilization`);
    p();
    const capRows: string[][] = [];
    for (const a of accountRows) {
      const caps = a.limits?.caps ?? {};
      const used = a.budget?.used ?? {};
      const parts = ACTION_TYPES.map((t) => {
        const cap = caps[t] ?? 0;
        const u = used[t] ?? 0;
        if (cap === 0 && u === 0) return null;
        const pct = cap > 0 ? ` (${Math.round((u / cap) * 100)}%)` : '';
        return `${t} ${u}/${cap}${pct}`;
      }).filter((x): x is string => x !== null);
      capRows.push([
        a.handle,
        a.state,
        a.budget?.date ?? '(none)',
        parts.length > 0 ? parts.join(', ') : 'all caps 0 / unused',
      ]);
    }
    p(table(['Account', 'State', 'Budget date', 'Used / cap'], capRows, 'No accounts linked.'));

    // --- 5. Pending-approval age ---------------------------------------------
    // Draft outbound messages still carrying a live ActRequest binding
    // (pending_req) are the approval queue. Oldest first: a draft that has sat
    // for days is either forgotten or a symptom of a frozen pipeline.
    const pendingRows = await sql<
      { id: string; created_at: Date; campaign_id: string | null; name: string | null }[]
    >`
      select m.id, m.created_at, t.campaign_id, t.external_context->>'name' as name
      from messages m
      join targets t on t.id = m.target_id
      where m.status = 'draft' and m.direction = 'outbound' and m.pending_req is not null
      order by m.created_at asc
    `;

    p(`## Pending approvals (${pendingRows.length}, oldest first)`);
    p();
    p(
      table(
        ['Message', 'Lead', 'Campaign', 'Age'],
        pendingRows
          .slice(0, 25)
          .map((r) => [
            r.id,
            r.name ?? '(no name)',
            r.campaign_id ?? '(none)',
            humanizeAge(now - new Date(r.created_at).getTime()),
          ]),
        'No pending approvals.',
      ),
    );
    if (pendingRows.length > 25) p(`_…and ${pendingRows.length - 25} more._\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  process.stdout.write(out.join('\n'));
  process.stdout.write('\n');
}

main().catch((err) => {
  console.error('[ops-report] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
