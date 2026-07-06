import { useEffect, useState } from 'react';
import { api, type Account } from './api';

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
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Handle</th>
              <th>State</th>
              <th>Warmup day</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.handle}</td>
                <td>{a.state}</td>
                <td>{a.warmupDay}</td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No accounts linked yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
