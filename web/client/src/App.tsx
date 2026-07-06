import { useState } from 'react';
import { CampaignsView } from './CampaignsView';
import { MetricsView } from './MetricsView';

type Tab = 'campaigns' | 'metrics';

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
        </nav>
      </header>
      {tab === 'campaigns' ? <CampaignsView /> : <MetricsView />}
    </div>
  );
}
