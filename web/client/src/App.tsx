import { useState } from 'react';
import { AccountsView } from './AccountsView';
import { CampaignsView } from './CampaignsView';
import { ListsView } from './ListsView';
import { MetricsView } from './MetricsView';

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
            Volume
          </button>
          <button className={tab === 'lists' ? 'active' : ''} onClick={() => setTab('lists')}>
            Lists
          </button>
          <button className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>
            Accounts
          </button>
        </nav>
      </header>
      {tab === 'campaigns' && <CampaignsView />}
      {tab === 'metrics' && <MetricsView />}
      {tab === 'lists' && <ListsView />}
      {tab === 'accounts' && <AccountsView />}
    </div>
  );
}
