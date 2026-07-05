// The composition root. compose(config) builds the ONE canonical set of
// implementations (safety gate, orchestrator, scheduler, store, executor, LLM)
// and reconciles them onto every consumer port via the adapters. It returns the
// handles a runnable entrypoint needs: the mcp Ports, the gate, the scheduler,
// the orchestrator services, and a runLoopOnce helper.
//
// Store selection: Postgres when DATABASE_URL is set, else in-memory.
// LLM selection: ClaudeLLMProvider when ANTHROPIC_API_KEY is set, else the
// deterministic FakeLLMProvider. Executor: FakeExecutor for dev/smoke (no
// browser); AccountRunnerExecutor is available for P0 once a live session exists.

import type { Account, Campaign, LLMProvider, Target } from '@loa/shared';
import { DefaultSafetyGate } from '@loa/safety';
import { ClaudeLLMProvider } from '@loa/agent';
import {
  initialState,
  runToStop,
  type LoopPorts,
  type LoopState,
} from '@loa/agent';
import type { Ports } from '@loa/mcp';
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
import { PersistenceAdapter } from './adapters/persistence.js';
import { FakeExecutor } from './executor/fake-executor.js';
import { FakeLLMProvider } from './llm/fake-llm-provider.js';

/** Everything compose() hands back. */
export interface Runtime {
  config: RuntimeConfig;
  store: RuntimeStore;
  gate: DefaultSafetyGate;
  weekly: StoreBackedWeeklyInviteCounter;
  scheduler: SchedulerService;
  orchestrator: OrchestratorServices;
  executor: FakeExecutor;
  llm: LLMProvider;
  ports: Ports;
  approvals: ApprovalAdapter;
  admin: AccountAdminAdapter;
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

function chooseLlm(config: RuntimeConfig): LLMProvider {
  if (config.anthropicApiKey) {
    return new ClaudeLLMProvider(
      config.llmModel
        ? { apiKey: config.anthropicApiKey, model: config.llmModel }
        : { apiKey: config.anthropicApiKey },
    );
  }
  return new FakeLLMProvider();
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

  // Executor + LLM.
  const executor = new FakeExecutor({ store, weekly });
  const llm = chooseLlm(config);

  // mcp ports, all backed by the single orchestrator + gate + store + executor.
  const approvals = new ApprovalAdapter(orchestrator, executor);
  const admin = new AccountAdminAdapter(store, gate, orchestrator);
  const campaign = new CampaignAdapter(orchestrator, store);
  const safety = makeMcpSafetyPort(gate, store);
  const observe = new FakeObserve();
  const ports: Ports = { observe, executor, safety, approval: approvals, campaign, admin };

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
    executor,
    llm,
    ports,
    approvals,
    admin,
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
