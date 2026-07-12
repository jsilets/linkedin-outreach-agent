import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalsPanel } from './ApprovalsPanel';
import {
  type Account,
  type ActivityItem,
  api,
  type CampaignSummary,
  type Pending,
  type VolumeRow,
} from './api';
import { type Column, DataTable } from './DataTable';
import { FunnelBar, MiniFunnel } from './FunnelBar';
import { formatRelative, formatStamp } from './format';
import { actionLabel, statusLabel, statusVar } from './status';

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

export function MetricsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<VolumeRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadOps = useCallback(() => {
    api
      .campaigns()
      .then(setCampaigns)
      .catch(() => {});
    api
      .pending()
      .then(setPending)
      .catch(() => {});
    api
      .activity({ limit: 60 })
      .then(setActivity)
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .accounts()
      .then(setAccounts)
      .catch((e) => setError(String(e)));
    loadOps();
  }, [loadOps]);

  useEffect(() => {
    api
      .volume(accountId, days)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [accountId, days]);

  const agg: Record<string, number> = {};
  for (const c of campaigns) {
    for (const [k, n] of Object.entries(c.byProgressState ?? {})) agg[k] = (agg[k] ?? 0) + n;
  }

  return (
    <div className="grid" style={{ gap: 'var(--space-5)' }}>
      {/* Surface what needs a human first — but only when something actually does. */}
      {pending.length > 0 && (
        <div className="card">
          <div className="section-head">
            <span
              className="status-badge"
              style={{ ['--c' as string]: statusVar('awaiting_approval') }}
            >
              Needs your approval
            </span>
            <span className="count-tag">{pending.length}</span>
          </div>
          <ApprovalsPanel pending={pending} onChange={loadOps} showCampaign />
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ margin: '0 0 var(--space-2)' }}>
          <h3 style={{ margin: 0 }}>Outreach volume</h3>
          <span className="spacer" />
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
        <VolumeChart rows={rows} days={days} />
      </div>

      <div className="card">
        <div className="section-head">
          <h3>Pipeline across all campaigns</h3>
        </div>
        <FunnelBar counts={agg} />
        <div className="grid" style={{ marginTop: 'var(--space-4)', gap: 'var(--space-2)' }}>
          {campaigns.map((c) => (
            <div
              key={c.id}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
            >
              <div style={{ width: 220, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.goal}
                </div>
                <div className="muted" style={{ fontSize: 'var(--text-meta)' }}>
                  {statusLabel(c.status)} · {c.targetCount} targets
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <MiniFunnel counts={c.byProgressState} />
              </div>
              {c.pendingCount > 0 && (
                <span
                  className="chip"
                  style={{ ['--c' as string]: statusVar('awaiting_approval') }}
                >
                  {c.pendingCount}
                </span>
              )}
            </div>
          ))}
          {campaigns.length === 0 && <span className="muted">No campaigns yet.</span>}
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <h3>Recent activity</h3>
          <span className="count-tag">{activity.length}</span>
        </div>
        <ActivityFeed items={activity} />
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
      // An invite_accepted row is inbound, not a send: show "Accepted", not the
      // action result vocabulary ("Sent").
      sortValue: (a) => (a.type === 'invite_accepted' ? 'Accepted' : statusLabel(a.result)),
      cell: (a) => {
        const isAccept = a.type === 'invite_accepted';
        const key = isAccept ? 'connected' : a.result;
        const label = isAccept ? 'Accepted' : statusLabel(a.result);
        return (
          <span className="chip" style={{ ['--c' as string]: statusVar(key) }}>
            {label}
          </span>
        );
      },
    },
    {
      key: 'lead',
      header: 'Lead',
      sortValue: (a) => (a.name ?? '').toLowerCase(),
      cell: (a) => a.name ?? '—',
    },
  ];

  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(a) => a.actionId}
      initialSort={{ key: 'when', dir: 'desc' }}
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
// The native <title> on each bar is the accessible / no-JS fallback.
function VolumeChart({ rows, days }: { rows: VolumeRow[]; days: number }) {
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
                {types.map((t, ti) => {
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

function buildDayAxis(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
