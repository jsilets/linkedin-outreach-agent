import { useEffect, useState } from 'react';
import { api, type Account, type CampaignDetail, type CampaignSummary } from './api';
import { FlowEditor } from './FlowEditor';

const STAGE_ORDER = [
  'sourced',
  'queued',
  'invited',
  'connected',
  'in_conversation',
  'replied',
  'won',
  'lost',
];

function StagePills({ byStage }: { byStage: Record<string, number> }) {
  const entries = Object.entries(byStage).sort(
    (a, b) => STAGE_ORDER.indexOf(a[0]) - STAGE_ORDER.indexOf(b[0]),
  );
  if (entries.length === 0) return <span className="muted">no targets</span>;
  return (
    <div className="stages">
      {entries.map(([stage, n]) => (
        <span className="pill" key={stage}>
          {stage.replace(/_/g, ' ')}
          <span className="n">{n}</span>
        </span>
      ))}
    </div>
  );
}

export function CampaignsView() {
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.campaigns().then(setList).catch((e) => setError(String(e)));
  }, []);

  if (selected) {
    return <CampaignDetailView id={selected} onBack={() => setSelected(null)} />;
  }

  if (error) return <div className="error">{error}</div>;
  if (!list) return <p className="muted">Loading...</p>;
  if (list.length === 0) {
    return <p className="muted">No campaigns yet. Create one via the engine, then it shows here.</p>;
  }

  return (
    <div className="grid">
      {list.map((c) => (
        <div className="card campaign-row" key={c.id} onClick={() => setSelected(c.id)}>
          <div>
            <h3>{c.goal}</h3>
            <div className="muted">
              {c.owner} · {c.autonomyLevel} · {c.targetCount} targets
            </div>
          </div>
          <StagePills byStage={c.byStage} />
        </div>
      ))}
    </div>
  );
}

function CampaignDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);

  function load() {
    api.campaign(id).then(setDetail).catch((e) => setError(String(e)));
  }
  useEffect(() => {
    load();
    api.accounts().then((a) => {
      setAccounts(a);
      if (a[0]) setAccountId((prev) => prev || a[0]!.id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function launch() {
    setLaunching(true);
    setLaunchMsg(null);
    try {
      const res = await api.launchCampaign(id, accountId);
      setLaunchMsg(
        `Launched: enrolled ${res.enrolled} ${res.enrolled === 1 ? 'target' : 'targets'}` +
          (res.alreadyEnrolled ? ` (${res.alreadyEnrolled} already enrolled)` : '') +
          '. The dispatch loop will start stepping them.',
      );
      load();
    } catch (e) {
      setLaunchMsg(e instanceof Error ? e.message : 'Launch failed.');
    } finally {
      setLaunching(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading...</p>;

  const launched = Object.values(detail.byProgressState).reduce((a, b) => a + b, 0);

  return (
    <div>
      <span className="back" onClick={onBack}>
        &larr; All campaigns
      </span>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 6px' }}>{detail.goal}</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          {detail.owner} · {detail.autonomyLevel} · strategy: {detail.messageStrategy}
        </div>
        <div className="stages" style={{ marginBottom: 8 }}>
          <StagePills byStage={detail.byStage} />
        </div>
        <div className="stages">
          {Object.entries(detail.byProgressState).map(([state, n]) => (
            <span className="pill" key={state}>
              {state.replace(/_/g, ' ')}
              <span className="n">{n}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Flow</h3>
        <FlowEditor campaignId={id} initial={detail.steps} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Launch</h3>
        <div className="muted" style={{ marginBottom: 12 }}>
          Enroll this campaign&apos;s targets under a linked account. Save the funnel above first;
          the dispatch loop then steps each lead through it. {launched > 0 ? `${launched} already enrolled.` : ''}
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {accounts.length === 0 ? (
            <span className="muted">No linked accounts. Link one in the Accounts tab first.</span>
          ) : (
            <>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.handle} ({a.state})
                  </option>
                ))}
              </select>
              <button className="btn" onClick={launch} disabled={!accountId || launching}>
                {launching ? 'Launching...' : 'Launch campaign'}
              </button>
            </>
          )}
        </div>
        {launchMsg && (
          <div className={launchMsg.startsWith('Launched') ? 'saved' : 'error'} style={{ marginTop: 10 }}>
            {launchMsg}
          </div>
        )}
      </div>
    </div>
  );
}
