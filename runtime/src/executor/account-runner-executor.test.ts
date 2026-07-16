// Wiring test for AccountRunnerExecutor's real-execution path. It proves the
// executor resolves the live Page from its SessionProvider and drives the real
// runner action against THAT page — without a browser. A StubSessionProvider
// hands back a recording fake Page; the test asserts the executor navigated it
// to the target's profile URL (i.e. drive() ran against the injected page) and
// persisted an executed Action + audit event. The runner SafetyPort is the real
// gate-backed one, so the minted allow token really authorizes the action.

import { type LocatorPort, type PagePort, SELECTORS } from '@loa/account-runner';
import type { ActRequest } from '@loa/mcp';
import { DefaultSafetyGate, NO_ACTIVE_HOURS_CONFIG } from '@loa/safety';
import type { Account, Action, ActionType, Decision, Target } from '@loa/shared';
import { SafetyDeferredError } from '@loa/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeRunnerSafetyPort } from '../adapters/safety.js';
import { StoreBackedWeeklyInviteCounter } from '../adapters/safety-state.js';
import { InMemoryStore } from '../store/in-memory-store.js';
import { AccountRunnerExecutor, isRendererStall } from './account-runner-executor.js';
import type { SessionProvider } from './session-provider.js';

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
function stubLocator(count: number, text: string | null = null): LocatorPort {
  const loc: LocatorPort = {
    async click() {},
    async type() {},
    async fill() {},
    async textContent() {
      return text;
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
    async focus() {},
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
  locator(selector: string): LocatorPort {
    // The message composer picks the typeahead card whose text matches the
    // recipient name, so hand back a matching card for that selector only.
    const text = selector === SELECTORS.composerResultCard ? 'Jane Doe • 1st EV' : null;
    return stubLocator(this.locatorCount, text);
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
  // Withdraw drives a same-origin POST; the executor's release path only depends
  // on it returning 2xx, so a canned 200 with an empty body is enough here.
  async voyagerPost() {
    return { status: 200, body: null };
  }
}

/** SessionProvider that hands back one recording fake Page, no browser. The
 * page's locator count is configurable so a test can force an action's happy
 * path (count 1) or a no-control path (count 0 -> the runner returns ok:false). */
class StubSessionProvider implements SessionProvider {
  readonly page: StubPage;
  readonly requested: string[] = [];
  readonly recycled: string[] = [];
  constructor(locatorCount = 1, page?: StubPage) {
    this.page = page ?? new StubPage(locatorCount);
  }
  async pageFor(accountId: string): Promise<PagePort> {
    this.requested.push(accountId);
    return this.page;
  }
  profileUrlFor(_target: Target): string {
    return PROFILE;
  }
  async recycle(accountId: string): Promise<void> {
    this.recycled.push(accountId);
  }
}

async function seedAccount(store: InMemoryStore): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const caps = {
    connect: 10,
    message: 10,
    view_profile: 10,
    follow: 10,
    withdraw_invite: 10,
    react: 10,
  };
  const used = { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 };
  await store.account.create({
    id: ACCT,
    handle: 'op',
    state: 'Active',
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
    externalContext: { name: 'Jane Doe' },
    stage: 'sourced',
  });
}

function actRequest(type: ActionType, payload?: string): ActRequest {
  return {
    type,
    accountId: ACCT,
    targetId: TGT,
    campaignId: CAMP,
    ...(payload ? { payload } : {}),
  };
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
    // Windowless config so the gate never defers on time of day: this suite
    // must pass whether it runs at noon or at 3am.
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      weeklyInvites: new StoreBackedWeeklyInviteCounter(),
      config: NO_ACTIVE_HOURS_CONFIG,
    });
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
    // The PERSISTED row carries the final outcome, not the initial 'pending'
    // placeholder: result is 'success' and executedAt is set. Without this the
    // row stays pending forever and getQueue reports the action as still queued.
    const stored = await store.action.findById(action.id);
    expect(stored?.type).toBe('view_profile');
    expect(stored?.result).toBe('success');
    expect(stored?.executedAt).toBeInstanceOf(Date);

    // An audit event marks the account_runner path.
    const events = await store.event.listByAccount(ACCT);
    expect(events.some((e) => e.kind === 'action_executed')).toBe(true);
  });

  it('drives a connect (no note) against the injected page', async () => {
    await executor.execute(actRequest('connect'));
    // connect() navigates to the profile before probing for the Connect button.
    expect(session.page.gotos).toContain(PROFILE);
  });

  it('drives a message through the composer against the injected page', async () => {
    await executor.execute(actRequest('message', 'hello there'));
    // Messages send through the dedicated composer, not the profile page.
    expect(session.page.gotos.some((u) => u.includes('messaging/thread/new'))).toBe(true);
  });

  it('persists result=failed on the row when the action returns ok:false', async () => {
    // A page whose locators resolve to 0 elements: connect finds no Connect
    // control inline or in the More menu, so the runner returns ok:false. The
    // executor must record that as a failure ON THE ROW, not leave it pending.
    const failSession = new StubSessionProvider(0);
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      weeklyInvites: new StoreBackedWeeklyInviteCounter(),
      config: NO_ACTIVE_HOURS_CONFIG,
    });
    const failExecutor = new AccountRunnerExecutor({
      store,
      runnerSafety: makeRunnerSafetyPort(gate),
      session: failSession,
      sleep: noSleep,
      rng: () => 0.5,
    });

    const action = await failExecutor.execute(actRequest('connect'));

    expect(action.result).toBe('failed');
    const stored = await store.action.findById(action.id);
    expect(stored?.result).toBe('failed');
    expect(stored?.executedAt).toBeInstanceOf(Date);
    const events = await store.event.listByAccount(ACCT);
    expect(events.some((e) => e.kind === 'action_failed')).toBe(true);
  });

  it('recycles the browser session when the drive throws a Playwright timeout', async () => {
    // A wedged renderer fails every pointer click with "Timeout Nms exceeded"
    // for the life of the browser (observed live 2026-07-16: three sends in a
    // row from one Chromium launched mid display-wake). The executor must drop
    // the cached session so the NEXT action gets a fresh browser, instead of
    // every action that day inheriting the same dead instance.
    class StallPage extends StubPage {
      override locator(selector: string): LocatorPort {
        const loc = super.locator(selector);
        return {
          ...loc,
          async click() {
            throw new Error('locator.click: Timeout 30000ms exceeded.');
          },
          first() {
            return this;
          },
          nth() {
            return this;
          },
        };
      }
    }
    const stallSession = new StubSessionProvider(1, new StallPage());
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      weeklyInvites: new StoreBackedWeeklyInviteCounter(),
      config: NO_ACTIVE_HOURS_CONFIG,
    });
    const stallExecutor = new AccountRunnerExecutor({
      store,
      runnerSafety: makeRunnerSafetyPort(gate),
      session: stallSession,
      sleep: noSleep,
      rng: () => 0.5,
    });

    // message() reaches its first pointer click at the typeahead card — the
    // same flow the live failures died in.
    await expect(stallExecutor.execute(actRequest('message', 'hello'))).rejects.toThrow(
      /Timeout 30000ms exceeded/,
    );

    expect(stallSession.recycled).toEqual([ACCT]);
    const events = await store.event.listByAccount(ACCT);
    const failed = events.find((e) => e.kind === 'action_failed');
    expect(failed?.payload).toMatchObject({ sessionRecycled: true });
  });

  it('does NOT recycle the session on a policy refusal (ok:false)', async () => {
    // A refusal ("no Connect control", "no typeahead card matched") is the page
    // behaving correctly; relaunching the browser for it would churn the session
    // for nothing.
    const refuseSession = new StubSessionProvider(0);
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      weeklyInvites: new StoreBackedWeeklyInviteCounter(),
      config: NO_ACTIVE_HOURS_CONFIG,
    });
    const refuseExecutor = new AccountRunnerExecutor({
      store,
      runnerSafety: makeRunnerSafetyPort(gate),
      session: refuseSession,
      sleep: noSleep,
      rng: () => 0.5,
    });

    const action = await refuseExecutor.execute(actRequest('connect'));

    expect(action.result).toBe('failed');
    expect(refuseSession.recycled).toEqual([]);
  });

  it('classifies only Playwright timeout phrasing as a renderer stall', () => {
    expect(isRendererStall('locator.click: Timeout 30000ms exceeded.\nCall log:')).toBe(true);
    expect(isRendererStall('page.goto: Timeout 30000ms exceeded.')).toBe(true);
    expect(isRendererStall('no 1st-degree typeahead card matched "Jane"; refusing')).toBe(false);
    expect(isRendererStall('needs recipient email; refusing to send')).toBe(false);
  });

  it('releases a parked awaiting_connection cursor when its invite is withdrawn', async () => {
    // Enroll the target and park it awaiting acceptance (where a sent connect
    // leaves it). Its /in/ vanity (janedoe) must appear in the sent-invitations
    // read so withdrawInvite resolves the urn and fires the withdraw POST.
    const prog = await store.sequence.enrollTarget(CAMP, TGT, ACCT);
    await store.sequence.advanceTargetProgress(prog.id, { state: 'awaiting_connection' });

    class InvitePage extends StubPage {
      override async voyagerGet() {
        return {
          status: 200,
          body: {
            elements: [
              {
                entityUrn: 'urn:li:invitation:999',
                sentTime: Date.parse('2026-06-01T00:00:00Z'),
                invitee: { miniProfile: { publicIdentifier: 'janedoe', firstName: 'Jane' } },
              },
            ],
          },
        };
      }
    }
    const inviteSession = new StubSessionProvider();
    (inviteSession as { page: StubPage }).page = new InvitePage();
    const gate = new DefaultSafetyGate({
      allowMissingCounters: true,
      weeklyInvites: new StoreBackedWeeklyInviteCounter(),
      config: NO_ACTIVE_HOURS_CONFIG,
    });
    const inviteExecutor = new AccountRunnerExecutor({
      store,
      runnerSafety: makeRunnerSafetyPort(gate),
      session: inviteSession,
      sleep: noSleep,
      rng: () => 0.5,
    });

    const action = await inviteExecutor.execute(actRequest('withdraw_invite'));

    expect(action.result).toBe('success');
    // The parked cursor is released to terminal so a ~3-week re-invite lockout
    // never re-enqueues it: stage 'lost', cursor 'skipped'.
    const movedTarget = await store.target.findById(TGT);
    expect(movedTarget?.stage).toBe('lost');
    const movedProg = await store.sequence.getTargetProgressByTarget(TGT);
    expect(movedProg?.state).toBe('skipped');
    // The audit event records that the withdrawal released a cursor.
    const events = await store.event.listByAccount(ACCT);
    const executed = events.find((e) => e.kind === 'action_executed');
    const payload = executed?.payload as { releasedCursor?: boolean } | undefined;
    expect(payload?.releasedCursor).toBe(true);
  });

  it('leaves no orphan pending row when the mint-time re-check defers, and rethrows', async () => {
    // mintToken throws a typed SafetyDeferredError (the #34 transient-defer
    // path). The executor creates the row before minting (the token binds to a
    // real action id), so on defer it must delete that row and rethrow — leaving
    // no orphan 'pending' behind while preserving the deferred/retry behavior.
    const until = new Date('2026-07-06T12:05:00Z');
    const deferSession = new StubSessionProvider();
    const deferExecutor = new AccountRunnerExecutor({
      store,
      runnerSafety: {
        async authorize() {
          return { kind: 'defer', until };
        },
        async mintToken() {
          throw new SafetyDeferredError({ kind: 'defer', until });
        },
      },
      session: deferSession,
      sleep: noSleep,
      rng: () => 0.5,
    });

    await expect(deferExecutor.execute(actRequest('connect'))).rejects.toBeInstanceOf(
      SafetyDeferredError,
    );
    // No page was driven and, crucially, no pending row survives the defer.
    expect(deferSession.page.gotos).toEqual([]);
    const rows = await store.action.listByAccount(ACCT);
    expect(rows).toEqual([]);
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

// The real gate-backed runner SafetyPort. Its mintToken re-checks the gate at
// token-mint time (defense in depth) and, on a non-allow, must raise a TYPED
// SafetyDeferredError carrying the decision — not a plain Error — so gateAct can
// map it back to a retryable deferred/denied outcome instead of a fatal failure.
describe('makeRunnerSafetyPort.mintToken', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  const acct: Account = {
    id: ACCT,
    handle: 'op',
    proxyBinding: { proxyId: 'p', region: 'us', sticky: true },
    state: 'Active',
    health: { acceptanceRate: 0.6, replyRate: 0.3, challengesLast7d: 0, lastCheckedAt: now },
    budget: {
      date: now.toISOString().slice(0, 10),
      caps: {
        connect: 10,
        message: 10,
        view_profile: 10,
        follow: 10,
        withdraw_invite: 10,
        react: 10,
      },
      used: { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 },
    },
    createdAt: now,
    updatedAt: now,
  };
  const action: Action = {
    id: 'action-1',
    type: 'connect',
    scheduledAt: now,
    executedAt: null,
    result: 'pending',
    dedupKey: `${ACCT}:${TGT}:connect`,
    accountId: ACCT,
    targetId: TGT,
    campaignId: CAMP,
    createdAt: now,
    updatedAt: now,
  };

  // makeRunnerSafetyPort only calls gate.canAct; a minimal stub stands in for the
  // full DefaultSafetyGate so we can force a defer/deny/allow deterministically.
  function gateReturning(decision: Decision) {
    return { canAct: () => decision } as unknown as DefaultSafetyGate;
  }

  it('throws a typed SafetyDeferredError when the re-check defers', async () => {
    const until = new Date('2026-07-06T12:05:00Z');
    const port = makeRunnerSafetyPort(gateReturning({ kind: 'defer', until }));
    await expect(port.mintToken(acct, action)).rejects.toBeInstanceOf(SafetyDeferredError);
    await port.mintToken(acct, action).catch((err) => {
      expect(err).toBeInstanceOf(SafetyDeferredError);
      expect((err as SafetyDeferredError).decision).toEqual({ kind: 'defer', until });
    });
  });

  it('throws a typed SafetyDeferredError when the re-check denies', async () => {
    const port = makeRunnerSafetyPort(gateReturning({ kind: 'deny', reason: 'paused' }));
    await expect(port.mintToken(acct, action)).rejects.toBeInstanceOf(SafetyDeferredError);
  });

  it('mints an allow token when the re-check allows', async () => {
    const port = makeRunnerSafetyPort(gateReturning({ kind: 'allow' }));
    const token = await port.mintToken(acct, action);
    expect(token.kind).toBe('allow');
    expect(token.actionId).toBe('action-1');
  });
});
