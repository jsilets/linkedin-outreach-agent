import { useCallback, useEffect, useId, useState } from 'react';
import {
  ACTION_TYPES,
  type Account,
  type AccountSchedule,
  type ActionType,
  api,
  DEFAULT_SCHEDULE,
} from './api';
import { runWriteAction, type WriteOutcome, type WritePhase } from './writeAction';

// Human-readable labels for the per-action daily caps.
const CAP_LABELS: Record<ActionType, string> = {
  connect: 'Connection requests',
  message: 'Messages',
  view_profile: 'Profile views',
  follow: 'Follows',
  withdraw_invite: 'Withdraw invites',
  react: 'Reactions',
};

// Weekday initials, index 0=Sunday … 6=Saturday (JS Date.getDay order).
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 24h clock as a readable label ("8:00 AM", "8:00 PM", "midnight").
function hourLabel(h: number): string {
  if (h === 0 || h === 24) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

// The operator's local timezone (e.g. "America/Los_Angeles"), shown next to the
// hour pickers so it's clear the window is in local — not UTC — time. This is
// the same clock the runtime schedules against.
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

// Selectable start hours (00:00–23:00) and end hours (01:00–24:00/midnight).
const START_HOURS = Array.from({ length: 24 }, (_, h) => h);
const END_HOURS = Array.from({ length: 24 }, (_, h) => h + 1);

function sameSchedule(a: AccountSchedule, b: AccountSchedule): boolean {
  return (
    a.hoursStart === b.hoursStart &&
    a.hoursEnd === b.hoursEnd &&
    a.days.length === b.days.length &&
    a.days.every((d) => b.days.includes(d))
  );
}

// Sentence naming what a pause is actually holding back. An active account stays
// quiet: there is nothing for the operator to act on.
export function pauseStatusCopy(paused: boolean, queuedMessageCount: number): string {
  if (!paused) return 'Sending is active.';
  if (queuedMessageCount === 0) return 'Sending is paused. Nothing is approved and waiting.';
  const queued =
    queuedMessageCount === 1
      ? '1 approved message is waiting'
      : `${queuedMessageCount} approved messages are waiting`;
  return `Sending is paused. ${queued} and will not go out.`;
}

// The confirm shown before resume, and only before resume: it releases real
// messages to real people and cannot be undone, so it names the real count.
// Pacing quoted from the gate's own defaults (minActionGapMs 4m + up to 6m
// jitter, see control-plane/safety/src/config.ts) — it is meaningless for a
// single message, so only a plural queue gets the rate.
export function resumeConfirmCopy(queuedMessageCount: number): string {
  if (queuedMessageCount === 0) {
    return 'Resume sending? Nothing is approved right now, but anything approved from here on will go out.';
  }
  if (queuedMessageCount === 1) {
    return 'Resume sending? 1 approved message will begin going out.';
  }
  return `Resume sending? ${queuedMessageCount} approved messages will begin going out, roughly one every 4-10 minutes.`;
}

export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [handle, setHandle] = useState('');
  const [liAt, setLiAt] = useState('');
  const [jsessionId, setJsessionId] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Raw reload: rejects so a caller can tell a failed re-read from a failed write.
  const reloadAccounts = useCallback(() => api.accounts().then(setAccounts), []);

  // Reload that reports its own failure, for callers with nothing to distinguish.
  const loadAccounts = useCallback(() => {
    reloadAccounts().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reloadAccounts]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  async function connect() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.linkAccount({ handle, liAt, jsessionId });
      setSuccess(`Linked ${res.handle}`);
      setLiAt('');
      setJsessionId('');
      loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connect failed.');
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = handle.trim() && liAt.trim() && jsessionId.trim() && !saving;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <strong>Connect a LinkedIn account</strong>
        <div className="grid" style={{ marginTop: 12 }}>
          <div>
            <label>Account name</label>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. acme-sales"
            />
          </div>
          <div>
            <label>
              <code>li_at</code> cookie value
            </label>
            <textarea
              value={liAt}
              onChange={(e) => setLiAt(e.target.value)}
              placeholder="Paste the li_at cookie value"
            />
          </div>
          <div>
            <label>
              <code>JSESSIONID</code> cookie value
            </label>
            <input
              value={jsessionId}
              onChange={(e) => setJsessionId(e.target.value)}
              placeholder="Paste the JSESSIONID cookie value"
            />
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <button type="button" className="btn" onClick={connect} disabled={!canSubmit}>
              {saving ? 'Connecting...' : 'Connect account'}
            </button>
            <span className="spacer" />
            {success && <span className="saved">{success}</span>}
          </div>
          {error && <div className="error">{error}</div>}
        </div>

        <div style={{ marginTop: 16 }}>
          <span className="back" onClick={() => setShowHelp((v) => !v)}>
            {showHelp ? '▾' : '▸'} How to get these cookies
          </span>
          {showHelp && (
            <p className="muted" style={{ marginTop: 8 }}>
              Open linkedin.com logged in &rarr; DevTools (F12) &rarr; Application tab &rarr;
              Cookies &rarr; https://www.linkedin.com &rarr; copy the Value of <code>li_at</code>{' '}
              and of <code>JSESSIONID</code>.
            </p>
          )}
        </div>

        <p className="muted" style={{ marginTop: 12 }}>
          These are live credentials. They are stored encrypted server-side and used to act as you.
          Only paste your own.
        </p>
      </div>

      <div className="card">
        <strong>Linked accounts</strong>
        {accounts.length === 0 && (
          <p className="muted" style={{ marginTop: 10 }}>
            No accounts linked yet.
          </p>
        )}
        <div className="grid" style={{ gap: 0, marginTop: 'var(--space-2)' }}>
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} reload={reloadAccounts} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The operator pause: the hardest stop in the system. Paused, the SafetyGate
 * denies every outbound action, so nothing approved can leave.
 *
 * Pausing is instant — it is the safe direction, and a confirm between an
 * operator and "stop sending" is a confirm in the wrong place. Resuming is not
 * undoable: it hands the queue to the sender and those messages reach real
 * people, so it confirms first and names the count.
 */
function PauseControl({ account, reload }: { account: Account; reload: () => Promise<unknown> }) {
  const [phase, setPhase] = useState<WritePhase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const labelId = useId();
  const paused = account.paused;
  // 'stale' means the runtime accepted the write but the re-read failed, so what
  // the switch shows is no longer known to be true: lock rather than invite a
  // second click that would be a second real write.
  const busy = phase === 'working' || phase === 'stale';

  async function run(act: () => Promise<unknown>, failure: string) {
    setPhase('working');
    setNotice(null);
    const outcome: WriteOutcome = await runWriteAction(act, reload, {
      failure,
      stale:
        'Done, but this page could not refresh. Do not retry — reload to see the current state.',
    });
    setPhase(outcome.phase);
    setNotice(outcome.phase === 'done' ? null : outcome.notice);
  }

  function toggle() {
    if (!paused) {
      run(() => api.pauseAccount(account.id), 'Could not pause sending.');
      return;
    }
    setConfirming(true);
  }

  function resume() {
    setConfirming(false);
    run(() => api.resumeAccount(account.id), 'Could not resume sending.');
  }

  return (
    <div className="pause-control">
      <div className="pause-switch">
        <span className="pause-switch-name" id={labelId}>
          Sending
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={!paused}
          aria-labelledby={labelId}
          className={`switch${paused ? '' : ' on'}`}
          disabled={busy}
          onClick={toggle}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-state">{paused ? 'Paused' : 'Active'}</span>
        </button>
      </div>

      <p className={paused ? 'pause-note held' : 'pause-note'}>
        {pauseStatusCopy(paused, account.queuedMessageCount)}
      </p>

      {confirming && (
        <div className="pause-confirm" role="group" aria-label="Confirm resume">
          <p>{resumeConfirmCopy(account.queuedMessageCount)}</p>
          <div className="toolbar" style={{ margin: 0 }}>
            <button type="button" className="btn" onClick={resume} disabled={busy}>
              Resume sending
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && <div className="error">{notice}</div>}
    </div>
  );
}

// One account's identity plus its editable automation limits: per-action daily
// caps AND the working-hours/days window the SafetyGate enforces. One Save
// persists both together.
function AccountCard({ account, reload }: { account: Account; reload: () => Promise<unknown> }) {
  const [caps, setCaps] = useState<Record<ActionType, number>>(account.limits.caps);
  const [schedule, setSchedule] = useState<AccountSchedule>(
    account.limits.schedule ?? DEFAULT_SCHEDULE,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedSchedule = account.limits.schedule ?? DEFAULT_SCHEDULE;
  const dirty =
    ACTION_TYPES.some((t) => caps[t] !== account.limits.caps[t]) ||
    !sameSchedule(schedule, savedSchedule);

  function setCap(type: ActionType, value: string) {
    const n = value === '' ? 0 : Math.max(0, Math.floor(Number(value)));
    setCaps((prev) => ({ ...prev, [type]: Number.isFinite(n) ? n : 0 }));
    setSaved(false);
  }

  function toggleDay(day: number) {
    setSchedule((prev) => {
      const on = prev.days.includes(day);
      // Never let the last active day be removed — an empty set means "never
      // send", which the server rejects anyway.
      if (on && prev.days.length === 1) return prev;
      const days = on ? prev.days.filter((d) => d !== day) : [...prev.days, day];
      days.sort((a, b) => a - b);
      return { ...prev, days };
    });
    setSaved(false);
  }

  function setHour(which: 'hoursStart' | 'hoursEnd', value: string) {
    const n = Math.max(0, Math.min(24, Math.floor(Number(value) || 0)));
    setSchedule((prev) => {
      // Keep the range valid: nudging the start past the end drags the end with
      // it, so an invalid window can never be selected.
      if (which === 'hoursStart') {
        return { ...prev, hoursStart: n, hoursEnd: Math.max(prev.hoursEnd, n + 1) };
      }
      return { ...prev, hoursEnd: n };
    });
    setSaved(false);
  }

  const hoursValid = schedule.hoursEnd > schedule.hoursStart;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const limits = await api.updateAccountLimits(account.id, caps, schedule);
      setCaps(limits.caps);
      if (limits.schedule) setSchedule(limits.schedule);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="subrow">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <strong>{account.handle}</strong>
        <span className="muted">{account.state}</span>
      </div>

      <PauseControl account={account} reload={reload} />

      <div style={{ marginTop: 6 }}>
        <label className="muted">Daily limits (max actions per day, 0 disables)</label>
      </div>
      <div
        style={{
          marginTop: 8,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        {ACTION_TYPES.map((t) => (
          <div key={t}>
            <label>{CAP_LABELS[t]}</label>
            <input
              type="number"
              min={0}
              step={1}
              value={caps[t]}
              onChange={(e) => setCap(t, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <label className="muted">Working schedule (the account only acts inside this window)</label>
      </div>
      <div className="schedule">
        <div className="schedule-days" role="group" aria-label="Working days">
          {DAY_LABELS.map((label, day) => {
            const on = schedule.days.includes(day);
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: DAY_LABELS is a static, fixed-order list; `day` is the stable day-of-week number.
                key={day}
                type="button"
                className={`day-toggle${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleDay(day)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="schedule-hours">
          <span className="muted">Active hours</span>
          <select
            className="hour-select"
            value={schedule.hoursStart}
            onChange={(e) => setHour('hoursStart', e.target.value)}
            aria-label="Start hour"
          >
            {START_HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
          <span className="schedule-dash">to</span>
          <select
            className="hour-select"
            value={schedule.hoursEnd}
            onChange={(e) => setHour('hoursEnd', e.target.value)}
            aria-label="End hour"
          >
            {END_HOURS.filter((h) => h > schedule.hoursStart).map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
          <span className="muted schedule-tz">{LOCAL_TZ}</span>
        </div>
        {!hoursValid && <div className="error">End hour must be after start hour.</div>}
      </div>

      <div className="toolbar" style={{ marginTop: 'var(--space-3)' }}>
        <button
          type="button"
          className="btn"
          onClick={save}
          disabled={!dirty || !hoursValid || saving}
        >
          {saving ? 'Saving...' : 'Save limits'}
        </button>
        <span className="spacer" />
        {saved && <span className="saved">Saved</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
