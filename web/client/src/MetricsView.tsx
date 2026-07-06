import { useEffect, useState } from 'react';
import { api, type Account, type VolumeRow } from './api';

// Colors per action type. Invites (connect) and messages are the headline two.
const TYPE_COLORS: Record<string, string> = {
  connect: '#4f8cff',
  message: '#46c093',
  view_profile: '#c084fc',
  follow: '#f0a94f',
  react: '#ff6b6b',
  withdraw_invite: '#6b7280',
};

const TYPE_LABELS: Record<string, string> = {
  connect: 'Invites',
  message: 'Messages',
  view_profile: 'Profile views',
  follow: 'Follows',
  react: 'Reactions',
  withdraw_invite: 'Withdrawn',
};

export function MetricsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<VolumeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.accounts().then(setAccounts).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    api
      .volume(accountId, days)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [accountId, days]);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <div className="toolbar" style={{ margin: 0 }}>
          <strong>Outreach volume</strong>
          <span className="spacer" />
          <select
            style={{ width: 'auto' }}
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
          <select style={{ width: 'auto' }} value={days} onChange={(e) => setDays(+e.target.value)}>
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
        <strong>Accounts</strong>
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Handle</th>
              <th>State</th>
              <th>Warmup day</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.handle}</td>
                <td>{a.state}</td>
                <td>{a.warmupDay}</td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Grouped bars per day, one color per action type. Hand-rolled SVG, no deps.
function VolumeChart({ rows, days }: { rows: VolumeRow[]; days: number }) {
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

  const width = Math.max(640, dayLabels.length * 26);
  const height = 220;
  const padL = 34;
  const padB = 42;
  const plotH = height - padB - 10;
  const bandW = (width - padL) / dayLabels.length;
  const barW = Math.max(2, (bandW - 4) / Math.max(1, types.length));

  if (rows.length === 0) {
    return <p className="muted">No successful actions in this window.</p>;
  }

  return (
    <div>
      <div className="legend">
        {types.map((t) => (
          <span key={t}>
            <span className="swatch" style={{ background: TYPE_COLORS[t] ?? '#888' }} />
            {TYPE_LABELS[t] ?? t}
          </span>
        ))}
      </div>
      <div className="chart">
        <svg width={width} height={height} role="img" aria-label="Outreach volume per day">
          {[0, 0.5, 1].map((f) => {
            const y = 10 + plotH * (1 - f);
            return (
              <g key={f}>
                <line x1={padL} y1={y} x2={width} y2={y} stroke="#2a2f3a" />
                <text x={4} y={y + 4} fill="#9aa3b2" fontSize={10}>
                  {Math.round(max * f)}
                </text>
              </g>
            );
          })}
          {dayLabels.map((day, di) => {
            const bucket = byDay.get(day) ?? {};
            const bandX = padL + di * bandW;
            return (
              <g key={day}>
                {types.map((t, ti) => {
                  const v = bucket[t] ?? 0;
                  const h = (v / max) * plotH;
                  const x = bandX + 2 + ti * barW;
                  const y = 10 + plotH - h;
                  return (
                    <rect
                      key={t}
                      x={x}
                      y={y}
                      width={Math.max(1, barW - 1)}
                      height={h}
                      fill={TYPE_COLORS[t] ?? '#888'}
                    >
                      <title>{`${day} ${TYPE_LABELS[t] ?? t}: ${v}`}</title>
                    </rect>
                  );
                })}
                {di % Math.ceil(dayLabels.length / 12) === 0 && (
                  <text
                    x={bandX + bandW / 2}
                    y={height - 22}
                    fill="#9aa3b2"
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
