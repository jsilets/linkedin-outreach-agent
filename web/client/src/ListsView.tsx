import { useEffect, useState } from 'react';
import { api, type ListDetail, type ListMember, type ListSummary } from './api';
import { type Column, DataTable } from './DataTable';

export function ListsView() {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .lists()
      .then(setLists)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (selected) {
    return <ListDetailView id={selected} onBack={() => setSelected(null)} />;
  }

  if (error) return <div className="error">{error}</div>;
  if (lists === null) return <p className="muted">Loading...</p>;
  if (lists.length === 0) {
    return (
      <p className="muted">
        No lists yet. Create one via the engine (create_list), then it shows here.
      </p>
    );
  }

  return (
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
  );
}

function ListDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ListDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  function load() {
    api
      .getList(id)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function remove(m: ListMember) {
    if (!window.confirm(`Remove ${m.name ?? 'this lead'} from the list?`)) return;
    setRemoving(m.id);
    setError(null);
    try {
      await api.removeListMembers(id, [m.id]);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed.');
    } finally {
      setRemoving(null);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="muted">Loading...</p>;

  const offIcpCount = detail.members.filter((m) => m.offIcp).length;

  const columns: Column<ListMember>[] = [
    {
      key: 'score',
      header: 'Fit',
      numeric: true,
      // Sort unscored rows to the end; off-ICP rows carry a badge.
      sortValue: (m) => m.score,
      cell: (m) =>
        m.score === null ? (
          <span className="muted">—</span>
        ) : (
          <span title={(m.scoreReasons ?? []).join('\n') || undefined}>
            {m.score}
            {m.offIcp && (
              <span className="icp-badge" style={{ marginLeft: 6 }}>
                off-ICP
              </span>
            )}
          </span>
        ),
    },
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
    {
      key: 'actions',
      header: '',
      sortable: false,
      cell: (m) => (
        <button
          type="button"
          className="btn tiny danger"
          disabled={removing === m.id}
          onClick={() => remove(m)}
        >
          {removing === m.id ? 'Removing…' : 'Remove'}
        </button>
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
          {offIcpCount > 0 && (
            <span className="icp-badge" style={{ marginLeft: 'var(--space-2)' }}>
              {offIcpCount} off-ICP
            </span>
          )}
        </div>
        {detail.members.length === 0 ? (
          <div className="empty">No leads in this list yet.</div>
        ) : (
          <DataTable
            rows={detail.members}
            columns={columns}
            rowKey={(m) => m.id}
            rowClassName={(m) => (m.offIcp ? 'row-warn' : undefined)}
            initialSort={{ key: 'score', dir: 'desc' }}
            persistKey="list-members"
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
