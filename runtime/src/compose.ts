// The composition root. compose(config) builds the ONE canonical set of
// implementations (safety gate, orchestrator, scheduler, store, executor, LLM)
// and reconciles them onto every consumer port via the adapters. It returns the
// handles a runnable entrypoint needs: the mcp Ports, the gate, the scheduler,
// the orchestrator services, and a runLoopOnce helper.
//
// Store selection: Postgres when DATABASE_URL is set, else in-memory.
// LLM selection: the internal LLM is OPTIONAL. In the primary mode an external
// agent drives the framework over MCP and supplies the intelligence, so no key
// is needed. For autonomous runs the fallback API path is selected by precedence:
//   OPENROUTER_API_KEY -> OpenRouterLLMProvider
//   else ANTHROPIC_API_KEY -> ClaudeLLMProvider
//   else -> deterministic FakeLLMProvider (offline).
// Executor: FakeExecutor for dev/smoke (no browser); AccountRunnerExecutor is
// available for P0 once a live session exists.

import { resolveProxyIdentity } from '@loa/account-runner';
import type { ExecutorPort as AgentExecutorPort } from '@loa/agent';
import {
  ClaudeLLMProvider,
  initialState,
  type LoopPorts,
  type LoopState,
  OpenRouterLLMProvider,
  runToStop,
} from '@loa/agent';
import type { ExecutorPort as McpExecutorPort, ObservePort, Ports } from '@loa/mcp';
import { DefaultSafetyGate, type SafetyConfig } from '@loa/safety';
import type { Account, AccountSchedule, Campaign, LLMProvider, Target } from '@loa/shared';
import { DEFAULT_SCHEDULE } from '@loa/shared';
import {
  AccountAdminAdapter,
  ApprovalAdapter,
  CampaignAdapter,
  FakeObserve,
  LeadListAdapter,
} from './adapters/mcp-ports.js';
import {
  InMemorySearchBudget,
  LiveConnectionsReader,
  LiveInboxReader,
  LiveObserve,
} from './adapters/observe-live.js';
import { makeOrchestratorServices, type OrchestratorServices } from './adapters/orchestrator.js';
import { PersistenceAdapter } from './adapters/persistence.js';
import { asAgentSafetyPort, makeMcpSafetyPort, makeRunnerSafetyPort } from './adapters/safety.js';
import {
  PauseRegistry,
  replaySignals,
  StoreBackedActionPacer,
  StoreBackedDailyUsage,
  StoreBackedWeeklyInviteCounter,
} from './adapters/safety-state.js';
import { SchedulerService } from './adapters/scheduler.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { DiscoveryAdapter } from './discovery/index.js';
import { AcceptanceTick } from './dispatch/acceptance-tick.js';
import { type DispatchTick, makeDispatchTick, type SendTimeReplyCheck } from './dispatch/index.js';
import { ReplyTick } from './dispatch/reply-tick.js';
import { AccountRunnerExecutor } from './executor/account-runner-executor.js';
import { FakeExecutor } from './executor/fake-executor.js';
import { LiveSessionProvider } from './executor/session-provider.js';
import { FakeLLMProvider } from './llm/fake-llm-provider.js';
import { rowToAccount, rowToCampaign, rowToTarget } from './mappers.js';
import {
  InMemoryStore,
  makeInMemoryStore,
  makePostgresStore,
  type RuntimeStore,
} from './store/index.js';

/** Everything compose() hands back. */
export interface Runtime {
  config: RuntimeConfig;
  store: RuntimeStore;
  gate: DefaultSafetyGate;
  weekly: StoreBackedWeeklyInviteCounter;
  scheduler: SchedulerService;
  orchestrator: OrchestratorServices;
  /** The fake executor instance; smoke feeds inbound through it. In real mode
   * the wired executor is the AccountRunnerExecutor, exposed via ports. */
  executor: FakeExecutor;
  /** Which executor drives actions: 'fake' | 'real'. */
  executorMode: 'fake' | 'real';
  llm: LLMProvider;
  /** Which LLM provider was selected: 'openrouter' | 'claude' | 'fake'. */
  llmProvider: LlmProviderName;
  ports: Ports;
  approvals: ApprovalAdapter;
  admin: AccountAdminAdapter;
  /** The campaign sequence engine. Built here but NOT started by compose; a
   * host starts it with dispatch.start(intervalMs). Routes every action step
   * through the same gate the MCP Act tools use. */
  dispatch: DispatchTick;
  /** The reply-detection tick. Only built with a real session (it reads live
   * inboxes); undefined in fake mode. A host starts it with
   * replyTick.start(intervalMs); compose never starts it. */
  replyTick?: ReplyTick;
  /** The acceptance-detection tick. Only built with a real session (it reads
   * the live connections list); undefined in fake mode. A host starts it with
   * acceptanceTick.start(intervalMs); compose never starts it. */
  acceptanceTick?: AcceptanceTick;
  /** Drive the agent loop once for one target; returns the terminal state. */
  runLoopOnce(accountId: string, targetId: string): Promise<LoopState>;
  /** Rehydrate safety state (weekly counter + soft-signal streak) from the
   * store. Call after seeding or on boot so ceilings survive a restart. */
  rehydrateSafety(): Promise<void>;
  /** Release resources (Postgres pool). */
  close(): Promise<void>;
}

function chooseStore(config: RuntimeConfig): RuntimeStore {
  if (config.databaseUrl) {
    return makePostgresStore(config.databaseUrl);
  }
  return makeInMemoryStore();
}

/** The provider label selected by chooseLlm, for startup logging. */
export type LlmProviderName = 'openrouter' | 'claude' | 'fake';

/**
 * Selection precedence, most explicit first:
 *   OPENROUTER_API_KEY -> OpenRouter, else ANTHROPIC_API_KEY -> Claude,
 *   else the offline Fake. Driven mode over MCP needs no key at all.
 */
export function selectLlmProvider(config: RuntimeConfig): LlmProviderName {
  if (config.openRouterApiKey) return 'openrouter';
  if (config.anthropicApiKey) return 'claude';
  return 'fake';
}

function chooseLlm(config: RuntimeConfig): { llm: LLMProvider; name: LlmProviderName } {
  const name = selectLlmProvider(config);
  if (name === 'openrouter') {
    return {
      llm: new OpenRouterLLMProvider({
        apiKey: config.openRouterApiKey,
        ...(config.openRouterModel ? { model: config.openRouterModel } : {}),
        ...(config.openRouterSiteUrl ? { siteUrl: config.openRouterSiteUrl } : {}),
        ...(config.openRouterAppTitle ? { appTitle: config.openRouterAppTitle } : {}),
      }),
      name,
    };
  }
  if (name === 'claude') {
    return {
      llm: new ClaudeLLMProvider(
        config.llmModel
          ? { apiKey: config.anthropicApiKey, model: config.llmModel }
          : { apiKey: config.anthropicApiKey },
      ),
      name,
    };
  }
  return { llm: new FakeLLMProvider(), name };
}

/** Test-injection seams for compose(). Empty in production. */
export interface ComposeDeps {
  /**
   * Override the gate's SafetyConfig. Tests pass a windowless config so the
   * active-hours gate does not defer when the suite runs before 8am / after 8pm.
   */
  safetyConfig?: SafetyConfig;
}

export function compose(config: RuntimeConfig = loadConfig(), deps: ComposeDeps = {}): Runtime {
  const store = chooseStore(config);

  // ONE safety gate, backed by a store-aware weekly-invite counter and an
  // action pacer that spaces every account's actions apart (anti-burst).
  const weekly = new StoreBackedWeeklyInviteCounter();
  const daily = new StoreBackedDailyUsage();
  const pacer = new StoreBackedActionPacer();
  const pause = new PauseRegistry();
  const gate = new DefaultSafetyGate({
    weeklyInvites: weekly,
    dailyUsage: daily,
    recentActions: pacer,
    pause,
    ...(deps.safetyConfig ? { config: deps.safetyConfig } : {}),
  });

  // Scheduler is the paced follow-up source; it reads the gate for pacing.
  const scheduler = new SchedulerService({ safety: gate });

  // ONE orchestrator over the store, with the scheduler's follow-up port.
  const orchestrator = makeOrchestratorServices(store, scheduler.asOrchestratorPort());

  // Executor + LLM. The fake executor is always built (smoke drives it via
  // feedInbound); the wired executor is the real account-runner when
  // LOA_EXECUTOR=real, else the fake.
  const fakeExecutor = new FakeExecutor({ store, weekly, daily, pacer });
  let sessionProvider: LiveSessionProvider | undefined;
  let executor: McpExecutorPort & AgentExecutorPort = fakeExecutor;
  if (config.executorMode === 'real') {
    sessionProvider = new LiveSessionProvider({
      profileDir: config.profileDir,
      vaultDir: config.vaultDir,
      allowNoProxy: config.allowNoProxy,
      // One sticky proxy for the P0 single account, resolved from PROXY_* env.
      // Returns undefined when no proxy is set (then allowNoProxy must be true).
      identityFor: () => resolveProxyIdentity(),
    });
    executor = new AccountRunnerExecutor({
      store,
      runnerSafety: makeRunnerSafetyPort(gate),
      session: sessionProvider,
      weekly,
      daily,
      pacer,
    });
  }
  const { llm, name: llmProvider } = chooseLlm(config);

  // mcp ports, all backed by the single orchestrator + gate + store + executor.
  const approvals = new ApprovalAdapter(orchestrator, executor, store);
  const admin = new AccountAdminAdapter(store, gate, orchestrator, pause);
  const campaign = new CampaignAdapter(orchestrator, store, gate);
  const safety = makeMcpSafetyPort(gate, store);
  // Observe: reads run open (no gating). With a real session the observe port is
  // LiveObserve for everything: searchPeople, listRecentConnections, getProfile,
  // and getConversation read live over the page's Voyager API, while
  // getRecentPosts / getPostEngagers / getCompanyJobs throw a loud
  // "not implemented" error — an MCP caller gets an explicit failure instead of
  // fabricated data. Without a real session there is no page to drive, so the
  // whole port stays on the canned FakeObserve (dev/smoke only).
  let observe: ObservePort = new FakeObserve();
  if (sessionProvider) {
    observe = new LiveObserve(
      { pageFor: (id) => sessionProvider!.pageFor(id) },
      new InMemorySearchBudget(),
    );
  }
  // --- sourcing-mcp-tools: lead lists over the store (read by the web UI) ----
  // A LeadListAdapter over store.leadList backs the create_list / list_lists /
  // get_list / source_to_list tools. It writes the same lead_lists /
  // lead_list_members tables the web UI's ListsView reads.
  const lists = new LeadListAdapter(store);
  // --- list scoring ---------------------------------------------------------
  // Backs score_leads (harness scores) and score_list (built-in heuristic). Both
  // are offline: they read stored member fields and write scores into
  // lead_list_members.external_context (visible in the UI, carried onto campaign
  // targets). No live search, so no flag — always wired.
  const discovery = new DiscoveryAdapter(store);
  const ports: Ports = {
    observe,
    executor,
    safety,
    approval: approvals,
    campaign,
    lists,
    admin,
    discovery,
  };

  // The campaign sequence engine reuses the SAME gate chokepoint the Act tools
  // route through (safety + approval + executor), so a tick-minted step obeys
  // autonomy, budgets, and the human gate exactly like an agent-driven send.
  // The account's working schedule, read fresh so a UI edit takes effect without
  // a restart. Shared by the dispatch and acceptance ticks to day-align due times.
  const scheduleFor = async (accountId: string): Promise<AccountSchedule> => {
    const row = await store.account.findById(accountId);
    return (row ? rowToAccount(row).limits?.schedule : undefined) ?? DEFAULT_SCHEDULE;
  };

  // The send-time reply probe is backed by the ReplyTick, which is built AFTER
  // dispatch (below). Late-bind it through a closure so a probe call at tick time
  // resolves the real ReplyTick; in fake mode no ReplyTick exists, so no probe is
  // wired and sends proceed without one.
  let replyTickRef: ReplyTick | undefined;
  const replyProbe: SendTimeReplyCheck = {
    check: (accountId, target, since) =>
      replyTickRef ? replyTickRef.probeTarget(accountId, target, since) : Promise.resolve(false),
  };

  const dispatch = makeDispatchTick({
    sequence: store.sequence,
    gate: { safety, approval: approvals, executor },
    // Park at 'invited' after a connect and gate message steps on the stage.
    targets: store.target,
    // Send human-approved drafts when the working-hours window opens.
    messages: store.message,
    // Cancel an approved send whose person said Stop (on any campaign).
    suppression: orchestrator.suppression,
    // Send-time reply probe: only when a real session can read a live inbox.
    ...(sessionProvider ? { replyProbe } : {}),
    // Audit cancellations + probe blocks.
    log: orchestrator.eventLog,
  });

  // --- reply-detection tick (additive) -------------------------------------
  // Only meaningful with a real session (it reads live inboxes over the page's
  // Voyager messaging endpoint). Reuses the SAME orchestrator ReplyRouter as
  // every other reply path, so a detected reply pulls the target from the funnel
  // exactly like an agent-routed one. Built here but never started by compose; a
  // host starts it with replyTick.start(replyPollIntervalMs).
  let replyTick: ReplyTick | undefined;
  if (sessionProvider) {
    const inbox = new LiveInboxReader({ pageFor: (id) => sessionProvider!.pageFor(id) });
    replyTick = new ReplyTick({
      inbox,
      // Every still-live enrollment (including cursors parked on a delay or an
      // approval), so a reply is caught even before a step is due to act.
      enrollments: { activeEnrollments: () => store.sequence.activeEnrollments() },
      targets: store.target,
      router: orchestrator.replyRouter,
      llm,
    });
    // Late-bind the dispatch send-time probe to this instance (see above).
    replyTickRef = replyTick;
  }
  // --- end reply-detection tick --------------------------------------------

  // --- acceptance-detection tick (additive) --------------------------------
  // Only meaningful with a real session (it reads the live connections list over
  // the page's Voyager relationships endpoint). Releases cursors parked in
  // 'awaiting_connection' by the dispatch tick once the invite is accepted, so a
  // message step only fires against a real 1st-degree connection. Built here but
  // never started by compose; a host starts it with
  // acceptanceTick.start(acceptancePollIntervalMs).
  let acceptanceTick: AcceptanceTick | undefined;
  if (sessionProvider) {
    const connections = new LiveConnectionsReader({
      pageFor: (id) => sessionProvider!.pageFor(id),
    });
    acceptanceTick = new AcceptanceTick({
      connections,
      sequence: store.sequence,
      targets: store.target,
      scheduleFor,
      // Record an invite_accepted audit event on each acceptance so the web
      // activity feed can surface "X accepted your invite" with a timestamp
      // (the feed is otherwise built only from outbound actions, which an
      // acceptance is not). Fire-and-forget: a logging failure must not stop
      // the tick from releasing the cursor.
      onOutcome: (o) => {
        if (o.kind !== 'connected' && o.kind !== 'completed') return;
        void orchestrator.eventLog
          .recordEvent('invite_accepted', o.accountId, {
            targetId: o.targetId,
            campaignId: o.campaignId,
            name: o.name,
          })
          .catch(() => {});
      },
    });
  }
  // --- end acceptance-detection tick ---------------------------------------

  // agent loop persistence writes through the same orchestrator; pending sends
  // persist their ActRequest on the message row, so no in-memory binding.
  const persistence = new PersistenceAdapter(orchestrator, store);

  const loopPorts: LoopPorts = {
    safety: asAgentSafetyPort(gate),
    executor,
    scheduler: scheduler.asAgentPort(),
    persistence,
    llm,
  };

  const runtime: Runtime = {
    config,
    store,
    gate,
    weekly,
    scheduler,
    orchestrator,
    executor: fakeExecutor,
    executorMode: config.executorMode,
    llm,
    llmProvider,
    ports,
    approvals,
    admin,
    dispatch,
    ...(replyTick ? { replyTick } : {}),
    ...(acceptanceTick ? { acceptanceTick } : {}),
    async runLoopOnce(accountId: string, targetId: string): Promise<LoopState> {
      const { account, campaign: camp, target } = await loadLoopContext(store, accountId, targetId);
      const state = initialState({ account, campaign: camp, target });
      return runToStop(state, loopPorts);
    },
    async rehydrateSafety(): Promise<void> {
      const accounts = await store.account.all();
      const ids = accounts.map((a) => a.id);
      await weekly.rehydrate(store, ids);
      await daily.rehydrate(store, ids);
      await pacer.rehydrate(store, ids);
      await pause.rehydrate(store, ids);
      await replaySignals(
        store,
        gate,
        async (id) => {
          const row = await store.account.findById(id);
          return row ? rowToAccount(row) : undefined;
        },
        ids,
      );
    },
    async close(): Promise<void> {
      dispatch.stop();
      replyTick?.stop();
      acceptanceTick?.stop();
      if (sessionProvider) await sessionProvider.close();
      await store.close();
    },
  };
  return runtime;
}

async function loadLoopContext(
  store: RuntimeStore,
  accountId: string,
  targetId: string,
): Promise<{ account: Account; campaign: Campaign; target: Target }> {
  const accountRow = await store.account.findById(accountId);
  if (!accountRow) throw new Error(`account not found: ${accountId}`);
  const targetRow = await store.target.findById(targetId);
  if (!targetRow) throw new Error(`target not found: ${targetId}`);
  const campaignRow = await store.campaign.findById(targetRow.campaignId);
  if (!campaignRow) throw new Error(`campaign not found: ${targetRow.campaignId}`);
  return {
    account: rowToAccount(accountRow),
    campaign: rowToCampaign(campaignRow),
    target: rowToTarget(targetRow),
  };
}

export type { RuntimeConfig };
export { InMemoryStore, loadConfig };
