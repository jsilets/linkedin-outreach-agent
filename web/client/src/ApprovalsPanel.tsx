import { useState } from 'react';
import { api, type Pending } from './api';
import { formatRelative } from './format';

/**
 * The queue of drafted messages waiting on a human. Approve sends as-is, Edit
 * lets you change the text before sending, Reject drops it with a reason. Every
 * action drives the real runtime executor, so this is the one place in the UI
 * that sends. When showCampaign is set (the cross-campaign view) each card names
 * its campaign.
 */
export function ApprovalsPanel({
  pending,
  onChange,
  showCampaign = false,
}: {
  pending: Pending[];
  onChange: () => void;
  showCampaign?: boolean;
}) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approveAll() {
    setBulkBusy(true);
    setError(null);
    try {
      const res = await api.bulkApprove(pending.map((p) => p.messageId));
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) setError(`${failed.length} of ${res.results.length} could not be sent.`);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk approve failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  if (pending.length === 0) {
    return <div className="empty">Nothing waiting on you.</div>;
  }

  return (
    <div>
      {pending.length > 1 && (
        <div className="toolbar" style={{ margin: '0 0 10px' }}>
          <span className="muted">{pending.length} messages waiting for approval</span>
          <span className="spacer" />
          <button className="btn approve tiny" onClick={approveAll} disabled={bulkBusy}>
            {bulkBusy ? 'Sending…' : `Approve all ${pending.length}`}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="approvals-wrap">
        {pending.map((p) => (
          <ApprovalCard
            key={p.messageId}
            item={p}
            onChange={onChange}
            showCampaign={showCampaign}
          />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({
  item,
  onChange,
  showCampaign,
}: {
  item: Pending;
  onChange: () => void;
  showCampaign: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [draft, setDraft] = useState(item.body);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipient = item.name ?? 'this lead';

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
      setBusy(false);
    }
  }

  return (
    <div className="approval">
      <div className="approval-head">
        <span className="to">{recipient}</span>
        {item.company && <span className="muted">· {item.company}</span>}
        {showCampaign && item.campaignGoal && <span className="muted">· {item.campaignGoal}</span>}
        <span className="age">
          waiting {formatRelative(item.createdAt).replace('ago', '').trim()}
        </span>
      </div>

      {mode === 'edit' ? (
        <textarea
          className="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
        />
      ) : (
        <div className="draft">{item.body}</div>
      )}

      {mode === 'reject' && (
        <input
          style={{ marginTop: 8 }}
          placeholder="Reason (kept in the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}

      {error && <div className="error">{error}</div>}

      <div className="approval-actions">
        {mode === 'view' && (
          <>
            <button
              className="btn approve tiny"
              disabled={busy}
              onClick={() => run(() => api.approve(item.messageId))}
            >
              {busy ? 'Sending…' : 'Approve & send'}
            </button>
            <button className="btn ghost tiny" disabled={busy} onClick={() => setMode('edit')}>
              Edit
            </button>
            <button className="btn ghost tiny" disabled={busy} onClick={() => setMode('reject')}>
              Reject
            </button>
          </>
        )}
        {mode === 'edit' && (
          <>
            <button
              className="btn approve tiny"
              disabled={busy || draft.trim().length === 0}
              onClick={() => run(() => api.approve(item.messageId, draft))}
            >
              {busy ? 'Sending…' : 'Send edited'}
            </button>
            <button
              className="btn ghost tiny"
              disabled={busy}
              onClick={() => {
                setDraft(item.body);
                setMode('view');
              }}
            >
              Cancel
            </button>
          </>
        )}
        {mode === 'reject' && (
          <>
            <button
              className="btn ghost tiny"
              disabled={busy || reason.trim().length === 0}
              onClick={() => run(() => api.reject(item.messageId, reason.trim()))}
            >
              {busy ? 'Rejecting…' : 'Confirm reject'}
            </button>
            <button className="btn ghost tiny" disabled={busy} onClick={() => setMode('view')}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
