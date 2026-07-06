import { useEffect, useState } from 'react';
import { api, type ListDetail, type ListSummary } from './api';

export function ListsView() {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function loadLists() {
    api.lists().then(setLists).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    loadLists();
  }, []);

  async function create() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const body = { name: name.trim(), description: description.trim() || undefined };
      const res = await api.createList(body);
      setSuccess(`Created ${res.name}`);
      setName('');
      setDescription('');
      loadLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed.');
    } finally {
      setSaving(false);
    }
  }

  if (selected) {
    return <ListDetailView id={selected} onBack={() => setSelected(null)} />;
  }

  const canSubmit = name.trim() && !saving;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <strong>Create a lead list</strong>
        <div className="grid" style={{ marginTop: 12 }}>
          <div>
            <label>List name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 SaaS founders"
            />
          </div>
          <div>
            <label>Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's in this list"
            />
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn" onClick={create} disabled={!canSubmit}>
              {saving ? 'Creating...' : 'Create list'}
            </button>
            <span className="spacer" />
            {success && <span className="saved">{success}</span>}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>

      {lists === null ? (
        <p className="muted">Loading...</p>
      ) : lists.length === 0 ? (
        <p className="muted">No lists yet. Create one above.</p>
      ) : (
        <div className="grid">
          {lists.map((l) => (
            <div className="card campaign-row" key={l.id} onClick={() => setSelected(l.id)}>
              <div>
                <h3>{l.name}</h3>
                <div className="muted">
                  {l.description ? `${l.description} · ` : ''}
                  {l.memberCount} {l.memberCount === 1 ? 'lead' : 'leads'} · created{' '}
                  {new Date(l.createdAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ListDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ListDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [creating, setCreating] = useState(false);
  const [campaignMsg, setCampaignMsg] = useState<string | null>(null);

  useEffect(() => {
    api.getList(id).then(setDetail).catch((e) => setError(String(e)));
  }, [id]);

  async function createCampaign() {
    setCreating(true);
    setCampaignMsg(null);
    try {
      const res = await api.createCampaignFromList(id, { goal: goal.trim() });
      setCampaignMsg(
        `Campaign created with ${res.targetCount} ${res.targetCount === 1 ? 'lead' : 'leads'}. ` +
          `Open the Campaigns tab to set its funnel.`,
      );
      setGoal('');
    } catch (e) {
      setCampaignMsg(e instanceof Error ? e.message : 'Create failed.');
    } finally {
      setCreating(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading...</p>;

  const memberCount = detail.members.length;

  return (
    <div>
      <span className="back" onClick={onBack}>
        &larr; All lists
      </span>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 6px' }}>{detail.name}</h2>
        {detail.description && <div className="muted">{detail.description}</div>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Start a campaign from this list</strong>
        <div className="muted" style={{ margin: '4px 0 12px' }}>
          Creates a campaign and enrolls all {memberCount} {memberCount === 1 ? 'lead' : 'leads'} as
          targets. You set the funnel steps afterwards in the Campaigns tab.
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Campaign goal, e.g. book intro calls with EV O&M leads"
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={createCampaign} disabled={!goal.trim() || creating || memberCount === 0}>
            {creating ? 'Creating...' : 'Create campaign'}
          </button>
        </div>
        {campaignMsg && (
          <div className={campaignMsg.startsWith('Campaign created') ? 'saved' : 'error'} style={{ marginTop: 10 }}>
            {campaignMsg}
          </div>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Headline</th>
              <th>Company</th>
              <th>Degree</th>
              <th>Location</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {detail.members.map((m) => (
              <tr key={m.id}>
                <td>{m.name ?? '—'}</td>
                <td>{m.headline ?? '—'}</td>
                <td>{m.currentCompany ?? '—'}</td>
                <td>{m.degree ?? '—'}</td>
                <td>{m.location ?? '—'}</td>
                <td>
                  {m.profileUrl ? (
                    <a href={m.profileUrl} target="_blank" rel="noreferrer">
                      View
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {detail.members.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No leads in this list yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
