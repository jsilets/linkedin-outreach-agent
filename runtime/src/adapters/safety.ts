// Safety adapters: ONE DefaultSafetyGate, reconciled onto every consumer's port
// shape. The gate is the single source of truth for canAct/budget/onSignal; the
// adapters below only reshape arguments.
//
//   consumer                port method                backed by
//   ----------------------  -------------------------  -----------------------
//   @loa/scheduler          SafetyPort.canAct/budget   gate.canAct / gate.budget
//   @loa/mcp                SafetyPort.canAct(req)      gate.canAct(transientAction)
//   @loa/agent              LoopPorts.safety.canAct     gate.canAct
//   @loa/account-runner     SafetyPort.authorize/mint   gate.canAct + token mint
//
// The account-runner AllowToken is minted ONLY when the decision is allow, and
// is bound to the action id + accountId with a short expiry. The executor's
// gate refuses to touch a page without a token matching the exact action.

import { randomUUID } from 'node:crypto';
import type {
  Account,
  Action,
  ActionType,
  Campaign,
  DailyBudget,
  Decision,
} from '@loa/shared';
import { DefaultSafetyGate } from '@loa/safety';
import type { SafetyPort as SchedulerSafetyPort } from '@loa/scheduler';
import type { ActRequest, SafetyPort as McpSafetyPort } from '@loa/mcp';
import type { SafetyPort as AgentSafetyPort } from '@loa/agent';
import type {
  AllowToken,
  SafetyPort as RunnerSafetyPort,
} from '@loa/account-runner';
import type { RuntimeStore } from '../store/index.js';
import { rowToAccount, rowToCampaign } from '../mappers.js';

/** Default life of a minted allow token. Short by design: a token is consumed
 * immediately by the executor, so a minute is generous. */
const TOKEN_TTL_MS = 60_000;

/** Build a transient Action for a gate check from an ActRequest, before any row
 * exists. The dedup key mirrors the loop's actionShell so budget accounting is
 * consistent across entrypoints. */
export function actionFromRequest(req: ActRequest, now: Date = new Date()): Action {
  return {
    id: 'transient',
    type: req.type,
    scheduledAt: now,
    executedAt: null,
    result: 'pending',
    dedupKey: `${req.accountId}:${req.targetId}:${req.type}`,
    accountId: req.accountId,
    targetId: req.targetId,
    campaignId: req.campaignId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Mint an allow token bound to an action + account, valid for TOKEN_TTL_MS. */
export function mintAllowToken(
  action: Action,
  accountId: string,
  now: number = Date.now(),
  ttlMs: number = TOKEN_TTL_MS,
): AllowToken {
  return {
    kind: 'allow',
    actionId: action.id,
    accountId,
    expiresAt: now + ttlMs,
    nonce: randomUUID(),
  };
}

/** The scheduler's SafetyPort is a structural subset of DefaultSafetyGate, so
 * the gate satisfies it directly. Exposed as a helper for symmetry/readability. */
export function asSchedulerSafetyPort(gate: DefaultSafetyGate): SchedulerSafetyPort {
  return gate;
}

/** The agent loop's SafetyPort needs only canAct(acct, action). */
export function asAgentSafetyPort(gate: DefaultSafetyGate): AgentSafetyPort {
  return { canAct: (acct: Account, action: Action) => gate.canAct(acct, action) };
}

/** Adapt the gate + store to the mcp SafetyPort: load account/campaign rows and
 * evaluate canAct against a transient Action built from the ActRequest. */
export function makeMcpSafetyPort(
  gate: DefaultSafetyGate,
  store: RuntimeStore,
): McpSafetyPort {
  return {
    async getAccount(accountId: string): Promise<Account> {
      const row = await store.account.findById(accountId);
      if (!row) throw new Error(`account not found: ${accountId}`);
      return rowToAccount(row);
    },
    async getCampaign(campaignId: string): Promise<Campaign> {
      const row = await store.campaign.findById(campaignId);
      if (!row) throw new Error(`campaign not found: ${campaignId}`);
      return rowToCampaign(row);
    },
    async canAct(account: Account, req: ActRequest): Promise<Decision> {
      return gate.canAct(account, actionFromRequest(req));
    },
  };
}

/** Adapt the gate to the account-runner SafetyPort: authorize delegates to the
 * gate; mintToken issues a token ONLY when the decision is allow. */
export function makeRunnerSafetyPort(gate: DefaultSafetyGate): RunnerSafetyPort {
  return {
    async authorize(acct: Account, action: Action): Promise<Decision> {
      return gate.canAct(acct, action);
    },
    async mintToken(acct: Account, action: Action): Promise<AllowToken> {
      const decision = gate.canAct(acct, action);
      if (decision.kind !== 'allow') {
        throw new Error(
          `refusing to mint allow token: gate decision was ${decision.kind}`,
        );
      }
      return mintAllowToken(action, acct.id);
    },
  };
}

/** Convenience: the per-action-type budget for an account, via the gate. */
export function budgetFor(gate: DefaultSafetyGate, acct: Account): DailyBudget {
  return gate.budget(acct);
}

export type { ActionType };
