import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Account,
  type ActivityItem,
  api,
  type CampaignSummary,
  type ScheduledItem,
  type VolumeRow,
} from './api';
import { StageFunnel, WorkBar, WorkLegend } from './CampaignStats';
import { aggregate, summarizeWork } from './campaignMetrics';
import { type Column, DataTable } from './DataTable';
import { formatRelative, formatStamp } from './format';
import { usePref } from './prefs';
import { actionLabel, actionResultLabel, actionResultVar, statusVar } from './status';

// One theme-aware status token per action type, used as a categorical palette in
// the chart and legend. Amber (--st-approval) is deliberately excluded — it is
// reserved for "needs a human" and means nothing else anywhere in the UI.
const TYPE_VARS: Record<string, string> = {
  connect: '--st-active',
  message: '--st-done',
  view_profile: '--st-replied',
  follow: '--st-waiting',
  react: '--st-idle',
  withdraw_invite: '--st-failed',
};

function typeColor(type: string): string {
  return `var(${TYPE_VARS[type] ?? '--st-idle'})`;
}

const TYPE_LABELS: Record<string, string> = {
  connect: 'Invites',
  message: 'Messages',
  view_profile: 'Profile views',
  follow: 'Follows',
  react: 'Reactions',
  withdraw_invite: 'Withdrawn',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

type ChartMode = 'bars' | 'line';

export function MetricsView({
  onOpenApproval,
}: {
  onOpenApproval?: (targetId: string) => void;
} = {}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = usePref('volume.account', '');
  const [days, setDays] = usePref('volume.days', 30);
  const [mode, setMode] = usePref<ChartMode>('volume.mode', 'bars');
  const [rows, setRows] = useState<VolumeRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadOps = useCallback(() => {
    api
      .campaigns()
      .then(setCampaigns)
      .catch(() => {});
    api
      .activity({ limit: 60 })
      .then(setActivity)
      .catch(() => {});
    // Full window (server cap), not 60: overdue invites sort first and would
    // otherwise crowd every future-dated message out of a short fetch.
    api
      .scheduled(200)
      .then(setScheduled)
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .accounts()
      .then(setAccounts)
      .catch((e) => setError(String(e)));
    loadOps();
  }, [loadOps]);

  // Reply detection runs independently of this view. Refresh the operational
  // projections so a newly detected reply arrives in Activity and campaign
  // metrics without requiring the operator to change tabs or reload.
  useEffect(() => {
    const id = setInterval(loadOps, 60_000);
    return () => clearInterval(id);
  }, [loadOps]);

  // A stored account filter may point at an account that's since been unlinked —
  // fall back to "All accounts" once the live list is in, so it isn't a ghost.
  useEffect(() => {
    if (accountId && accounts.length > 0 && !accounts.some((a) => a.id === accountId)) {
      setAccountId('');
    }
  }, [accounts, accountId, setAccountId]);

  useEffect(() => {
    api
      .volume(accountId, days)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [accountId, days]);

  const agg = aggregate(campaigns);
  const aggWork = summarizeWork(agg.byProgressState, agg.targetCount);

  return (
    <div className="dash">
      <div className="card">
        <div className="toolbar" style={{ margin: '0 0 var(--space-2)' }}>
          <h3 style={{ margin: 0 }}>Outreach volume</h3>
          <span className="spacer" />
          <div className="seg-toggle" role="group" aria-label="Chart style">
            <button
              type="button"
              className={mode === 'bars' ? 'on' : ''}
              aria-pressed={mode === 'bars'}
              onClick={() => setMode('bars')}
            >
              Bars
            </button>
            <button
              type="button"
              className={mode === 'line' ? 'on' : ''}
              aria-pressed={mode === 'line'}
              onClick={() => setMode('line')}
            >
              Line
            </button>
          </div>
          <select
            style={{ width: 'auto' }}
            aria-label="Filter volume by account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.handle}
              </option>
            ))}
          </select>
          <select
            style={{ width: 'auto' }}
            aria-label="Volume time range"
            value={days}
            onChange={(e) => setDays(+e.target.value)}
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        {error && <div className="error">{error}</div>}
        <VolumeChart rows={rows} days={days} mode={mode} />
      </div>

      <div className="card">
        <div className="section-head">
          <h3>Across all campaigns</h3>
          {aggWork.needsApproval > 0 && (
            <span className="chip" style={{ ['--c' as string]: statusVar('awaiting_approval') }}>
              {aggWork.needsApproval} awaiting your approval
            </span>
          )}
        </div>
        {campaigns.length === 0 ? (
          <span className="muted">No campaigns yet.</span>
        ) : (
          <>
            <StageFunnel performance={agg.performance} eligible={aggWork.eligible} />
            <WorkBar byProgressState={agg.byProgressState} targetCount={agg.targetCount} />
            <WorkLegend byProgressState={agg.byProgressState} targetCount={agg.targetCount} />
          </>
        )}
      </div>

      <div className="dash-feeds">
        <div className="card">
          <div className="section-head">
            <h3>Recent activity</h3>
            <span className="count-tag">{activity.length}</span>
          </div>
          <ActivityFeed items={activity} />
        </div>

        <div className="card">
          <div className="section-head">
            <h3>Scheduled</h3>
            <span className="count-tag">{scheduled.length}</span>
          </div>
          <ScheduledFeed items={scheduled} onOpenApproval={onOpenApproval} />
        </div>
      </div>
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return <div className="empty">No actions yet.</div>;

  const when = (a: ActivityItem) => a.executedAt ?? a.scheduledAt;
  const columns: Column<ActivityItem>[] = [
    {
      key: 'when',
      header: 'When',
      sortValue: (a) => {
        const t = new Date(when(a)).getTime();
        return Number.isNaN(t) ? null : t;
      },
      cellClassName: 'when',
      cell: (a) => <span title={formatStamp(when(a))}>{formatRelative(when(a))}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      sortValue: (a) => actionLabel(a.type),
      cell: (a) => actionLabel(a.type),
    },
    {
      key: 'result',
      header: 'Result',
      // Inbound milestones are not sends: show their business state rather than
      // borrowing an outbound action result label.
      sortValue: (a) =>
        a.type === 'invite_accepted'
          ? 'Accepted'
          : a.type === 'reply_received'
            ? 'Replied'
            : actionResultLabel(a.result),
      cell: (a) => {
        const isAccept = a.type === 'invite_accepted';
        const isReply = a.type === 'reply_received';
        const color = isAccept
          ? statusVar('connected')
          : isReply
            ? statusVar('replied')
            : actionResultVar(a.result);
        const label = isAccept ? 'Accepted' : isReply ? 'Replied' : actionResultLabel(a.result);
        // A failed or skipped row carries the executor's reason (e.g. "needs
        // recipient email to connect", "already pending; no invite sent"); surface
        // it in a real hover popover so "why" is legible on hover instead of buried
        // in the events table (a bare title attribute only gave a help cursor with
        // no visible text). The dotted underline signals there's more to read; the
        // popover renders on hover/focus.
        const reason = a.resultDetail;
        if (isAccept || isReply || !reason) {
          return (
            <span className="chip" style={{ ['--c' as string]: color }}>
              {label}
            </span>
          );
        }
        return (
          <span className="chip-reason" tabIndex={0}>
            <span className="chip has-reason" style={{ ['--c' as string]: color }}>
              {label}
            </span>
            <span className="chip-reason-pop" role="tooltip">
              {reason}
            </span>
          </span>
        );
      },
    },
    {
      key: 'lead',
      header: 'Lead',
      sortValue: (a) => (a.name ?? '').toLowerCase(),
      cell: (a) =>
        a.profileUrl ? (
          <a href={a.profileUrl} target="_blank" rel="noopener noreferrer">
            {a.name ?? 'Unknown'}
          </a>
        ) : (
          (a.name ?? '—')
        ),
    },
  ];

  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(a) => a.actionId}
      initialSort={{ key: 'when', dir: 'desc' }}
      persistKey="activity"
    />
  );
}

// What the dispatch loop will run next, per enrolled lead, soonest first. A null
// nextStepAt (or one already in the past) means "ripe, waiting on the next tick",
// so it sorts to the very top and reads "next tick" rather than a false countdown.
function ScheduledFeed({
  items,
  onOpenApproval,
}: {
  items: ScheduledItem[];
  onOpenApproval?: (targetId: string) => void;
}) {
  if (items.length === 0) return <div className="empty">Nothing queued.</div>;

  const columns: Column<ScheduledItem>[] = [
    {
      key: 'when',
      header: 'When',
      // Sort by the forecast time so the column reads as a timeline. A null
      // projectedAt means "today's budget" (imminent) — anchor it at NOW, so an
      // overdue drafted message scheduled earlier today (a real, past time) sorts
      // ABOVE the today-budget invites where it belongs, and future work sorts
      // below. (Using 0 for null pinned invites to the very top and buried the
      // overdue pending-approval messages beneath them.)
      sortValue: (s) => {
        const iso = s.state === 'awaiting_approval' ? s.nextStepAt : s.projectedAt;
        if (!iso) return Date.now();
        const t = new Date(iso).getTime();
        return Number.isNaN(t) ? Date.now() : t;
      },
      cellClassName: 'when',
      // Forecast, and it must reflect reality: what you already APPROVED reads
      // "sending soon" (or its future due time), what still needs you reads
      // "pending approval", and neither shows a stale past clock time as if it
      // were a live send slot. In-progress work reads its projected day.
      cell: (s) => {
        if (s.state === 'awaiting_approval') {
          const at = s.nextStepAt;
          const dueInFuture = !!at && new Date(at).getTime() > Date.now();
          // Already approved by the operator — only waiting for its send tick.
          if (s.approvedQueued) {
            return dueInFuture ? (
              <span title={`approved · sends ${formatStamp(at)}`}>
                {formatRelative(at)} <span className="muted">(approved)</span>
              </span>
            ) : (
              <span className="muted" title="approved — sends on the next dispatch tick">
                sending soon
              </span>
            );
          }
          // A draft still waiting on the operator. Show a future due time when it
          // is not due yet; for an already-passed due time show only the status,
          // never a stale "8:00 AM" that implies it went out. "pending approval"
          // is a link that opens this lead's draft in the Inbox to approve it.
          const pendingLabel = onOpenApproval ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => onOpenApproval(s.targetId)}
              title="Open this draft in the Inbox to approve it"
            >
              pending approval
            </button>
          ) : (
            <span className="muted" title="ready to send — waiting on your approval">
              pending approval
            </span>
          );
          return dueInFuture ? (
            <span title={`scheduled ${formatStamp(at)} · then waits for your approval`}>
              {formatRelative(at)} {pendingLabel}
            </span>
          ) : (
            pendingLabel
          );
        }
        // projectedAt null = within today's remaining daily budget.
        if (!s.projectedAt) {
          return (
            <span className="muted" title="within today's daily budget — fires as capacity frees">
              today
            </span>
          );
        }
        return (
          <span title={`${formatStamp(s.projectedAt)} · paced by the daily cap`}>
            {formatRelative(s.projectedAt)}
          </span>
        );
      },
    },
    {
      key: 'action',
      header: 'Action',
      sortValue: (s) => (s.nextStepType ? actionLabel(s.nextStepType) : '—'),
      cell: (s) => (s.nextStepType ? actionLabel(s.nextStepType) : '—'),
    },
    {
      key: 'lead',
      header: 'Lead',
      sortValue: (s) => (s.name ?? '').toLowerCase(),
      cell: (s) =>
        s.profileUrl ? (
          <a href={s.profileUrl} target="_blank" rel="noopener noreferrer">
            {s.name ?? 'Unknown'}
          </a>
        ) : (
          (s.name ?? '—')
        ),
    },
  ];

  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(s) => s.targetId}
      initialSort={{ key: 'when', dir: 'asc' }}
      persistKey="scheduled"
    />
  );
}

interface HoverState {
  day: string;
  items: Array<{ type: string; count: number }>;
  x: number;
  y: number;
}

// Grouped bars per day, one status color per action type. Hovering a day
// highlights that day's band and floats a tooltip with each action-type count.
// The native <title> on each bar is the accessible / no-JS fallback. In line
// mode, one polyline per action type replaces the bars; the day-band hover,
// tooltip, and axes are shared.
function VolumeChart({ rows, days, mode }: { rows: VolumeRow[]; days: number; mode: ChartMode }) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [containerW, setContainerW] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  // Fill the card width; keep a per-day floor so bars stay legible and the chart
  // scrolls (rather than crushes) when narrow. This is a callback ref, not a
  // mount effect: the chart node only appears AFTER the volume data loads, so a
  // useEffect([]) would run while the node is still absent and never re-measure.
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    roRef.current = ro;
  }, []);

  const byDay = new Map<string, Record<string, number>>();
  const typesSeen = new Set<string>();
  for (const r of rows) {
    const bucket = byDay.get(r.day) ?? {};
    bucket[r.type] = r.count;
    byDay.set(r.day, bucket);
    typesSeen.add(r.type);
  }

  const dayLabels = buildDayAxis(days);
  const types = [...typesSeen].sort();
  const max = Math.max(1, ...rows.map((r) => r.count));

  const width = Math.max(containerW || 640, dayLabels.length * 22);
  const height = 220;
  const padL = 34;
  const padB = 42;
  const plotTop = 10;
  const plotH = height - padB - plotTop;
  const bandW = (width - padL) / dayLabels.length;
  const barW = Math.max(2, (bandW - 4) / Math.max(1, types.length));

  if (rows.length === 0) {
    return <p className="muted">No successful actions in this window.</p>;
  }

  function showTip(day: string, e: React.MouseEvent) {
    const bucket = byDay.get(day) ?? {};
    const items = types.map((t) => ({ type: t, count: bucket[t] ?? 0 })).filter((i) => i.count > 0);
    // Keep the tooltip on-screen: flip left near the right edge.
    const nearRight = e.clientX > window.innerWidth - 190;
    setHover({ day, items, x: e.clientX + (nearRight ? -164 : 14), y: e.clientY + 14 });
  }

  return (
    <div className="chart-figure">
      <div className="legend">
        {types.map((t) => (
          <span className="item" key={t}>
            <span className="swatch" style={{ background: typeColor(t) }} />
            {typeLabel(t)}
          </span>
        ))}
      </div>
      <div className="chart-scroll" ref={measureRef}>
        <svg width={width} height={height} role="img" aria-label="Outreach volume per day">
          {[0, 0.5, 1].map((f) => {
            const y = plotTop + plotH * (1 - f);
            return (
              <g key={f}>
                <line className="chart-grid-line" x1={padL} y1={y} x2={width} y2={y} />
                <text className="chart-axis-text" x={4} y={y + 4} fontSize={10}>
                  {Math.round(max * f)}
                </text>
              </g>
            );
          })}
          {dayLabels.map((day, di) => {
            const bucket = byDay.get(day) ?? {};
            const bandX = padL + di * bandW;
            const isActive = hover?.day === day;
            const dimmed = hover !== null && !isActive;
            return (
              <g key={day}>
                {isActive && (
                  <rect
                    className="chart-band-hover"
                    x={bandX}
                    y={plotTop}
                    width={bandW}
                    height={plotH}
                  />
                )}
                {mode === 'bars' &&
                  types.map((t, ti) => {
                    const v = bucket[t] ?? 0;
                    const h = (v / max) * plotH;
                    const x = bandX + 2 + ti * barW;
                    const y = plotTop + plotH - h;
                    return (
                      <rect
                        key={t}
                        className="vbar"
                        x={x}
                        y={y}
                        width={Math.max(1, barW - 1)}
                        height={h}
                        style={{ fill: typeColor(t), opacity: dimmed ? 0.28 : 1 }}
                      >
                        <title>{`${day} ${typeLabel(t)}: ${v}`}</title>
                      </rect>
                    );
                  })}
                {/* Full-height, transparent hit area so the whole day column is hoverable. */}
                <rect
                  x={bandX}
                  y={plotTop}
                  width={bandW}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={(e) => showTip(day, e)}
                  onMouseMove={(e) => showTip(day, e)}
                  onMouseLeave={() => setHover(null)}
                />
                {di % Math.ceil(dayLabels.length / 12) === 0 && (
                  <text
                    className="chart-axis-text"
                    x={bandX + bandW / 2}
                    y={height - 22}
                    fontSize={9}
                    textAnchor="middle"
                    transform={`rotate(35 ${bandX + bandW / 2} ${height - 22})`}
                  >
                    {day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
          {/* Lines paint above the bands but below nothing interactive: pointer-events
              are off so the per-day hit rects underneath still drive hover. */}
          {mode === 'line' &&
            types.map((t) => {
              const pts = dayLabels.map((day, di) => {
                const v = byDay.get(day)?.[t] ?? 0;
                const x = padL + di * bandW + bandW / 2;
                const y = plotTop + plotH - (v / max) * plotH;
                return { x, y, v };
              });
              const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
              return (
                <g key={t} style={{ pointerEvents: 'none' }}>
                  <polyline
                    points={line}
                    fill="none"
                    stroke={typeColor(t)}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {pts.map((p) =>
                    p.v > 0 ? (
                      <circle key={p.x} cx={p.x} cy={p.y} r={2.5} fill={typeColor(t)} />
                    ) : null,
                  )}
                </g>
              );
            })}
        </svg>
      </div>

      {hover && hover.items.length > 0 && (
        <div className="chart-tooltip" style={{ left: hover.x, top: hover.y }} role="presentation">
          <div className="tt-date">{hover.day}</div>
          {hover.items.map((i) => (
            <div className="tt-row" key={i.type}>
              <span className="swatch" style={{ background: typeColor(i.type) }} />
              {typeLabel(i.type)}
              <span className="tt-n">{i.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Local "YYYY-MM-DD" for a date, matching the server's local-timezone day
// buckets. Not toISOString(), which would render the UTC day and drift a bar
// into "tomorrow" after 5pm Pacific.
function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildDayAxis(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(localDay(d));
  }
  return out;
}
