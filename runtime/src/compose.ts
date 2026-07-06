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
import { DefaultSafetyGate } from '@loa/safety';
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
} from './adapters/mcp-ports.js';
import { LiveObserve, InMemorySearchBudget } from './adapters/observe-live.js';
import { makeDispatchTick, type DispatchTick } from './dispatch/index.js';
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

export function compose(config: RuntimeConfig = loadConfig()): Runtime {
  const store = chooseStore(config);

  // ONE safety gate, backed by a store-aware weekly-invite counter.
  const weekly = new StoreBackedWeeklyInviteCounter();
  const gate = new DefaultSafetyGate({ weeklyInvites: weekly });

  // Scheduler is the paced follow-up source; it reads the gate for pacing.
  const scheduler = new SchedulerService({ safety: gate });

  // ONE orchestrator over the store, with the scheduler's follow-up port.
  const orchestrator = makeOrchestratorServices(store, scheduler.asOrchestratorPort());

  // Executor + LLM. The fake executor is always built (smoke drives it via
  // feedInbound); the wired executor is the real account-runner when
  // LOA_EXECUTOR=real, else the fake.
  const fakeExecutor = new FakeExecutor({ store, weekly });
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
    });
  }
  const { llm, name: llmProvider } = chooseLlm(config);

  // mcp ports, all backed by the single orchestrator + gate + store + executor.
  const approvals = new ApprovalAdapter(orchestrator, executor, store);
  const admin = new AccountAdminAdapter(store, gate, orchestrator);
  const campaign = new CampaignAdapter(orchestrator, store);
  const safety = makeMcpSafetyPort(gate, store);
  // Observe: reads run open (no gating). With a real session, people-search
  // goes live (drives the page + intercepts voyagerSearchDashClusters); the
  // other reads stay on the canned FakeObserve until they get live backends.
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
  const ports: Ports = { observe, executor, safety, approval: approvals, campaign, admin };

  // The campaign sequence engine reuses the SAME gate chokepoint the Act tools
  // route through (safety + approval + executor), so a tick-minted step obeys
  // autonomy, budgets, and the human gate exactly like an agent-driven send.
  const dispatch = makeDispatchTick({
    sequence: store.sequence,
    gate: { safety, approval: approvals, executor },
  });

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
