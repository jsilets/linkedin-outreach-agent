import { useEffect, useState } from 'react';
import { AccountsView } from './AccountsView';
import { api } from './api';
import { CampaignsView } from './CampaignsView';
import { ListsView } from './ListsView';
import { MetricsView } from './MetricsView';
import { ThemeSwitcher } from './ThemeSwitcher';

type Tab = 'campaigns' | 'metrics' | 'accounts' | 'lists';

export function App() {
  const [tab, setTab] = useState<Tab>('campaigns');
  // Count of drafts waiting on a human, surfaced as a badge on the Activity tab
  // so pending approvals are visible without opening the tab. Polled lightly
  // (every 60s) rather than pushed — this is an at-a-glance signal, not the
  // source of truth (MetricsView owns the live list).
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .pending()
        .then((p) => {
          if (alive) setPendingCount(p.length);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return (
    <div className="app">
      <header className="top">
        <h1>Outreach campaigns</h1>
        <nav>
          <button
            type="button"
            className={tab === 'campaigns' ? 'active' : ''}
            onClick={() => setTab('campaigns')}
          >
            Campaigns
          </button>
          <button
            type="button"
            className={tab === 'metrics' ? 'active' : ''}
            onClick={() => setTab('metrics')}
          >
            Activity
            {pendingCount > 0 && (
              <span className="nav-badge" aria-label={`${pendingCount} awaiting approval`}>
                {pendingCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={tab === 'lists' ? 'active' : ''}
            onClick={() => setTab('lists')}
          >
            Lists
          </button>
          <button
            type="button"
            className={tab === 'accounts' ? 'active' : ''}
            onClick={() => setTab('accounts')}
          >
            Accounts
          </button>
        </nav>
        <ThemeSwitcher />
      </header>
      {tab === 'campaigns' && <CampaignsView />}
      {tab === 'metrics' && <MetricsView />}
      {tab === 'lists' && <ListsView />}
      {tab === 'accounts' && <AccountsView />}
    </div>
  );
}
