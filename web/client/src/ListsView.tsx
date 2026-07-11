import { useEffect, useState } from 'react';
import { api, type ListDetail, type ListMember, type ListSummary } from './api';
import { DataTable, type Column } from './DataTable';

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
    <div className="grid" style={{ gap: 'var(--space-5)' }}>
      <div className="card">
        <strong>Create a lead list</strong>
        <div className="grid" style={{ marginTop: 'var(--space-3)' }}>
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

  useEffect(() => {
    api.getList(id).then(setDetail).catch((e) => setError(String(e)));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading...</p>;

  const columns: Column<ListMember>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (m) => (m.name ?? '').toLowerCase(),
      cell: (m) => m.name ?? '—',
    },
    {
      key: 'headline',
      header: 'Headline',
      sortValue: (m) => (m.headline ?? '').toLowerCase(),
      cell: (m) => m.headline ?? '—',
    },
    {
      key: 'company',
      header: 'Company',
      sortValue: (m) => (m.currentCompany ?? '').toLowerCase(),
      cell: (m) => m.currentCompany ?? '—',
    },
    {
      key: 'degree',
      header: 'Degree',
      sortValue: (m) => m.degree ?? '',
      cell: (m) => m.degree ?? '—',
    },
    {
      key: 'location',
      header: 'Location',
      sortValue: (m) => (m.location ?? '').toLowerCase(),
      cell: (m) => m.location ?? '—',
    },
    {
      key: 'profile',
      header: 'Profile',
      sortable: false,
      cell: (m) =>
        m.profileUrl ? (
          <a href={m.profileUrl} target="_blank" rel="noreferrer">
            View
          </a>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <div>
      <span className="back" onClick={onBack}>
        &larr; All lists
      </span>
      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 style={{ margin: '0 0 var(--space-1)' }}>{detail.name}</h2>
        {detail.description && <div className="muted">{detail.description}</div>}
      </div>

      <div className="card">
        <div className="section-head">
          <h3>Leads</h3>
          <span className="count-tag">{detail.members.length}</span>
        </div>
        {detail.members.length === 0 ? (
          <div className="empty">No leads in this list yet.</div>
        ) : (
          <DataTable
            rows={detail.members}
            columns={columns}
            rowKey={(m) => m.id}
            search={(m) =>
              [m.name, m.headline, m.currentCompany, m.location].filter(Boolean).join(' ')
            }
            searchPlaceholder="Filter leads by name, company, location…"
          />
        )}
      </div>
    </div>
  );
}
