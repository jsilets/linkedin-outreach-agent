import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type DispatchHealth,
  type InboxMessage,
  type InboxThread,
  type MessageTiming,
  type ReplyDetectorHealth,
} from './api';
import { formatClock, formatDayClock, formatRelative, formatStamp } from './format';
import { runWriteAction, type WriteOutcome } from './writeAction';

type InboxFilter = 'all' | 'approval' | 'replies' | 'sent';

const FILTERS: Array<{ id: InboxFilter; label: string; accessibleLabel: string }> = [
  { id: 'all', label: 'All', accessibleLabel: 'All conversations' },
  { id: 'approval', label: 'Review', accessibleLabel: 'Needs approval' },
  { id: 'replies', label: 'Replies', accessibleLabel: 'Replies' },
  { id: 'sent', label: 'Sent', accessibleLabel: 'Sent' },
];

/** Inbound rows are persisted with status 'sent' too, so direction is what
 * separates "we sent this" from "they replied". */
export function isOutboundSend(message: InboxMessage): boolean {
  return message.direction === 'outbound' && message.status === 'sent';
}

export function filterThreads(threads: InboxThread[], filter: InboxFilter): InboxThread[] {
  switch (filter) {
    case 'approval':
      return threads.filter((thread) => thread.needsApproval);
    case 'replies':
      return threads.filter((thread) => thread.hasInbound);
    case 'sent':
      return threads.filter((thread) => thread.messages.some(isOutboundSend));
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

/** Timing copy, plus the instant it names. `at` is null when the copy names no
 * instant, so the caller renders a plain span rather than a lying <time>. */
export interface TimingLabel {
  text: string;
  at: string | null;
}

/** Whole local calendar days from today to `iso`. Built from Date.UTC over local
 * date parts so a DST boundary inside the span cannot round the answer off. */
function calendarDayDelta(iso: string): number {
  const then = new Date(iso);
  const now = new Date();
  const thenDay = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((thenDay - nowDay) / 86_400_000);
}

/** Why a queue is frozen, phrased so it cannot be read as a wait that ends on its
 * own. Each of these clears only when a human resumes or unblocks the account. */
const BLOCKED_REASON_TEXT: Record<'paused' | 'restricted' | 'cooldown', string> = {
  paused: 'sending is paused for this account',
  restricted: 'account restricted — nothing will send',
  cooldown: 'account in cooldown — nothing will send',
};

const BLOCKED_REASON_TERSE: Record<'paused' | 'restricted' | 'cooldown', string> = {
  paused: 'Paused',
  restricted: 'Restricted',
  cooldown: 'Cooldown',
};

/** The operator's question is "if it's sent, how long ago; if it's queued, when
 * will it go; if it needs approval, is it ready now or by when". */
export function timingLabel(timing: MessageTiming): TimingLabel {
  switch (timing.kind) {
    case 'received':
      return { text: `Received ${formatRelative(timing.at)}`, at: timing.at };
    case 'sent':
      return { text: `Sent ${formatRelative(timing.at)}`, at: timing.at };
    case 'queued_soon':
      // Never a countdown here. The remaining wait is the safety gate's
      // anti-burst pacer, minActionGapMs + rand(0, jitter), re-rolled every
      // tick, so no honest number exists to show.
      return { text: 'Queued · sends in the next few minutes', at: null };
    case 'queued_window':
      return { text: `Queued · sends after ${formatClock(timing.at)}`, at: timing.at };
    case 'queued_capped':
      return {
        text:
          calendarDayDelta(timing.at) === 1
            ? 'Queued · sends tomorrow (daily cap reached)'
            : `Queued · sends ${formatDayClock(timing.at)} (daily cap reached)`,
        at: timing.at,
      };
    case 'queued_blocked':
      // No instant, and deliberately no "soon": the gate denies these outright,
      // so the queue is frozen until a person acts on the account.
      return { text: `Queued · ${BLOCKED_REASON_TEXT[timing.reason]}`, at: null };
    case 'awaiting_approval':
      return timing.readyAt === null
        ? { text: 'Ready to send · needs approval', at: null }
        : { text: `Needs approval before ${formatDayClock(timing.readyAt)}`, at: timing.readyAt };
  }
}

/** The same reading, terse enough for the thread list. A queued thread must read
 * as pending rather than as the age of its draft. */
export function threadTimingLabel(timing: MessageTiming): TimingLabel {
  switch (timing.kind) {
    case 'received':
    case 'sent':
      return { text: formatRelative(timing.at), at: timing.at };
    case 'queued_soon':
      return { text: 'Queued', at: null };
    case 'queued_window':
      return { text: `Queued · ${formatClock(timing.at)}`, at: timing.at };
    case 'queued_capped':
      return {
        text:
          calendarDayDelta(timing.at) === 1
            ? 'Queued · tomorrow'
            : `Queued · ${formatDayClock(timing.at)}`,
        at: timing.at,
      };
    case 'queued_blocked':
      // Terse, but never bare 'Queued': in the list this row must not sit among
      // the genuinely-moving ones looking like one of them.
      return { text: `Queued · ${BLOCKED_REASON_TERSE[timing.reason]}`, at: null };
    case 'awaiting_approval':
      return timing.readyAt === null
        ? { text: 'Ready now', at: null }
        : { text: `Ready ${formatRelative(timing.readyAt)}`, at: timing.readyAt };
  }
}

/** The message `latestAt`/`latestPreview` were taken from. The server keeps the
 * last row at the max createdAt, so ties resolve here the same way they did
 * there — otherwise the row's timing could describe a different message than
 * its own preview text. */
export function latestMessage(thread: InboxThread): InboxMessage | null {
  let latest: InboxMessage | null = null;
  for (const message of thread.messages) {
    if (!latest || new Date(message.createdAt) >= new Date(latest.createdAt)) latest = message;
  }
  return latest;
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

/** Null while dispatch is running: the "Queued" labels speak for themselves.
 * Any other state means nothing is being sent and they would be a lie. */
function dispatchSummary(health: DispatchHealth): string | null {
  switch (health.status) {
    case 'running':
      return null;
    case 'disabled':
      return 'Sending is turned off. Nothing queued will go out until it is running again.';
    case 'never_run':
      return 'Sending has never run. Nothing queued will go out until it starts.';
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
  const [dispatchHealth, setDispatchHealth] = useState<DispatchHealth | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [query, setQuery] = useState('');
  const [showThread, setShowThread] = useState(false);
  const [contactOpen, setContactOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [next, health, dispatch] = await Promise.all([
      api.inbox(),
      api.inboxHealth(),
      api.dispatchHealth(),
    ]);
    setThreads(next);
    setDetectorHealth(health);
    setDispatchHealth(dispatch);
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
  const lastOutboundAt = [...transcript].reverse().find(isOutboundSend)?.createdAt;

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
                className={`inbox-health-note ${detectorHealth.status}`}
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
            {dispatchHealth && dispatchSummary(dispatchHealth) && (
              <p className={`inbox-health-note ${dispatchHealth.status}`} role="alert">
                <span aria-hidden="true" />
                {dispatchSummary(dispatchHealth)}
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
                <ThreadWhen thread={thread} />
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

function ThreadWhen({ thread }: { thread: InboxThread }) {
  const latest = latestMessage(thread);
  const label = latest
    ? threadTimingLabel(latest.timing)
    : { text: formatRelative(thread.latestAt), at: thread.latestAt };
  if (!label.at) return <span className="thread-when">{label.text}</span>;
  return (
    <time className="thread-when" dateTime={label.at}>
      {label.text}
    </time>
  );
}

function MessageBubble({ message }: { message: InboxMessage }) {
  const label = timingLabel(message.timing);
  return (
    <article className={`message-bubble ${message.direction}`}>
      <p>{message.body}</p>
      <footer>
        {message.intent && <span className={`msg-tag ${message.direction}`}>{message.intent}</span>}
        {label.at ? (
          <time className="msg-timing" dateTime={label.at}>
            {label.text}
          </time>
        ) : (
          <span className="msg-timing">{label.text}</span>
        )}
      </footer>
    </article>
  );
}

/** Outcome of a composer action. 'stale' means the runtime accepted the action
 * (a send may already be dispatching) but the inbox re-read failed: the action
 * must never be offered for retry from that state. */
export type ComposerOutcome = WriteOutcome;

export type ComposerPhase = 'idle' | 'working' | ComposerOutcome['phase'];

/** Anything the runtime already accepted stays locked even while this composer
 * is still mounted: a second click is a second real send. */
export function composerLocked(phase: ComposerPhase): boolean {
  return phase === 'working' || phase === 'done' || phase === 'stale';
}

export async function runComposerAction(
  act: () => Promise<unknown>,
  reload: () => Promise<unknown>,
  failureNotice: string,
): Promise<ComposerOutcome> {
  return runWriteAction(act, reload, {
    failure: failureNotice,
    stale: 'Done, but the inbox could not refresh. Do not retry; it updates on the next check.',
  });
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
  const [phase, setPhase] = useState<ComposerPhase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const busy = phase === 'working';
  const locked = composerLocked(phase);
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

  function settle(outcome: ComposerOutcome) {
    setPhase(outcome.phase);
    setNotice(outcome.phase === 'done' ? null : outcome.notice);
  }

  async function approve() {
    setPhase('working');
    setNotice(null);
    settle(
      await runComposerAction(
        () => api.approve(message.pendingMessageId!, dirty ? draft : undefined),
        reload,
        'Could not approve this draft.',
      ),
    );
  }

  async function reject() {
    setPhase('working');
    setNotice(null);
    settle(
      await runComposerAction(
        () => api.reject(message.pendingMessageId!, reason.trim()),
        reload,
        'Could not reject this draft.',
      ),
    );
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
      {notice && <p className={phase === 'error' ? 'error' : 'muted'}>{notice}</p>}
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
            disabled={locked || !reason.trim()}
            onClick={reject}
          >
            {busy ? 'Rejecting…' : 'Confirm reject'}
          </button>
          <button
            type="button"
            className="btn ghost tiny"
            disabled={locked}
            onClick={() => setRejecting(false)}
          >
            Cancel
          </button>
        </div>
      ) : confirming ? (
        <div className="approval-confirm">
          <span>Ready to approve this version?</span>
          <button type="button" className="btn approve" disabled={locked} onClick={approve}>
            {busy ? 'Approving…' : 'Approve & queue'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={locked}
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
            disabled={locked || !draft.trim()}
            onClick={() => setConfirming(true)}
          >
            {dirty ? 'Review edited draft' : 'Approve & queue'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={locked}
            onClick={() => setRejecting(true)}
          >
            Reject
          </button>
        </div>
      )}
    </section>
  );
}
