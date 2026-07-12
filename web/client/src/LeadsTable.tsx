import { useState } from 'react';
import type { Lead } from './api';
import { type Column, DataTable } from './DataTable';
import { formatRelative, formatStamp } from './format';
import { actionLabel, deriveLeadStatus, statusLabel, statusVar } from './status';

function Chip({ statusKey }: { statusKey: string }) {
  return (
    <span className="chip" style={{ ['--c' as string]: statusVar(statusKey) }}>
      {statusLabel(statusKey)}
    </span>
  );
}

// The key the funnel filters on: the RAW progress cursor (or stage when not
// enrolled), matching the segment keys the funnel bar is built from. Kept
// separate from the displayed milestone so clicking a coarse funnel segment
// still selects every lead in it.
function leadFilterKey(l: Lead): string {
  return l.progressState ?? l.stage;
}

function ts(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// A short verb for the step about to run, so the column says WHAT is next, not
// just when. "message" -> "Message", "connect" -> "Invite" (via actionLabel);
// delay steps have no verb of their own, so they read as a plain wait.
function stepVerb(type: string | null): string {
  if (!type || type === 'delay') return 'Next step';
  return actionLabel(type);
}

// When the next step will run, prefixed with what it is: "Message in 22h".
// A FUTURE time is the scheduled delay (e.g. the 24h wait after acceptance). A
// PAST time means the step is ripe and waiting on a send slot — the daily cap,
// the pacer, or the working-hours/days window — so "Message queued" is the
// honest label, not "due 5h ago", which read like something was overdue.
function nextStepLabel(type: string | null, iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const verb = stepVerb(type);
  const when = t > Date.now() ? formatRelative(iso) : 'queued';
  return `${verb} ${when}`;
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
export function LeadsTable({
  leads,
  filter,
  onRemove,
}: {
  leads: Lead[];
  filter: string | null;
  /** Eject a target from the campaign. When omitted, no Remove column shows. */
  onRemove?: (targetId: string) => void | Promise<void>;
}) {
  const rows = filter ? leads.filter((l) => leadFilterKey(l) === filter) : leads;
  const [removing, setRemoving] = useState<string | null>(null);

  if (leads.length === 0) return <div className="empty">No leads enrolled yet.</div>;
  if (rows.length === 0) return <div className="empty">No leads in this stage.</div>;

  async function remove(l: Lead) {
    if (!onRemove) return;
    if (
      !window.confirm(
        `Remove ${l.name ?? 'this lead'} from the campaign? Their sequence stops and any unsent message is cancelled.`,
      )
    ) {
      return;
    }
    setRemoving(l.targetId);
    try {
      await onRemove(l.targetId);
    } finally {
      setRemoving(null);
    }
  }

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
            {l.offIcp && (
              <span className="icp-badge" style={{ marginLeft: 6 }}>
                off-ICP
              </span>
            )}
          </div>
          {l.company && <div className="co">{l.company}</div>}
        </>
      ),
    },
    {
      key: 'fit',
      header: 'Fit',
      numeric: true,
      sortValue: (l) => l.score,
      cell: (l) => (l.score === null ? <span className="muted">—</span> : l.score),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (l) => statusLabel(deriveLeadStatus(l)),
      cell: (l) => <Chip statusKey={deriveLeadStatus(l)} />,
    },
    {
      key: 'next',
      header: 'Next step',
      sortValue: (l) => (isFlowing(l) ? ts(l.nextStepAt) : null),
      cellClassName: 'when',
      cell: (l) => (
        <span title={formatStamp(l.nextStepAt)}>
          {isFlowing(l) ? nextStepLabel(l.nextStepType, l.nextStepAt) : '—'}
        </span>
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
    ...(onRemove
      ? [
          {
            key: 'actions',
            header: '',
            sortable: false,
            cell: (l: Lead) => (
              <button
                type="button"
                className="btn tiny danger"
                disabled={removing === l.targetId}
                onClick={() => remove(l)}
              >
                {removing === l.targetId ? 'Removing…' : 'Remove'}
              </button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="lead-table">
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(l) => l.targetId}
        rowClassName={(l) =>
          l.progressState === 'awaiting_approval' ? 'needs-you' : l.offIcp ? 'row-warn' : undefined
        }
      />
    </div>
  );
}
