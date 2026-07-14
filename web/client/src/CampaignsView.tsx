import { useEffect, useState } from 'react';
import { type Account, api, type CampaignDetail, type CampaignSummary, type Lead } from './api';
import { FlowEditor } from './FlowEditor';
import { FunnelBar, MiniFunnel } from './FunnelBar';
import { LeadsTable } from './LeadsTable';
import { statusLabel, statusVar } from './status';

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="status-badge" style={{ ['--c' as string]: statusVar(status) }}>
      {statusLabel(status)}
    </span>
  );
}

// A campaign's headline performance as two quiet stat chips: invite acceptance
// and message reply rates. Rates guard divide-by-zero with an em dash, so a
// campaign that hasn't sent yet reads honestly rather than "0%" or "NaN". Coded
// defensively against `performance` since the server field may not be present.
function PerfStats({ performance }: { performance?: CampaignSummary['performance'] }) {
  const invitesSent = performance?.invitesSent ?? 0;
  const invitesAccepted = performance?.invitesAccepted ?? 0;
  const messagesSent = performance?.messagesSent ?? 0;
  const replies = performance?.replies ?? 0;
  const accepted = invitesSent > 0 ? `${Math.round((invitesAccepted / invitesSent) * 100)}%` : '—';
  const replied = messagesSent > 0 ? `${Math.round((replies / messagesSent) * 100)}%` : '—';
  return (
    <div className="stat-row">
      <span className="stat">
        <span className="stat-n">{invitesSent}</span>
        <span className="stat-label">invites · {accepted} accepted</span>
      </span>
      <span className="stat">
        <span className="stat-n">{messagesSent}</span>
        <span className="stat-label">messages · {replied} replied</span>
      </span>
    </div>
  );
}

export function CampaignsView() {
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .campaigns()
      .then(setList)
      .catch((e) => setError(String(e)));
  }, []);

  if (selected) {
    return <CampaignDetailView id={selected} onBack={() => setSelected(null)} />;
  }

  if (error) return <div className="error">{error}</div>;
  if (!list) return <p className="muted">Loading...</p>;
  if (list.length === 0) {
    return (
      <p className="muted">No campaigns yet. Create one via the engine, then it shows here.</p>
    );
  }

  return (
    <div className="grid">
      {list.map((c) => (
        <div className="card campaign-row" key={c.id} onClick={() => setSelected(c.id)}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>{c.goal}</h3>
              <StatusBadge status={c.status} />
              {c.pendingCount > 0 && (
                <span
                  className="chip"
                  style={{ ['--c' as string]: statusVar('awaiting_approval') }}
                >
                  {c.pendingCount} to approve
                </span>
              )}
            </div>
            <div className="muted" style={{ marginBottom: 8 }}>
              {c.owner} · {c.autonomyLevel} · {c.targetCount} targets
            </div>
            <MiniFunnel counts={c.byProgressState} />
            <PerfStats performance={c.performance} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CampaignDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);

  function load() {
    api
      .campaign(id)
      .then(setDetail)
      .catch((e) => setError(String(e)));
    api
      .leads(id)
      .then(setLeads)
      .catch(() => {});
  }
  useEffect(() => {
    load();
    api
      .accounts()
      .then((a) => {
        setAccounts(a);
        if (a[0]) setAccountId((prev) => prev || a[0]!.id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function launch() {
    setLaunching(true);
    setLaunchMsg(null);
    try {
      const res = await api.launchCampaign(id, accountId);
      setLaunchMsg(
        `Enrolled ${res.enrolled} ${res.enrolled === 1 ? 'lead' : 'leads'}` +
          (res.alreadyEnrolled ? ` (${res.alreadyEnrolled} already flowing)` : '') +
          '. The dispatch loop will start stepping them.',
      );
      load();
    } catch (e) {
      setLaunchMsg(e instanceof Error ? e.message : 'Enroll failed.');
    } finally {
      setLaunching(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading...</p>;

  const unenrolled = Math.max(0, detail.targetCount - detail.enrolledCount);

  return (
    <div>
      <span className="back" onClick={onBack}>
        &larr; All campaigns
      </span>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{detail.goal}</h2>
          <StatusBadge status={detail.status} />
        </div>
        <div className="muted" style={{ marginBottom: 12 }}>
          {detail.owner} · {detail.autonomyLevel} · strategy: {detail.messageStrategy}
        </div>
        <PerfStats performance={detail.performance} />
        <FunnelBar counts={detail.byProgressState} selected={filter} onSelect={setFilter} />
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {filter
            ? `Showing ${statusLabel(filter)} — click the segment again to clear.`
            : 'Click a segment to see exactly who is there.'}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <h3>Leads</h3>
          <span className="count-tag">{detail.enrolledCount} enrolled</span>
        </div>
        <LeadsTable
          leads={leads}
          filter={filter}
          onRemove={async (targetId) => {
            try {
              await api.removeCampaignTargets(id, [targetId]);
              load();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Flow</h3>
        <FlowEditor campaignId={id} initial={detail.steps} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        {detail.status === 'draft' ? (
          <>
            <h3 style={{ marginTop: 0 }}>Launch</h3>
            <div className="muted" style={{ marginBottom: 12 }}>
              Enroll this campaign&apos;s targets under a linked account. Save the flow above first;
              the dispatch loop then steps each lead through it.
            </div>
            <LaunchControls
              accounts={accounts}
              accountId={accountId}
              setAccountId={setAccountId}
              launching={launching}
              onLaunch={launch}
              label="Launch campaign"
            />
          </>
        ) : (
          <>
            <h3 style={{ marginTop: 0 }}>Enrollment</h3>
            <div className="muted" style={{ marginBottom: 12 }}>
              {detail.enrolledCount} {detail.enrolledCount === 1 ? 'lead is' : 'leads are'} enrolled
              and stepping through the flow automatically.
              {unenrolled > 0
                ? ` ${unenrolled} target${unenrolled === 1 ? '' : 's'} not yet enrolled.`
                : ' Every target is enrolled.'}
            </div>
            {unenrolled > 0 && (
              <LaunchControls
                accounts={accounts}
                accountId={accountId}
                setAccountId={setAccountId}
                launching={launching}
                onLaunch={launch}
                label={`Enroll ${unenrolled} new target${unenrolled === 1 ? '' : 's'}`}
              />
            )}
          </>
        )}
        {launchMsg && (
          <div
            className={launchMsg.startsWith('Enrolled') ? 'saved' : 'error'}
            style={{ marginTop: 10 }}
          >
            {launchMsg}
          </div>
        )}
      </div>
    </div>
  );
}

function LaunchControls({
  accounts,
  accountId,
  setAccountId,
  launching,
  onLaunch,
  label,
}: {
  accounts: Account[];
  accountId: string;
  setAccountId: (id: string) => void;
  launching: boolean;
  onLaunch: () => void;
  label: string;
}) {
  if (accounts.length === 0) {
    return <span className="muted">No linked accounts. Link one in the Accounts tab first.</span>;
  }
  return (
    <div className="toolbar" style={{ margin: 0 }}>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.handle} ({a.state})
          </option>
        ))}
      </select>
      <button type="button" className="btn" onClick={onLaunch} disabled={!accountId || launching}>
        {launching ? 'Working…' : label}
      </button>
    </div>
  );
}
