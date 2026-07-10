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

import type { Account, Campaign, LLMProvider, Target } from '@loa/shared';
import { DefaultSafetyGate, type SafetyConfig } from '@loa/safety';
import { ClaudeLLMProvider, OpenRouterLLMProvider } from '@loa/agent';
import {
  initialState,
  runToStop,
  type LoopPorts,
  type LoopState,
} from '@loa/agent';
import type { Ports, ObservePort } from '@loa/mcp';
import { rowToAccount, rowToCampaign, rowToTarget } from './mappers.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import {
  InMemoryStore,
  makeInMemoryStore,
  makePostgresStore,
  type RuntimeStore,
} from './store/index.js';
import {
  StoreBackedActionPacer,
  StoreBackedWeeklyInviteCounter,
  replaySignals,
} from './adapters/safety-state.js';
import {
  asAgentSafetyPort,
  makeMcpSafetyPort,
  makeRunnerSafetyPort,
} from './adapters/safety.js';
import { makeOrchestratorServices, type OrchestratorServices } from './adapters/orchestrator.js';
import { SchedulerService } from './adapters/scheduler.js';
import {
  AccountAdminAdapter,
  ApprovalAdapter,
  CampaignAdapter,
  FakeObserve,
  LeadListAdapter,
} from './adapters/mcp-ports.js';
import {
  LiveObserve,
  LiveInboxReader,
  LiveConnectionsReader,
  InMemorySearchBudget,
} from './adapters/observe-live.js';
import { makeDispatchTick, type DispatchTick } from './dispatch/index.js';
import { ReplyTick } from './dispatch/reply-tick.js';
import { AcceptanceTick } from './dispatch/acceptance-tick.js';
import { PersistenceAdapter } from './adapters/persistence.js';
import { FakeExecutor } from './executor/fake-executor.js';
import { resolveProxyIdentity } from '@loa/account-runner';
import { AccountRunnerExecutor } from './executor/account-runner-executor.js';
import { LiveSessionProvider } from './executor/session-provider.js';
import { FakeLLMProvider } from './llm/fake-llm-provider.js';
import type { ExecutorPort as McpExecutorPort } from '@loa/mcp';
import type { ExecutorPort as AgentExecutorPort } from '@loa/agent';

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
  const pacer = new StoreBackedActionPacer();
  const gate = new DefaultSafetyGate({
    weeklyInvites: weekly,
    recentActions: pacer,
    ...(deps.safetyConfig ? { config: deps.safetyConfig } : {}),
  });

  // Scheduler is the paced follow-up source; it reads the gate for pacing.
  const scheduler = new SchedulerService({ safety: gate });

  // ONE orchestrator over the store, with the scheduler's follow-up port.
  const orchestrator = makeOrchestratorServices(store, scheduler.asOrchestratorPort());

  // Executor + LLM. The fake executor is always built (smoke drives it via
  // feedInbound); the wired executor is the real account-runner when
  // LOA_EXECUTOR=real, else the fake.
  const fakeExecutor = new FakeExecutor({ store, weekly, pacer });
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
      pacer,
    });
  }
  const { llm, name: llmProvider } = chooseLlm(config);

  // mcp ports, all backed by the single orchestrator + gate + store + executor.
  const approvals = new ApprovalAdapter(orchestrator, executor, store);
  const admin = new AccountAdminAdapter(store, gate, orchestrator);
  const campaign = new CampaignAdapter(orchestrator, store, gate);
  const safety = makeMcpSafetyPort(gate, store);
  // Observe: reads run open (no gating). With a real session, people-search
  // goes live (a direct authenticated /voyager/api/graphql call from the page);
  // the other reads stay on the canned FakeObserve until they get live backends.
  // Without a real session there is no page to drive, so everything is fake.
  const fakeObserve = new FakeObserve();
  let observe: ObservePort = fakeObserve;
  if (sessionProvider) {
    const live = new LiveObserve(
      { pageFor: (id) => sessionProvider!.pageFor(id) },
      new InMemorySearchBudget(),
    );
    observe = {
      ...fakeObserve,
      getProfile: fakeObserve.getProfile.bind(fakeObserve),
      getRecentPosts: fakeObserve.getRecentPosts.bind(fakeObserve),
      getPostEngagers: fakeObserve.getPostEngagers.bind(fakeObserve),
      getCompanyJobs: fakeObserve.getCompanyJobs.bind(fakeObserve),
      getConversation: fakeObserve.getConversation.bind(fakeObserve),
      searchPeople: (id, q, limit) => live.searchPeople(id, q, limit),
    };
  }
  // --- sourcing-mcp-tools: lead lists over the store (read by the web UI) ----
  // A LeadListAdapter over store.leadList backs the create_list / list_lists /
  // get_list / source_to_list tools. It writes the same lead_lists /
  // lead_list_members tables the web UI's ListsView reads.
  const lists = new LeadListAdapter(store);
  const ports: Ports = { observe, executor, safety, approval: approvals, campaign, lists, admin };

  // The campaign sequence engine reuses the SAME gate chokepoint the Act tools
  // route through (safety + approval + executor), so a tick-minted step obeys
  // autonomy, budgets, and the human gate exactly like an agent-driven send.
  const dispatch = makeDispatchTick({
    sequence: store.sequence,
    gate: { safety, approval: approvals, executor },
    // Park at 'invited' after a connect and gate message steps on the stage.
    targets: store.target,
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
    // Enumerate active enrollments across campaigns. No cross-campaign list
    // method exists on the store, so read in_progress cursors via the due query
    // with a far-future clock (it returns every in_progress row regardless of
    // nextStepAt) — a reply can land while a step is still on its delay.
    const FAR_FUTURE = new Date(8640000000000000);
    replyTick = new ReplyTick({
      inbox,
      enrollments: { activeEnrollments: () => store.sequence.dueTargetProgress(FAR_FUTURE) },
      targets: store.target,
      router: orchestrator.replyRouter,
      llm,
    });
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
    });
  }
  // --- end acceptance-detection tick ---------------------------------------

  // agent loop persistence writes through the same orchestrator + approvals.
  const persistence = new PersistenceAdapter(orchestrator, approvals, store);

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
      const { account, campaign: camp, target } = await loadLoopContext(
        store,
        accountId,
        targetId,
      );
      const state = initialState({ account, campaign: camp, target });
      return runToStop(state, loopPorts);
    },
    async rehydrateSafety(): Promise<void> {
      const accounts = await store.account.all();
      const ids = accounts.map((a) => a.id);
      await weekly.rehydrate(store, ids);
      await pacer.rehydrate(store, ids);
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

export { InMemoryStore };
export { loadConfig };
export type { RuntimeConfig };
