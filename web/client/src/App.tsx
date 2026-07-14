import { useCallback, useEffect, useState } from 'react';
import { AccountsView } from './AccountsView';
import { api } from './api';
import { CampaignsView } from './CampaignsView';
import { InboxView } from './InboxView';
import { ListsView } from './ListsView';
import { MetricsView } from './MetricsView';
import { usePref } from './prefs';
import { ThemeSwitcher } from './ThemeSwitcher';

type Tab = 'activity' | 'inbox' | 'campaigns' | 'lists' | 'settings';

const TABS: Tab[] = ['activity', 'inbox', 'campaigns', 'lists', 'settings'];

function isTab(v: unknown): v is Tab {
  return typeof v === 'string' && (TABS as string[]).includes(v);
}

export function App() {
  const [storedTab, setTab] = usePref<Tab>('tab', 'activity');
  const tab = isTab(storedTab) ? storedTab : 'activity';
  // Count of drafts waiting on a human, surfaced as a badge on the Inbox tab so
  // pending approvals are visible without opening the tab. Polled lightly (every
  // 60s) rather than pushed — this is an at-a-glance signal, not the source of
  // truth (the Inbox owns the live list).
  const [pendingCount, setPendingCount] = useState(0);
  // When a "pending approval" row in the Scheduled feed is clicked, jump to the
  // Inbox with that lead's draft focused. The target id is handed to InboxView,
  // which selects the matching draft; it clears itself once consumed.
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null);
  const openApproval = useCallback(
    (targetId: string) => {
      setApprovalFocus(targetId);
      setTab('inbox');
    },
    [setTab],
  );
  const clearApprovalFocus = useCallback(() => setApprovalFocus(null), []);
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
    <>
      <header className="top">
        <div className="top-inner">
          <span className="brand">
            <LinkedInLogo />
            LinkedIn Automation
          </span>
          <nav>
            <button
              type="button"
              className={tab === 'activity' ? 'active' : ''}
              aria-pressed={tab === 'activity'}
              onClick={() => setTab('activity')}
            >
              Activity
            </button>
            <button
              type="button"
              className={tab === 'inbox' ? 'active' : ''}
              aria-pressed={tab === 'inbox'}
              onClick={() => setTab('inbox')}
            >
              Inbox
              {pendingCount > 0 && (
                <span className="nav-badge" aria-label={`${pendingCount} awaiting approval`}>
                  {pendingCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className={tab === 'campaigns' ? 'active' : ''}
              aria-pressed={tab === 'campaigns'}
              onClick={() => setTab('campaigns')}
            >
              Campaigns
            </button>
            <button
              type="button"
              className={tab === 'lists' ? 'active' : ''}
              aria-pressed={tab === 'lists'}
              onClick={() => setTab('lists')}
            >
              Lists
            </button>
          </nav>
          {/* Settings is configuration, not a workspace: it lives with the other
              meta controls on the right, as a gear, not a tab. */}
          <button
            type="button"
            className={`icon-btn${tab === 'settings' ? ' active' : ''}`}
            aria-pressed={tab === 'settings'}
            aria-label="Settings"
            title="Settings"
            onClick={() => setTab('settings')}
          >
            <GearIcon />
          </button>
          <ThemeSwitcher />
        </div>
      </header>
      <main className="app">
        {tab === 'activity' && <MetricsView onOpenApproval={openApproval} />}
        {tab === 'inbox' && (
          <InboxView focusTargetId={approvalFocus} onFocusHandled={clearApprovalFocus} />
        )}
        {tab === 'campaigns' && <CampaignsView />}
        {tab === 'lists' && <ListsView />}
        {tab === 'settings' && <AccountsView />}
      </main>
    </>
  );
}

// The LinkedIn "in" mark in its brand blue — the one deliberately non-token
// color in the UI, since a logo doesn't retheme.
function LinkedInLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path
        fill="#ffffff"
        d="M6.94 8.5a1.44 1.44 0 1 0 0-2.88 1.44 1.44 0 0 0 0 2.88zM5.7 9.62h2.48v8.38H5.7V9.62zm4.06 0h2.38v1.14h.03c.33-.63 1.14-1.3 2.35-1.3 2.51 0 2.98 1.65 2.98 3.8V18h-2.48v-4.14c0-.99-.02-2.26-1.38-2.26-1.38 0-1.59 1.08-1.59 2.19V18H9.76V9.62z"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z" />
    </svg>
  );
}
