import { useState } from 'react';
import { AccountsView } from './AccountsView';
import { CampaignsView } from './CampaignsView';
import { ListsView } from './ListsView';
import { MetricsView } from './MetricsView';
import { ThemeSwitcher } from './ThemeSwitcher';

type Tab = 'campaigns' | 'metrics' | 'accounts' | 'lists';

export function App() {
  const [tab, setTab] = useState<Tab>('campaigns');
  return (
    <div className="app">
      <header className="top">
        <h1>Outreach campaigns</h1>
        <nav>
          <button
            className={tab === 'campaigns' ? 'active' : ''}
            onClick={() => setTab('campaigns')}
          >
            Campaigns
          </button>
          <button className={tab === 'metrics' ? 'active' : ''} onClick={() => setTab('metrics')}>
            Activity
          </button>
          <button className={tab === 'lists' ? 'active' : ''} onClick={() => setTab('lists')}>
            Lists
          </button>
          <button className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>
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
