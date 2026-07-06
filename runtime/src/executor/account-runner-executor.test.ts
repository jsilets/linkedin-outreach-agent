// Wiring test for AccountRunnerExecutor's real-execution path. It proves the
// executor resolves the live Page from its SessionProvider and drives the real
// runner action against THAT page — without a browser. A StubSessionProvider
// hands back a recording fake Page; the test asserts the executor navigated it
// to the target's profile URL (i.e. drive() ran against the injected page) and
// persisted an executed Action + audit event. The runner SafetyPort is the real
// gate-backed one, so the minted allow token really authorizes the action.

import { describe, expect, it, beforeEach } from 'vitest';
import type { ActionType, Target } from '@loa/shared';
import type { ActRequest } from '@loa/mcp';
import type { LocatorPort, PagePort } from '@loa/account-runner';
import { DefaultSafetyGate } from '@loa/safety';
import { InMemoryStore } from '../store/in-memory-store.js';
import { StoreBackedWeeklyInviteCounter } from '../adapters/safety-state.js';
import { makeRunnerSafetyPort } from '../adapters/safety.js';
import { AccountRunnerExecutor, type SessionProvider } from './account-runner-executor.js';

const ACCT = 'acct-1';
const CAMP = 'camp-1';
const TGT = 'tgt-1';
const PROFILE = 'https://www.linkedin.com/in/janedoe/';

/** No-op sleeper: the executor injects it so the human-paced gaps do not wait. */
const noSleep = async (): Promise<void> => {};

// A locator that reports a configurable element count. Every selector the real
// runner actions probe resolves to `count` elements; clicks/typing are no-ops.
// With count 1 the actions find their buttons and drive the page happy-path
// without a browser (the returned ActionResultOut is ignored by the executor).
function stubLocator(count: number): LocatorPort {
  const loc: LocatorPort = {
    async click() {},
    async type() {},
    async fill() {},
    async textContent() {
      return null;
    },
    async count() {
      return count;
    },
    first() {
      return loc;
    },
    nth() {
      return loc;
    },
    async hover() {},
    async waitFor() {},
  };
  return loc;
}

/** Records every goto; every locator resolves to `locatorCount` elements. */
class StubPage implements PagePort {
  readonly gotos: string[] = [];
  constructor(private readonly locatorCount = 1) {}
  async goto(url: string) {
    this.gotos.push(url);
    return null;
  }
  locator(): LocatorPort {
    return stubLocator(this.locatorCount);
  }
  async $$count() {
    return 0;
  }
  url() {
    return this.gotos[this.gotos.length - 1] ?? 'https://www.linkedin.com/feed/';
  }
  async waitForTimeout() {}
  async waitForResponse(): Promise<never> {
    throw new Error('not used');
  }
  async voyagerGet() {
    return { status: 200, body: {} };
  }
}

/** SessionProvider that hands back one recording fake Page, no browser. */
class StubSessionProvider implements SessionProvider {
  readonly page = new StubPage();
  readonly requested: string[] = [];
  async pageFor(accountId: string): Promise<PagePort> {
    this.requested.push(accountId);
    return this.page;
  }
  profileUrlFor(_target: Target): string {
    return PROFILE;
  }
}

async function seedAccount(store: InMemoryStore): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const caps = { connect: 10, message: 10, view_profile: 10, follow: 10, withdraw_invite: 10, react: 10 };
  const used = { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 };
  await store.account.create({
    id: ACCT,
    handle: 'op',
    state: 'Active',
    warmupDay: 28,
    proxyBinding: { proxyId: 'p', region: 'us-east', sticky: true },
    health: { acceptanceRate: 0.6, replyRate: 0.3, challengesLast7d: 0, lastCheckedAt: new Date() },
    budget: { date: today, caps, used },
  });
}

async function seedTarget(store: InMemoryStore): Promise<void> {
  await store.target.create({
    id: TGT,
    campaignId: CAMP,
    prospectRef: 'p1',
    linkedinUrn: 'urn:li:person:p1',
    externalContext: {},
    stage: 'sourced',
  });
}

function actRequest(type: ActionType, payload?: string): ActRequest {
  return { type, accountId: ACCT, targetId: TGT, campaignId: CAMP, ...(payload ? { payload } : {}) };
}

describe('AccountRunnerExecutor real path', () => {
  let store: InMemoryStore;
  let session: StubSessionProvider;
  let executor: AccountRunnerExecutor;

  beforeEach(async () => {
    store = new InMemoryStore();
    await seedAccount(store);
    await seedTarget(store);
    session = new StubSessionProvider();
    const gate = new DefaultSafetyGate({ weeklyInvites: new StoreBackedWeeklyInviteCounter() });
    executor = new AccountRunnerExecutor({
      store,
      runnerSafety: makeRunnerSafetyPort(gate),
      session,
      sleep: noSleep,
      rng: () => 0.5,
    });
  });

  it('resolves the live page for the account and drives it against the target profile', async () => {
    const action = await executor.execute(actRequest('view_profile'));

    // The executor asked the session for THIS account's page and the real
    // visitProfile action navigated that same page to the resolved profile URL.
    expect(session.requested).toEqual([ACCT]);
    expect(session.page.gotos).toContain(PROFILE);

    // The action row was persisted and returned as executed.
    expect(action.result).toBe('success');
    expect(action.executedAt).toBeInstanceOf(Date);
    const stored = await store.action.findById(action.id);
    expect(stored?.type).toBe('view_profile');

    // An audit event marks the account_runner path.
    const events = await store.event.listByAccount(ACCT);
    expect(events.some((e) => e.kind === 'action_executed')).toBe(true);
  });

  it('drives a connect (no note) against the injected page', async () => {
    await executor.execute(actRequest('connect'));
    // connect() navigates to the profile before probing for the Connect button.
    expect(session.page.gotos).toContain(PROFILE);
  });

  it('passes the message body through to the injected page', async () => {
    await executor.execute(actRequest('message', 'hello there'));
    expect(session.page.gotos).toContain(PROFILE);
  });

  it('refuses to act when the gate denies (no token minted, page untouched)', async () => {
    // A runner SafetyPort that always denies: mintToken throws, so the executor
    // never reaches the page. Proves the token gate sits in front of the
    // live-page injection.
    const denySession = new StubSessionProvider();
    const denyExecutor = new AccountRunnerExecutor({
      store,
      runnerSafety: {
        async authorize() {
          return { kind: 'deny', reason: 'blocked' };
        },
        async mintToken() {
          throw new Error('refusing to mint allow token: gate decision was deny');
        },
      },
      session: denySession,
    });

    await expect(denyExecutor.execute(actRequest('connect'))).rejects.toThrow(/allow token/);
    expect(denySession.requested).toEqual([]);
    expect(denySession.page.gotos).toEqual([]);
  });
});
