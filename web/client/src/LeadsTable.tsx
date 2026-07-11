import type { Lead } from './api';
import { DataTable, type Column } from './DataTable';
import { formatRelative, formatStamp } from './format';
import { actionLabel, statusLabel, statusVar } from './status';

function Chip({ statusKey }: { statusKey: string }) {
  return (
    <span className="chip" style={{ ['--c' as string]: statusVar(statusKey) }}>
      {statusLabel(statusKey)}
    </span>
  );
}

// The state that drives a lead's chip: the live progress cursor if enrolled,
// otherwise its sourcing stage.
function leadState(l: Lead): string {
  return l.progressState ?? l.stage;
}

function ts(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// When the next step is due. A past time means the lead is ready and waiting on
// a send slot (daily cap / pacer), so it reads as "due 2h ago", not "2h ago".
function nextStepLabel(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const rel = formatRelative(iso);
  return t < Date.now() ? `due ${rel}` : rel;
}

// Whether the lead is still stepping (so a "next step" time is meaningful).
function isFlowing(l: Lead): boolean {
  return l.progressState === 'in_progress' || l.progressState === 'pending';
}

/**
 * One row per person: who, where they are, what's next and when, and what last
 * happened. Filtered to a single funnel segment when `filter` is set. Sort and
 * pagination are handled by DataTable and survive parent refetches.
 */
export function LeadsTable({ leads, filter }: { leads: Lead[]; filter: string | null }) {
  const rows = filter ? leads.filter((l) => leadState(l) === filter) : leads;

  if (leads.length === 0) return <div className="empty">No leads enrolled yet.</div>;
  if (rows.length === 0) return <div className="empty">No leads in this stage.</div>;

  const columns: Column<Lead>[] = [
    {
      key: 'lead',
      header: 'Lead',
      sortValue: (l) => (l.name ?? 'Unknown').toLowerCase(),
      cell: (l) => (
        <>
          <div className="who">
            {l.profileUrl ? (
              <a href={l.profileUrl} target="_blank" rel="noreferrer">
                {l.name ?? 'Unknown'}
              </a>
            ) : (
              (l.name ?? 'Unknown')
            )}
          </div>
          {l.company && <div className="co">{l.company}</div>}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (l) => statusLabel(leadState(l)),
      cell: (l) => <Chip statusKey={leadState(l)} />,
    },
    {
      key: 'next',
      header: 'Next step',
      sortValue: (l) => (isFlowing(l) ? ts(l.nextStepAt) : null),
      cellClassName: 'when',
      cell: (l) => (
        <span title={formatStamp(l.nextStepAt)}>{isFlowing(l) ? nextStepLabel(l.nextStepAt) : '—'}</span>
      ),
    },
    {
      key: 'last',
      header: 'Last action',
      sortValue: (l) => ts(l.lastAction?.executedAt),
      cellClassName: 'when',
      cell: (l) => (
        <span title={formatStamp(l.lastAction?.executedAt)}>
          {l.lastAction
            ? `${actionLabel(l.lastAction.type)} · ${formatRelative(l.lastAction.executedAt)}`
            : '—'}
        </span>
      ),
    },
    {
      key: 'notes',
      header: 'Notes',
      sortable: false,
      cellClassName: 'err',
      cell: (l) => l.errorMessage ?? '',
    },
  ];

  return (
    <div className="lead-table">
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(l) => l.targetId}
        rowClassName={(l) => (leadState(l) === 'awaiting_approval' ? 'needs-you' : undefined)}
      />
    </div>
  );
}
