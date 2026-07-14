import { useCallback, useEffect, useState } from 'react';
import { api, type Pending } from './api';
import { formatRelative } from './format';

// A draft's waiting time as a bare magnitude ("19m", "3h"): formatRelative with
// the trailing "ago" stripped, since the surrounding copy already says "waiting".
function waitingFor(iso: string): string {
  return formatRelative(iso).replace('ago', '').trim();
}

// The one-line context under a name: company and campaign goal, whichever exist.
function contextLine(p: Pending): string {
  return [p.company, p.campaignGoal].filter(Boolean).join(' · ');
}

/**
 * A two-pane approval inbox (Unibox-style): the queue of drafted messages waiting
 * on a human on the left, the selected draft — editable in place — on the right.
 * Every action drives the real runtime executor, so this is the one place in the
 * UI that sends. Approving/rejecting advances to the next draft by position.
 */
export function InboxView({
  focusTargetId = null,
  onFocusHandled,
}: {
  focusTargetId?: string | null;
  onFocusHandled?: () => void;
} = {}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Mobile only: the panes stack, so a selection swaps the list out for the
  // detail. Ignored at desktop width, where both panes are always visible.
  const [showDetail, setShowDetail] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(() => {
    return api.pending().then((p) => {
      setPending(p);
      setLoaded(true);
      return p;
    });
  }, []);

  useEffect(() => {
    load().catch(() => setLoaded(true));
    const id = setInterval(() => load().catch(() => {}), 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Keep a valid selection as the queue changes under polls / initial load:
  // default to the first draft, and if the selected one vanishes fall back to
  // the first. Action-driven "select the next by position" is handled inline in
  // the handlers below (which set a specific id this effect then leaves alone).
  useEffect(() => {
    if (pending.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    // A lead opened from the Scheduled feed's "pending approval" link takes
    // precedence: select its draft, open the detail pane, scroll it into view,
    // and tell the parent the request was consumed so a later poll does not keep
    // yanking the selection back.
    const focus = focusTargetId ? pending.find((p) => p.targetId === focusTargetId) : undefined;
    if (focus) {
      setSelectedId(focus.messageId);
      setShowDetail(true);
      requestAnimationFrame(() =>
        document
          .getElementById(`inbox-item-${focus.messageId}`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
      onFocusHandled?.();
      return;
    }
    if (selectedId === null || !pending.some((p) => p.messageId === selectedId)) {
      setSelectedId(pending[0]?.messageId ?? null);
    }
  }, [pending, selectedId, focusTargetId, onFocusHandled]);

  // After an item leaves the queue, land on the one that took its place (same
  // index), else the new last, else nothing.
  function selectNext(list: Pending[], removedIndex: number) {
    if (list.length === 0) {
      setSelectedId(null);
      setShowDetail(false);
      return;
    }
    const idx = Math.min(Math.max(0, removedIndex), list.length - 1);
    setSelectedId(list[idx]?.messageId ?? null);
  }

  // Approve/reject the selected draft, then refetch and advance. The api call is
  // NOT caught here — the detail pane surfaces the error and keeps the draft.
  async function approveSelected(body?: string) {
    if (!selectedId) return;
    const removedIndex = pending.findIndex((p) => p.messageId === selectedId);
    await api.approve(selectedId, body);
    selectNext(await load(), removedIndex);
  }

  async function rejectSelected(reason: string) {
    if (!selectedId) return;
    const removedIndex = pending.findIndex((p) => p.messageId === selectedId);
    await api.reject(selectedId, reason);
    selectNext(await load(), removedIndex);
  }

  async function approveAll() {
    setBulkBusy(true);
    setListError(null);
    try {
      const res = await api.bulkApprove(pending.map((p) => p.messageId));
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length)
        setListError(`${failed.length} of ${res.results.length} could not be sent.`);
      selectNext(await load(), 0);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Bulk approve failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  if (!loaded) {
    return (
      <div className="card">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <div className="card inbox-empty">
        <h3>Inbox zero.</h3>
        <p>Drafts that need your approval will land here.</p>
      </div>
    );
  }

  const selected = pending.find((p) => p.messageId === selectedId) ?? null;

  return (
    <div className={`card inbox${showDetail ? ' show-detail' : ''}`}>
      <div className="inbox-list">
        <div className="inbox-list-head">
          <span className="count-tag">{pending.length}</span>
          <span className="spacer" />
          {pending.length > 1 && (
            <button
              type="button"
              className="btn approve tiny"
              onClick={approveAll}
              disabled={bulkBusy}
            >
              {bulkBusy ? 'Sending…' : `Approve all ${pending.length}`}
            </button>
          )}
        </div>
        {listError && (
          <div className="error" style={{ padding: '0 var(--space-3)' }}>
            {listError}
          </div>
        )}
        {pending.map((p) => {
          const on = p.messageId === selectedId;
          const context = contextLine(p);
          return (
            <button
              type="button"
              key={p.messageId}
              id={`inbox-item-${p.messageId}`}
              className={`inbox-item${on ? ' selected' : ''}`}
              aria-pressed={on}
              onClick={() => {
                setSelectedId(p.messageId);
                setShowDetail(true);
              }}
            >
              <span className="ii-line1">
                <span className="ii-name">{p.name ?? 'Unknown'}</span>
                <span className="ii-wait">{waitingFor(p.createdAt)}</span>
              </span>
              {context && <span className="ii-line2">{context}</span>}
              <span className="ii-body">{p.body}</span>
            </button>
          );
        })}
      </div>

      <div className="inbox-detail">
        {selected && (
          <InboxDetail
            key={selected.messageId}
            item={selected}
            onApprove={approveSelected}
            onReject={rejectSelected}
            onBack={() => setShowDetail(false)}
          />
        )}
      </div>
    </div>
  );
}

function InboxDetail({
  item,
  onApprove,
  onReject,
  onBack,
}: {
  item: Pending;
  onApprove: (body?: string) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState(item.body);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft !== item.body;
  const recipient = item.name ?? 'this lead';

  // On success the parent reselects (this component is keyed by messageId, so it
  // unmounts) — no need to reset busy. On failure keep the draft and show why.
  async function submitApprove() {
    setBusy(true);
    setError(null);
    try {
      await onApprove(dirty ? draft : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed.');
      setBusy(false);
    }
  }

  async function submitReject() {
    setBusy(true);
    setError(null);
    try {
      await onReject(reason.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed.');
      setBusy(false);
    }
  }

  return (
    <>
      <span className="back inbox-back" onClick={onBack}>
        &larr; All drafts
      </span>
      <div className="inbox-detail-head">
        <span className="name">
          {item.profileUrl ? (
            <a href={item.profileUrl} target="_blank" rel="noopener noreferrer">
              {recipient}
            </a>
          ) : (
            recipient
          )}
        </span>
        {item.company && <span className="muted">· {item.company}</span>}
        {item.campaignGoal && <span className="muted">· {item.campaignGoal}</span>}
        <span className="wait">waiting {waitingFor(item.createdAt)}</span>
      </div>

      <textarea
        className="draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Draft message"
      />

      {error && <div className="error">{error}</div>}

      <div className="inbox-actions">
        {!rejecting ? (
          <>
            <button
              type="button"
              className="btn approve"
              disabled={busy || draft.trim().length === 0}
              onClick={submitApprove}
            >
              {busy ? 'Sending…' : dirty ? 'Send edited' : 'Approve & send'}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          </>
        ) : (
          <div className="inbox-reject">
            <input
              placeholder="Reason (kept in the audit log)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="btn ghost tiny"
              disabled={busy || reason.trim().length === 0}
              onClick={submitReject}
            >
              {busy ? 'Rejecting…' : 'Confirm reject'}
            </button>
            <button
              type="button"
              className="btn ghost tiny"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
                setReason('');
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </>
  );
}
