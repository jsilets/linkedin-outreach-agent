// Re-stagger the enrollment backlog: spread a campaign's wall of "due now"
// cursors across the days their account's daily cap can actually serve.
//
// Enrollments made before staggered scheduling landed all carry a null
// nextStepAt, so 90 people show "due now" while the cap (e.g. connect 20/day)
// means the tail really goes out days later. This assigns those cursors the
// same slot/dayOffset/nextStepAt the enrollment path now computes, oldest
// (createdAt) first, appending after any cursors already scheduled into the
// future.
//
// Scope: state='in_progress' cursors that are due-or-overdue (next_step_at null
// or <= now) and sitting at the first enabled step (current_step = 0) of a
// campaign whose first step's action type is capped. Campaigns with no steps,
// a delay-typed first step, or a cap of 0 are skipped.
//
// DRY-RUN by default (prints per-campaign tables of cursor counts per projected
// day). Writes only with an explicit --apply:
//
//   npm run ops:restagger                # dry run
//   npm run ops:restagger -- --apply     # write next_step_at
//
// Connection setup mirrors scripts/ops-report.ts (DATABASE_URL, tsx).

import type { AccountSchedule, ActionType } from '@loa/shared';
import { DEFAULT_CAPS, DEFAULT_SCHEDULE } from '@loa/shared';
import postgres from 'postgres';
import { dueAfterDelay } from '../runtime/src/dispatch/advance.js';

const DAY_SECONDS = 86_400;

interface Limits {
  caps?: Partial<Record<ActionType, number>>;
  schedule?: AccountSchedule;
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
  const apply = process.argv.includes('--apply');
  const now = new Date();

  const sql = postgres(url, { max: 1 });

  const out: string[] = [];
  const p = (s = '') => out.push(s);

  p(`# Re-stagger backlog ${apply ? '(APPLY)' : '(dry run)'}`);
  p();
  p(`- Now: ${now.toISOString()}`);
  p(`- Database: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  p();

  try {
    const campaigns = await sql<{ id: string; goal: string | null }[]>`
      select id, goal from campaigns order by created_at
    `;
    const accounts = await sql<{ id: string; handle: string; limits: Limits | null }[]>`
      select id, handle, limits from accounts
    `;
    const accountById = new Map(accounts.map((a) => [a.id, a] as const));

    let totalMoved = 0;
    for (const campaign of campaigns) {
      const steps = await sql<{ step_type: string }[]>`
        select step_type from campaign_steps
        where campaign_id = ${campaign.id} and enabled = true
        order by step_order asc
      `;
      const firstType = steps[0]?.step_type as ActionType | 'delay' | undefined;
      if (!firstType || firstType === 'delay') continue; // nothing to schedule against

      // Cursors already scheduled into the future keep their slots; the
      // backlog appends after them (same rule as the enrollment path).
      const [future] = await sql<{ count: number }[]>`
        select count(*)::int as count from target_progress
        where campaign_id = ${campaign.id}
          and state = 'in_progress'
          and next_step_at > ${now}
      `;

      const backlog = await sql<{ id: string; account_id: string; created_at: Date }[]>`
        select id, account_id, created_at from target_progress
        where campaign_id = ${campaign.id}
          and state = 'in_progress'
          and current_step = 0
          and (next_step_at is null or next_step_at <= ${now})
        order by created_at asc
      `;
      if (backlog.length === 0) continue;

      // Slots are campaign-wide; cap and schedule come from each cursor's
      // account (in practice one account per campaign).
      let slot = future?.count ?? 0;
      const assignments: Array<{ id: string; nextStepAt: Date | null }> = [];
      const byDay = new Map<string, number>();
      let skippedUncapped = 0;
      for (const cursor of backlog) {
        const limits = accountById.get(cursor.account_id)?.limits ?? undefined;
        const cap = limits?.caps?.[firstType] ?? DEFAULT_CAPS[firstType];
        if (cap <= 0) {
          skippedUncapped += 1;
          continue; // action disabled for this account; leave the cursor alone
        }
        const schedule = limits?.schedule ?? DEFAULT_SCHEDULE;
        const dayOffset = Math.floor(slot / cap);
        const nextStepAt = dueAfterDelay(now, dayOffset * DAY_SECONDS, schedule);
        slot += 1;
        assignments.push({ id: cursor.id, nextStepAt });
        const key = nextStepAt ? nextStepAt.toISOString() : 'due now (today)';
        byDay.set(key, (byDay.get(key) ?? 0) + 1);
      }

      p(`## ${campaign.goal ?? campaign.id} (${campaign.id})`);
      p();
      p(`- First enabled step: ${firstType}`);
      p(`- Already scheduled in the future: ${future?.count ?? 0}`);
      p(
        `- Backlog cursors: ${backlog.length}${skippedUncapped > 0 ? ` (${skippedUncapped} skipped: cap 0)` : ''}`,
      );
      p();
      p(
        table(
          ['Projected due', 'Cursors'],
          [...byDay.entries()].map(([day, count]) => [day, String(count)]),
          'Nothing to re-stagger.',
        ),
      );

      if (apply) {
        await sql.begin(async (tx) => {
          for (const a of assignments) {
            await tx`
              update target_progress
              set next_step_at = ${a.nextStepAt}, updated_at = now()
              where id = ${a.id}
            `;
          }
        });
        totalMoved += assignments.length;
      }
    }

    p(
      apply
        ? `**Applied: ${totalMoved} cursors re-staggered.**`
        : '_Dry run: nothing written. Re-run with --apply to write next_step_at._',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }

  process.stdout.write(out.join('\n'));
  process.stdout.write('\n');
}

main().catch((err) => {
  console.error('[restagger-backlog] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
