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
  Campaign,
  Decision,
} from '@loa/shared';
import { SafetyDeferredError } from '@loa/shared';
import { DefaultSafetyGate } from '@loa/safety';
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
function actionFromRequest(req: ActRequest, now: Date = new Date()): Action {
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
function mintAllowToken(
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
        // The double-check is deliberate defense-in-depth: the executor must
        // never touch the page without a valid allow token. But a non-allow
        // here is typically the anti-burst pacer flipping allow->defer in the
        // gap since the gate's first check — a transient "retry later", not a
        // failure. Raise a TYPED deferral (not a plain Error) so gateAct maps it
        // to a deferred/denied outcome and the caller retries, instead of the
        // throw bubbling up and permanently failing the target cursor.
        throw new SafetyDeferredError(decision);
      }
      return mintAllowToken(action, acct.id);
    },
  };
}
