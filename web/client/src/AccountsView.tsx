import { useEffect, useState } from 'react';
import { ACTION_TYPES, api, type Account, type ActionType } from './api';

// Human-readable labels for the per-action daily caps.
const CAP_LABELS: Record<ActionType, string> = {
  connect: 'Connection requests',
  message: 'Messages',
  view_profile: 'Profile views',
  follow: 'Follows',
  withdraw_invite: 'Withdraw invites',
  react: 'Reactions',
};

export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [handle, setHandle] = useState('');
  const [liAt, setLiAt] = useState('');
  const [jsessionId, setJsessionId] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function loadAccounts() {
    api.accounts().then(setAccounts).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    loadAccounts();
  }, []);

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
            <button className="btn" onClick={connect} disabled={!canSubmit}>
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
              Open linkedin.com logged in &rarr; DevTools (F12) &rarr; Application tab &rarr; Cookies
              &rarr; https://www.linkedin.com &rarr; copy the Value of <code>li_at</code> and of{' '}
              <code>JSESSIONID</code>.
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

// One account's identity plus its editable daily automation limits. Each cap is
// a plain number field; Save persists the whole set through the SafetyGate.
function AccountCard({ account }: { account: Account }) {
  const [caps, setCaps] = useState<Record<ActionType, number>>(account.limits.caps);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = ACTION_TYPES.some((t) => caps[t] !== account.limits.caps[t]);

  function setCap(type: ActionType, value: string) {
    const n = value === '' ? 0 : Math.max(0, Math.floor(Number(value)));
    setCaps((prev) => ({ ...prev, [type]: Number.isFinite(n) ? n : 0 }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const limits = await api.updateAccountLimits(account.id, caps);
      setCaps(limits.caps);
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
      <div className="toolbar" style={{ marginTop: 10 }}>
        <button className="btn" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save limits'}
        </button>
        <span className="spacer" />
        {saved && <span className="saved">Saved</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
