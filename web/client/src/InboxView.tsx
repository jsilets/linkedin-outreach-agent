import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type InboxMessage, type InboxThread, type ReplyDetectorHealth } from './api';
import { formatRelative, formatStamp } from './format';

type InboxFilter = 'all' | 'approval' | 'replies' | 'sent';

const FILTERS: Array<{ id: InboxFilter; label: string; accessibleLabel: string }> = [
  { id: 'all', label: 'All', accessibleLabel: 'All conversations' },
  { id: 'approval', label: 'Review', accessibleLabel: 'Needs approval' },
  { id: 'replies', label: 'Replies', accessibleLabel: 'Replies' },
  { id: 'sent', label: 'Sent', accessibleLabel: 'Sent' },
];

function filterThreads(threads: InboxThread[], filter: InboxFilter): InboxThread[] {
  switch (filter) {
    case 'approval':
      return threads.filter((thread) => thread.needsApproval);
    case 'replies':
      return threads.filter((thread) => thread.hasInbound);
    case 'sent':
      return threads.filter((thread) =>
        thread.messages.some((message) => message.status === 'sent'),
      );
    default:
      return threads;
  }
}

function matchesSearch(thread: InboxThread, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [thread.name, thread.company, thread.headline, thread.latestPreview]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(needle));
}

function statusLabel(message: InboxMessage): string {
  if (message.pendingMessageId) return 'Needs approval';
  if (message.direction === 'inbound')
    return message.intent ? `Reply · ${message.intent}` : 'Reply';
  return message.status === 'sent' ? 'Sent' : message.status;
}

function detectorSummary(health: ReplyDetectorHealth): string {
  switch (health.status) {
    case 'healthy':
      return health.lastSuccessfulScanAt
        ? `Reply detection checked ${formatRelative(health.lastSuccessfulScanAt)}.`
        : 'Reply detection is healthy.';
    case 'failing':
      return `Reply detection could not check LinkedIn (${health.error?.phase ?? 'unknown error'}).`;
    case 'stale':
      return health.lastSuccessfulScanAt
        ? `Reply detection is stale. Last successful check ${formatRelative(health.lastSuccessfulScanAt)}.`
        : 'Reply detection is stale.';
    case 'disabled':
      return 'Reply detection is not running.';
    case 'never_run':
      return 'Reply detection has not completed a scan yet.';
  }
}

/** A local message workspace: a conversation list, chronological transcript,
 * and recipient context. It intentionally reads the durable audit trail rather
 * than opening LinkedIn from the browser. */
export function InboxView({
  focusTargetId = null,
  onFocusHandled,
}: {
  focusTargetId?: string | null;
  onFocusHandled?: () => void;
} = {}) {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [detectorHealth, setDetectorHealth] = useState<ReplyDetectorHealth | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [query, setQuery] = useState('');
  const [showThread, setShowThread] = useState(false);
  const [contactOpen, setContactOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [next, health] = await Promise.all([api.inbox(), api.inboxHealth()]);
    setThreads(next);
    setDetectorHealth(health);
    setLoaded(true);
    return next;
  }, []);

  useEffect(() => {
    load().catch((err) => {
      setError(err instanceof Error ? err.message : 'Could not load the inbox.');
      setLoaded(true);
    });
    const id = setInterval(() => load().catch(() => {}), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const visible = useMemo(
    () => filterThreads(threads, filter).filter((thread) => matchesSearch(thread, query)),
    [threads, filter, query],
  );
  const selected = visible.find((thread) => thread.id === selectedId) ?? visible[0] ?? null;
  const transcript = selected?.messages.filter((message) => !message.pendingMessageId) ?? [];
  const lastOutboundAt = [...transcript]
    .reverse()
    .find((message) => message.direction === 'outbound' && message.status === 'sent')?.createdAt;

  useEffect(() => {
    const focused = focusTargetId
      ? threads.find((thread) => thread.targetId === focusTargetId)
      : null;
    if (focused) {
      setFilter('all');
      setSelectedId(focused.id);
      setShowThread(true);
      onFocusHandled?.();
      return;
    }
    if (visible.length > 0 && !visible.some((thread) => thread.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null);
    }
    if (visible.length === 0) setSelectedId(null);
  }, [focusTargetId, onFocusHandled, selectedId, threads, visible]);

  if (!loaded) {
    return (
      <div className="card inbox-empty">
        <p className="muted">Loading inbox…</p>
      </div>
    );
  }

  return (
    <section
      className={`card inbox-workspace${showThread ? ' show-thread' : ''}${contactOpen ? '' : ' contact-closed'}`}
      aria-label="Unified inbox"
    >
      <aside className="inbox-threads" aria-label="Conversations">
        <div className="inbox-list-head">
          <div>
            <h2>Inbox</h2>
            <p>{threads.length ? `${threads.length} conversations` : 'Your message history'}</p>
            {detectorHealth && (
              <p
                className={`reply-detector-status ${detectorHealth.status}`}
                role={detectorHealth.status === 'failing' ? 'alert' : 'status'}
                title={detectorHealth.error?.message}
              >
                <span aria-hidden="true" />
                {detectorSummary(detectorHealth)}
                {detectorHealth.coverage && detectorHealth.status === 'healthy' && (
                  <small>
                    {detectorHealth.coverage.unmatchedThreads} unmatched recent thread
                    {detectorHealth.coverage.unmatchedThreads === 1 ? '' : 's'}
                  </small>
                )}
              </p>
            )}
          </div>
          <label className="inbox-search">
            <span className="sr-only">Search conversations</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people"
            />
          </label>
        </div>
        <div className="inbox-filters" role="tablist" aria-label="Inbox filters">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              aria-label={item.accessibleLabel}
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              <span>{item.label}</span>
              {item.id !== 'all' && (
                <span className="filter-count">{filterThreads(threads, item.id).length}</span>
              )}
            </button>
          ))}
        </div>
        {error && <p className="error inbox-load-error">{error}</p>}
        <div className="thread-list">
          {visible.map((thread) => (
            <button
              type="button"
              key={thread.id}
              className={`thread-row${selected?.id === thread.id ? ' selected' : ''}`}
              aria-current={selected?.id === thread.id ? 'page' : undefined}
              onClick={() => {
                setSelectedId(thread.id);
                setShowThread(true);
              }}
            >
              <span className="thread-row-top">
                <span className="thread-name">{thread.name ?? 'Unknown contact'}</span>
                <time dateTime={thread.latestAt}>{formatRelative(thread.latestAt)}</time>
              </span>
              <span className="thread-preview">{thread.latestPreview}</span>
              <span className="thread-signals">
                {thread.needsApproval && <span className="msg-tag approval">Needs approval</span>}
                {!thread.needsApproval && thread.hasInbound && (
                  <span className="msg-tag inbound">Replied</span>
                )}
              </span>
            </button>
          ))}
          {visible.length === 0 && (
            <div className="inbox-list-empty">No conversations in this view.</div>
          )}
        </div>
      </aside>

      <main className="inbox-transcript">
        {selected ? (
          <>
            <header className="transcript-head">
              <button
                type="button"
                className="mobile-inbox-back"
                onClick={() => setShowThread(false)}
              >
                Inbox
              </button>
              <div className="transcript-person">
                <div className="contact-avatar compact" aria-hidden="true">
                  {(selected.name ?? '?').slice(0, 1).toUpperCase()}
                </div>
                <h2>
                  <ProfileName name={selected.name} profileUrl={selected.profileUrl} />
                </h2>
                <p>{selected.company ?? selected.headline ?? 'LinkedIn conversation'}</p>
              </div>
              <div className="transcript-actions">
                {selected.needsApproval && <span className="msg-tag approval">Needs approval</span>}
                <button
                  type="button"
                  className="details-toggle"
                  aria-controls="contact-inspector"
                  aria-pressed={contactOpen}
                  onClick={() => setContactOpen((open) => !open)}
                >
                  {contactOpen ? 'Hide details' : 'Show details'}
                </button>
              </div>
            </header>
            <div className="message-stream" aria-live="polite">
              {selected.hasInbound && (
                <div className="automation-notice">
                  Automation is paused for this conversation after a reply.
                </div>
              )}
              {transcript.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {transcript.length === 0 && (
                <div className="thread-empty-state">
                  <span>Draft ready</span>
                  <p>Review it below before it is sent. Nothing has gone out yet.</p>
                </div>
              )}
            </div>
            {selected.messages
              .filter((message) => message.pendingMessageId)
              .map((message) => (
                <ApprovalComposer
                  key={message.id}
                  message={message}
                  lastOutboundAt={lastOutboundAt ?? null}
                  reload={load}
                />
              ))}
          </>
        ) : (
          <div className="inbox-empty">
            <h3>Inbox zero.</h3>
            <p>Sent messages, received replies, and drafts to approve will appear here.</p>
          </div>
        )}
      </main>

      <aside id="contact-inspector" className="inbox-contact" aria-label="Contact information">
        {selected ? (
          <>
            <div className="contact-avatar" aria-hidden="true">
              {(selected.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <h3>
              <ProfileName name={selected.name} profileUrl={selected.profileUrl} />
            </h3>
            {selected.headline && <p className="contact-headline">{selected.headline}</p>}
            {selected.company && <p className="contact-company">{selected.company}</p>}
            {selected.profileUrl && (
              <a href={selected.profileUrl} target="_blank" rel="noopener noreferrer">
                View LinkedIn profile
              </a>
            )}
            <dl className="contact-meta">
              <div>
                <dt>Campaign</dt>
                <dd title={selected.campaignGoal ?? undefined}>{selected.campaignGoal ?? '—'}</dd>
              </div>
              <div>
                <dt>Messages</dt>
                <dd>{selected.messages.length}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="muted">Select a conversation to see contact details.</p>
        )}
      </aside>
    </section>
  );
}

function ProfileName({ name, profileUrl }: { name: string | null; profileUrl: string | null }) {
  const label = name ?? 'Unknown contact';
  if (!profileUrl) return <>{label}</>;
  return (
    <a
      className="profile-name-link"
      href={profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${label}'s LinkedIn profile`}
    >
      {label}
    </a>
  );
}

function MessageBubble({ message }: { message: InboxMessage }) {
  return (
    <article className={`message-bubble ${message.direction}`}>
      <p>{message.body}</p>
      <footer>
        <span className={`msg-tag ${message.pendingMessageId ? 'approval' : message.direction}`}>
          {statusLabel(message)}
        </span>
        <time dateTime={message.createdAt}>{formatRelative(message.createdAt)}</time>
      </footer>
    </article>
  );
}

function ApprovalComposer({
  message,
  lastOutboundAt,
  reload,
}: {
  message: InboxMessage;
  lastOutboundAt: string | null;
  reload: () => Promise<InboxThread[]>;
}) {
  const [draft, setDraft] = useState(message.body);
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== message.body;
  const eligibleInFuture =
    message.eligibleAt !== null && new Date(message.eligibleAt).getTime() > Date.now();
  const queueStatus = eligibleInFuture
    ? `Eligible ${formatStamp(message.eligibleAt)}`
    : 'Ready when approved';
  const queueDetail = eligibleInFuture
    ? 'Approval queues it for that scheduled window.'
    : message.eligibleAt
      ? `Follow-up became eligible ${formatRelative(message.eligibleAt)}.`
      : 'No scheduled wait remains.';

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api.approve(message.pendingMessageId!, dirty ? draft : undefined);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve this draft.');
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      await api.reject(message.pendingMessageId!, reason.trim());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reject this draft.');
      setBusy(false);
    }
  }

  return (
    <section className="approval-composer" aria-label="Approve draft">
      <div className="approval-composer-head">
        <div>
          <strong>Review draft</strong>
          <p className="approval-schedule">
            <span>{queueStatus}</span>
            <span>{queueDetail}</span>
            {lastOutboundAt && <span>Last message sent {formatRelative(lastOutboundAt)}.</span>}
          </p>
        </div>
        <span className="msg-tag approval">Needs review</span>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Draft message"
        rows={5}
      />
      {error && <p className="error">{error}</p>}
      {rejecting ? (
        <div className="inbox-reject">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (kept in the audit log)"
          />
          <button
            type="button"
            className="btn ghost tiny"
            disabled={busy || !reason.trim()}
            onClick={reject}
          >
            {busy ? 'Rejecting…' : 'Confirm reject'}
          </button>
          <button
            type="button"
            className="btn ghost tiny"
            disabled={busy}
            onClick={() => setRejecting(false)}
          >
            Cancel
          </button>
        </div>
      ) : confirming ? (
        <div className="approval-confirm">
          <span>Ready to approve this version?</span>
          <button type="button" className="btn approve" disabled={busy} onClick={approve}>
            {busy ? 'Approving…' : 'Approve & queue'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Keep editing
          </button>
        </div>
      ) : (
        <div className="inbox-actions">
          <button
            type="button"
            className="btn approve"
            disabled={busy || !draft.trim()}
            onClick={() => setConfirming(true)}
          >
            {dirty ? 'Review edited draft' : 'Approve & queue'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            Reject
          </button>
        </div>
      )}
    </section>
  );
}
