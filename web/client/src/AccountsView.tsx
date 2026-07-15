import { useCallback, useEffect, useState } from 'react';
import { type Account, type AccountSchedule, type ActionType, api, DEFAULT_SCHEDULE } from './api';

const OUTBOUND_ACTIONS = ['connect', 'message'] as const satisfies readonly ActionType[];

const ACTION_LABELS: Record<(typeof OUTBOUND_ACTIONS)[number], string> = {
  connect: 'Invites',
  message: 'Messages',
};

const ACTION_NOUNS: Record<(typeof OUTBOUND_ACTIONS)[number], string> = {
  connect: 'invites',
  message: 'messages',
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

function actionEnabled(account: Account, type: ActionType): boolean {
  return account.limits.enabled?.[type] ?? true;
}

// A limiter is "near" once it is within 10% of its ceiling, so an operator sees
// it coming rather than discovering it after sending stops.
const NEAR_LIMIT_FRACTION = 0.9;

function limitStatus(used: number, ceiling: number): 'at' | 'near' | 'ok' {
  if (ceiling <= 0 || used >= ceiling) return 'at';
  return used >= ceiling * NEAR_LIMIT_FRACTION ? 'near' : 'ok';
}

/**
 * One read-only limiter, shown as used/ceiling with a proportional bar.
 *
 * Not editable: unlike the daily cap these two live in the gate's own
 * SafetyConfig, not in the account's limits blob. They are here because the gate
 * enforces three limiters on invites and a card that showed only the daily cap
 * promised capacity the gate refused — which reads, from the outside, as sends
 * silently stopping for no reason. `note` says what the limiter does when hit.
 */
function LimitReadout({
  label,
  used,
  ceiling,
  hint,
  note,
}: {
  label: string;
  used: number;
  ceiling: number;
  hint: string;
  note: string;
}) {
  const status = limitStatus(used, ceiling);
  const pct = ceiling > 0 ? Math.min(100, (used / ceiling) * 100) : 100;
  return (
    <div className={`limit-readout ${status}`}>
      <div className="limit-readout-head">
        <span className="field-label">{label}</span>
        <span className="limit-readout-value">
          {used.toLocaleString()} / {ceiling.toLocaleString()}
        </span>
      </div>
      <div
        className="limit-readout-bar"
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={ceiling}
        aria-label={`${label}: ${used} of ${ceiling}`}
      >
        <span className="limit-readout-fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <p className="limit-readout-hint">{status === 'ok' ? hint : note}</p>
    </div>
  );
}

/**
 * The two invite limiters the account card cannot edit: the rolling weekly
 * ceiling and the outstanding-invite ceiling. Invites only — neither applies to
 * any other action type.
 */
function InviteLimiters({ account }: { account: Account }) {
  return (
    <div className="limit-readouts">
      <LimitReadout
        label="This week"
        used={account.weeklyInvitesUsed}
        ceiling={account.weeklyInviteCeiling}
        hint="Invites sent in the last 7 days."
        note="Weekly invite ceiling reached. Invites resume as the 7-day window rolls forward."
      />
      <LimitReadout
        label="Outstanding"
        used={account.outstandingInvites}
        ceiling={account.outstandingInviteCeiling}
        hint="Invites sent but not yet accepted."
        note="Too many invites are still pending. Invites stay blocked until stale ones are withdrawn — waiting will not clear this."
      />
    </div>
  );
}

function actionSchedule(account: Account, type: ActionType): AccountSchedule {
  return account.limits.schedules?.[type] ?? account.limits.schedule ?? DEFAULT_SCHEDULE;
}

function outboundSchedules(account: Account): Partial<Record<ActionType, AccountSchedule>> {
  return {
    connect: actionSchedule(account, 'connect'),
    message: actionSchedule(account, 'message'),
  };
}

function scheduleSummary(schedule: AccountSchedule): string {
  return `${DAY_LABELS.filter((_, day) => schedule.days.includes(day)).join(', ')} | ${hourLabel(
    schedule.hoursStart,
  )} to ${hourLabel(schedule.hoursEnd)}`;
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
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ScheduleEditor({
  schedule,
  label,
  onToggleDay,
  onSetHour,
}: {
  schedule: AccountSchedule;
  label: string;
  onToggleDay: (day: number) => void;
  onSetHour: (which: 'hoursStart' | 'hoursEnd', value: string) => void;
}) {
  const hoursValid = schedule.hoursEnd > schedule.hoursStart;
  return (
    <div className="schedule">
      <div className="schedule-days" role="group" aria-label={`${label} days`}>
        {DAY_LABELS.map((dayLabel, day) => {
          const on = schedule.days.includes(day);
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: DAY_LABELS is a static, fixed-order list; `day` is the stable day-of-week number.
              key={day}
              type="button"
              className={`day-toggle${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggleDay(day)}
            >
              {dayLabel}
            </button>
          );
        })}
      </div>
      <div className="schedule-hours">
        <span className="field-label">Window</span>
        <select
          className="hour-select"
          value={schedule.hoursStart}
          onChange={(e) => onSetHour('hoursStart', e.target.value)}
          aria-label={`${label} start hour`}
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
          onChange={(e) => onSetHour('hoursEnd', e.target.value)}
          aria-label={`${label} end hour`}
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
  );
}

// One account's identity plus its editable automation limits: per-action daily
// caps AND the working-hours/days window the SafetyGate enforces. One Save
// persists both together.
function AccountCard({ account }: { account: Account }) {
  const [savedLimits, setSavedLimits] = useState(account.limits);
  const savedAccount = { ...account, limits: savedLimits };
  const [caps, setCaps] = useState<Record<ActionType, number>>(savedLimits.caps);
  const [enabled, setEnabled] = useState<Partial<Record<ActionType, boolean>>>(
    savedLimits.enabled ?? {},
  );
  const [schedules, setSchedules] = useState<Partial<Record<ActionType, AccountSchedule>>>(
    outboundSchedules(savedAccount),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSavedLimits(account.limits);
    setCaps(account.limits.caps);
    setEnabled(account.limits.enabled ?? {});
    setSchedules(outboundSchedules(account));
  }, [account]);

  const dirty =
    OUTBOUND_ACTIONS.some((t) => caps[t] !== savedLimits.caps[t]) ||
    OUTBOUND_ACTIONS.some((t) => (enabled[t] ?? true) !== actionEnabled(savedAccount, t)) ||
    OUTBOUND_ACTIONS.some(
      (t) =>
        !sameSchedule(
          schedules[t] ?? actionSchedule(savedAccount, t),
          actionSchedule(savedAccount, t),
        ),
    );

  function setCap(type: ActionType, value: string) {
    const n = value === '' ? 0 : Math.max(0, Math.floor(Number(value)));
    setCaps((prev) => ({ ...prev, [type]: Number.isFinite(n) ? n : 0 }));
    setSaved(false);
  }

  function toggleScheduleDay(prev: AccountSchedule, day: number): AccountSchedule {
    const on = prev.days.includes(day);
    // Never let the last active day be removed — an empty set means "never
    // send", which the server rejects anyway.
    if (on && prev.days.length === 1) return prev;
    const days = on ? prev.days.filter((d) => d !== day) : [...prev.days, day];
    days.sort((a, b) => a - b);
    return { ...prev, days };
  }

  function setScheduleHour(
    prev: AccountSchedule,
    which: 'hoursStart' | 'hoursEnd',
    n: number,
  ): AccountSchedule {
    // Keep the range valid: nudging the start past the end drags the end with
    // it, so an invalid window can never be selected.
    if (which === 'hoursStart') {
      return { ...prev, hoursStart: n, hoursEnd: Math.max(prev.hoursEnd, n + 1) };
    }
    return { ...prev, hoursEnd: n };
  }

  function toggleEnabled(type: ActionType) {
    setEnabled((prev) => ({ ...prev, [type]: !(prev[type] ?? true) }));
    setSaved(false);
  }

  function toggleActionDay(type: ActionType, day: number) {
    setSchedules((prev) => ({
      ...prev,
      [type]: toggleScheduleDay(prev[type] ?? actionSchedule(savedAccount, type), day),
    }));
    setSaved(false);
  }

  function setActionHour(type: ActionType, which: 'hoursStart' | 'hoursEnd', value: string) {
    const n = Math.max(0, Math.min(24, Math.floor(Number(value) || 0)));
    setSchedules((prev) => ({
      ...prev,
      [type]: setScheduleHour(prev[type] ?? actionSchedule(savedAccount, type), which, n),
    }));
    setSaved(false);
  }

  const hoursValid = OUTBOUND_ACTIONS.every((t) => {
    const s = schedules[t] ?? actionSchedule(savedAccount, t);
    return s.hoursEnd > s.hoursStart;
  });

  const activeCount = OUTBOUND_ACTIONS.filter((t) => enabled[t] ?? true).length;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const outbound = {
        connect: schedules.connect ?? actionSchedule(savedAccount, 'connect'),
        message: schedules.message ?? actionSchedule(savedAccount, 'message'),
      };
      const limits = await api.updateAccountLimits(account.id, caps, undefined, enabled, outbound);
      setSavedLimits(limits);
      setCaps(limits.caps);
      setEnabled(limits.enabled ?? {});
      setSchedules(outboundSchedules({ ...account, limits }));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="subrow">
      <div className="account-row-header">
        <div>
          <strong>{account.handle}</strong>
          <span className="account-state">{account.state}</span>
        </div>
        <span className="account-summary">
          {activeCount} of {OUTBOUND_ACTIONS.length} gates active
        </span>
      </div>

      <div className="outbound-controls">
        {OUTBOUND_ACTIONS.map((type) => {
          const on = enabled[type] ?? true;
          const label = ACTION_LABELS[type];
          const actionSched = schedules[type] ?? actionSchedule(savedAccount, type);
          return (
            <section key={type} className="outbound-control" aria-label={`${label} settings`}>
              <div className="outbound-control-head">
                <div>
                  <h3>{label}</h3>
                  <p>{on ? scheduleSummary(actionSched) : 'Paused at the gate'}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  className={`switch compact${on ? ' on' : ''}`}
                  onClick={() => toggleEnabled(type)}
                >
                  <span className="switch-track" aria-hidden="true">
                    <span className="switch-thumb" />
                  </span>
                  <span className="switch-state">{on ? 'Active' : 'Off'}</span>
                </button>
              </div>

              <div className="outbound-control-body">
                <label className="limit-field">
                  <span className="field-label">Daily cap</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={caps[type]}
                    onChange={(e) => setCap(type, e.target.value)}
                    aria-label={`${label} daily cap`}
                  />
                  <span className="limit-field-unit">{ACTION_NOUNS[type]} / day</span>
                </label>

                {/* The daily cap above is one of THREE limiters the gate applies
                    to connects. The other two are not editable and not derived
                    from anything on this card, so they are shown here rather
                    than left to be inferred from sends that stop. */}
                {type === 'connect' && <InviteLimiters account={account} />}

                <ScheduleEditor
                  schedule={actionSched}
                  label={label}
                  onToggleDay={(day) => toggleActionDay(type, day)}
                  onSetHour={(which, value) => setActionHour(type, which, value)}
                />
              </div>
            </section>
          );
        })}
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
