import { useEffect, useState } from 'react';
import { api, type CampaignDetail, type CampaignSummary } from './api';
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

  useEffect(() => {
    api.campaign(id).then(setDetail).catch((e) => setError(String(e)));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading...</p>;

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
    </div>
  );
}
