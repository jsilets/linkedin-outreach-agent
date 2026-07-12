// agent PersistencePort adapter: the slice of the orchestrator the control loop
// writes through. Every send and every drafted reply becomes a pending approval
// item (the human gate); the loop never auto-sends. All event writes funnel
// through EventLog.recordEvent. Inbound messages are persisted as message rows.
//
// When the loop enqueues a pending send/reply we also bind an ActRequest to the
// resulting ref in the ApprovalAdapter, so that if an operator approves it the
// underlying action dispatches through the executor exactly like an mcp-queued
// item.

import type { ObservedMessage, PersistencePort } from '@loa/agent';
import type { ActRequest } from '@loa/mcp';
import { rowToMessage } from '@loa/orchestrator';
import type { Draft, Intent, Message } from '@loa/shared';
import type { RuntimeStore } from '../store/index.js';
import type { OrchestratorServices } from './orchestrator.js';

export class PersistenceAdapter implements PersistencePort {
  constructor(
    private readonly services: OrchestratorServices,
    private readonly store: RuntimeStore,
  ) {}

  async enqueuePendingSend(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    draft: Draft;
  }): Promise<{ pendingItemRef: string }> {
    const threadRef = `pending:${input.accountId}:${input.targetId}`;
    // Persist the ActRequest on the pending item so approval can dispatch a real
    // message send even after a restart (no in-memory binding to lose).
    const req: ActRequest = {
      type: 'message',
      accountId: input.accountId,
      targetId: input.targetId,
      campaignId: input.campaignId,
      payload: input.draft.body,
    };
    const item = await this.services.approvals.enqueuePending({
      accountId: input.accountId,
      targetId: input.targetId,
      campaignId: input.campaignId,
      threadRef,
      draft: input.draft,
      pendingReq: req,
    });
    return { pendingItemRef: item.pendingItemRef };
  }

  async enqueuePendingReply(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    threadRef: string;
    intent: Intent;
    draft: Draft;
  }): Promise<{ pendingItemRef: string }> {
    const req: ActRequest = {
      type: 'message',
      accountId: input.accountId,
      targetId: input.targetId,
      campaignId: input.campaignId,
      payload: input.draft.body,
    };
    const item = await this.services.approvals.enqueuePending({
      accountId: input.accountId,
      targetId: input.targetId,
      campaignId: input.campaignId,
      threadRef: input.threadRef,
      intent: input.intent,
      draft: input.draft,
      pendingReq: req,
    });
    return { pendingItemRef: item.pendingItemRef };
  }

  async recordInboundMessage(msg: ObservedMessage): Promise<Message> {
    const row = await this.store.message.create({
      accountId: msg.accountId,
      targetId: msg.targetId,
      direction: 'inbound',
      body: msg.body,
      threadRef: msg.threadRef,
      intent: null,
      status: 'sent',
    });
    await this.services.eventLog.recordEvent('inbound_recorded', msg.accountId, {
      targetId: msg.targetId,
      threadRef: msg.threadRef,
      messageId: row.id,
    });
    return rowToMessage(row);
  }

  async recordEvent(kind: string, accountId: string, payload: unknown): Promise<void> {
    await this.services.eventLog.recordEvent(kind, accountId, payload as never);
  }

  async isSuppressed(targetId: string): Promise<boolean> {
    return this.services.suppression.isSuppressed(targetId);
  }
}
