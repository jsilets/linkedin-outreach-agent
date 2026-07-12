// The approval queue. In v1 every send and every drafted reply stops here as a
// pending item. A pending item is a draft message row (status 'draft'); the
// operator approves, edits-and-approves, or rejects it. Each decision writes an
// approval row and an event. Approval never mutates the event log directly; it
// goes through EventLog.recordEvent.

import type { ApprovalDecision, Draft, Intent, Message, MessageDirection } from '@loa/shared';
import type { EventLog } from './event-log.js';
import { rowToMessage } from './mappers.js';
import type { ApprovalRepoPort, MessageRepoPort } from './repo-ports.js';

export interface EnqueuePendingInput {
  accountId: string;
  targetId: string;
  campaignId: string;
  threadRef: string;
  draft: Draft;
  /** Intent, when this pending item is a reply to a classified inbound message. */
  intent?: Intent;
  /** The ActRequest to dispatch when this item is approved. Persisted on the
   * message row so the binding survives a runtime restart. Serialized as JSON. */
  pendingReq?: unknown;
}

export interface PendingItem {
  /** The draft message id; this is the pendingItemRef used by approvals. */
  pendingItemRef: string;
  message: Message;
  /** The persisted ActRequest to dispatch on approval, if one was bound. */
  pendingReq?: unknown;
}

export interface Decision {
  pendingItemRef: string;
  decision: ApprovalDecision;
  editor: string;
  message: Message;
}

export class ApprovalService {
  constructor(
    private readonly messages: MessageRepoPort,
    private readonly approvals: ApprovalRepoPort,
    private readonly log: EventLog,
  ) {}

  /**
   * Enqueue a pending outbound item as a draft message. The stored message id is
   * the pendingItemRef that approve/reject act on.
   */
  async enqueuePending(input: EnqueuePendingInput): Promise<PendingItem> {
    const direction: MessageDirection = 'outbound';
    const row = await this.messages.create({
      accountId: input.accountId,
      targetId: input.targetId,
      direction,
      body: input.draft.body,
      threadRef: input.threadRef,
      intent: input.intent ?? null,
      status: 'draft',
      pendingReq: input.pendingReq ?? null,
    });
    await this.log.recordEvent('pending_enqueued', input.accountId, {
      pendingItemRef: row.id,
      targetId: input.targetId,
      campaignId: input.campaignId,
      intent: input.intent ?? null,
    });
    return {
      pendingItemRef: row.id,
      message: rowToMessage(row),
      pendingReq: row.pendingReq ?? undefined,
    };
  }

  /** List draft (pending) messages in a thread. */
  async listPending(threadRef: string): Promise<PendingItem[]> {
    const rows = await this.messages.listByThread(threadRef);
    return rows
      .filter((r) => r.status === 'draft')
      .map((r) => ({
        pendingItemRef: r.id,
        message: rowToMessage(r),
        pendingReq: r.pendingReq ?? undefined,
      }));
  }

  /** Every pending (draft) item across all threads, sourced from the store. The
   * approval surface uses this to rebuild the pending queue after a restart,
   * when no in-memory binding survives. */
  async listAllPending(): Promise<PendingItem[]> {
    const rows = await this.messages.listDrafts();
    return rows.map((r) => ({
      pendingItemRef: r.id,
      message: rowToMessage(r),
      pendingReq: r.pendingReq ?? undefined,
    }));
  }

  /** The persisted ActRequest bound to a pending item, read by id regardless of
   * status so dispatch still works after approve() has flipped it to 'sent'. */
  async getPendingReq(pendingItemRef: string): Promise<unknown> {
    const row = await this.messages.findById(pendingItemRef);
    return row?.pendingReq ?? undefined;
  }

  /** Approve as-is: mark the draft sent, record an 'approved' decision + event. */
  async approve(pendingItemRef: string, editor: string): Promise<Decision> {
    return this.decide(pendingItemRef, editor, 'approved');
  }

  /** Edit the body, then approve. Records an 'edited' decision + event. */
  async editAndApprove(pendingItemRef: string, editor: string, newBody: string): Promise<Decision> {
    return this.decide(pendingItemRef, editor, 'edited', newBody);
  }

  /** Reject: leave the draft unsent, record a 'rejected' decision + event. */
  async reject(pendingItemRef: string, editor: string): Promise<Decision> {
    return this.decide(pendingItemRef, editor, 'rejected');
  }

  private async decide(
    pendingItemRef: string,
    editor: string,
    decision: ApprovalDecision,
    newBody?: string,
  ): Promise<Decision> {
    const existing = await this.messages.findById(pendingItemRef);
    if (!existing) {
      throw new Error(`pending item not found: ${pendingItemRef}`);
    }
    if (existing.status !== 'draft') {
      throw new Error(`pending item already decided: ${pendingItemRef}`);
    }

    // Persist the operator's decision as an immutable approval row.
    await this.approvals.create({ pendingItemRef, decision, editor });

    let message = rowToMessage(existing);
    if (decision === 'edited' && newBody !== undefined) {
      const edited = await this.messages.setBody(pendingItemRef, newBody);
      message = rowToMessage(edited);
    }
    if (decision === 'approved' || decision === 'edited') {
      // Approval marks the draft 'approved', NOT 'sent'. The dispatch tick sends
      // approved messages when the working-hours window is open and flips them to
      // 'sent' — so an approval given off-hours or on a day off goes out at the
      // next window with no second approval.
      const approved = await this.messages.setStatus(pendingItemRef, 'approved');
      message = rowToMessage(approved);
    }
    if (decision === 'rejected') {
      // Mark the draft 'rejected' (terminal): it leaves the pending queue
      // (listDrafts filters status='draft') and the status!=='draft' guard above
      // blocks a later approve of the same item.
      const rejected = await this.messages.setStatus(pendingItemRef, 'rejected');
      message = rowToMessage(rejected);
    }

    await this.log.recordEvent('approval_decided', existing.accountId, {
      pendingItemRef,
      decision,
      editor,
    });
    return { pendingItemRef, decision, editor, message };
  }
}
