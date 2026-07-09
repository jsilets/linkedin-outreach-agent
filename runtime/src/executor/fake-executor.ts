// FakeExecutor: deterministic, no browser. It satisfies both executor port
// shapes at once:
//   - mcp ExecutorPort.execute(ActRequest): Promise<Action>
//   - agent ExecutorPort.observe(acct, target) / act(acct, ExecIntent)
//
// Every act persists an Action row (result 'success', executedAt set now),
// records the connect into the weekly-invite counter so the safety ceiling sees
// it, records the action time into the pacer so the gate can space the next
// action apart, and appends an audit event. observe() returns canned profile/post context
// and drains any inbound messages queued for a target (smoke injects replies
// this way). This is what dev and smoke use to prove the wiring without a page.

import type { Account, Action, ActionType, Target } from '@loa/shared';
import type { ActRequest, ExecutorPort as McpExecutorPort } from '@loa/mcp';
import type {
  ExecIntent,
  ExecutorPort as AgentExecutorPort,
  Observation,
  ObservedMessage,
} from '@loa/agent';
import type { RuntimeStore } from '../store/index.js';
import type {
  StoreBackedActionPacer,
  StoreBackedWeeklyInviteCounter,
} from '../adapters/safety-state.js';

export interface FakeExecutorDeps {
  store: RuntimeStore;
  weekly: StoreBackedWeeklyInviteCounter;
  pacer: StoreBackedActionPacer;
  now?: () => Date;
}

export class FakeExecutor implements McpExecutorPort, AgentExecutorPort {
  private readonly store: RuntimeStore;
  private readonly weekly: StoreBackedWeeklyInviteCounter;
  private readonly pacer: StoreBackedActionPacer;
  private readonly now: () => Date;
  /** Inbound messages queued per target id, drained on the next observe(). */
  private readonly inboxByTarget = new Map<string, ObservedMessage[]>();

  constructor(deps: FakeExecutorDeps) {
    this.store = deps.store;
    this.weekly = deps.weekly;
    this.pacer = deps.pacer;
    this.now = deps.now ?? (() => new Date());
  }

  /** Queue a fake inbound reply for a target; observe() will surface it once. */
  feedInbound(msg: ObservedMessage): void {
    const list = this.inboxByTarget.get(msg.targetId) ?? [];
    list.push(msg);
    this.inboxByTarget.set(msg.targetId, list);
  }

  // --- mcp ExecutorPort ----------------------------------------------------

  async execute(req: ActRequest): Promise<Action> {
    return this.persistAction(req.type, req.accountId, req.targetId, req.campaignId);
  }

  // --- agent ExecutorPort --------------------------------------------------

  async observe(_acct: Account, target: Target): Promise<Observation> {
    const inbound = this.inboxByTarget.get(target.id) ?? [];
    this.inboxByTarget.set(target.id, []);
    return { target, inbound };
  }

  async act(_acct: Account, intent: ExecIntent): Promise<Action> {
    return this.persistAction(
      intent.type,
      intent.accountId,
      intent.targetId,
      intent.campaignId,
    );
  }

  // --- shared write path ---------------------------------------------------

  private async persistAction(
    type: ActionType,
    accountId: string,
    targetId: string,
    campaignId: string,
  ): Promise<Action> {
    const executedAt = this.now();
    const row = await this.store.action.create({
      accountId,
      targetId,
      campaignId,
      type,
      scheduledAt: executedAt,
      executedAt,
      result: 'success',
      dedupKey: `${accountId}:${targetId}:${type}:${executedAt.getTime()}`,
    });
    if (type === 'connect') {
      this.weekly.record(accountId, executedAt);
    }
    // Pace every action type, so the gate spaces the next action apart.
    this.pacer.record(accountId, executedAt);
    await this.store.event.append({
      accountId,
      kind: 'action_executed',
      payload: { actionId: row.id, type, targetId, campaignId, via: 'fake_executor' },
    });
    return {
      id: row.id,
      type: row.type,
      scheduledAt: row.scheduledAt,
      executedAt: row.executedAt,
      result: row.result,
      dedupKey: row.dedupKey,
      accountId: row.accountId,
      targetId: row.targetId,
      campaignId: row.campaignId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
