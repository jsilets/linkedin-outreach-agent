// In-memory repository fakes satisfying the repo ports. No Postgres. Row shapes
// mirror the Drizzle inferred types closely enough for the services under test.

import type { db as shared } from '@loa/shared';
import type { SchedulerLikePort } from '../src/reply-router.js';
import type {
  ApprovalRepoPort,
  CampaignRepoPort,
  EventRepoPort,
  MessageRepoPort,
  TargetRepoPort,
} from '../src/repo-ports.js';

type CampaignRow = shared.CampaignRow;
type NewCampaignRow = shared.NewCampaignRow;
type TargetRow = shared.TargetRow;
type NewTargetRow = shared.NewTargetRow;
type MessageRow = shared.MessageRow;
type NewMessageRow = shared.NewMessageRow;
type ApprovalRow = shared.ApprovalRow;
type NewApprovalRow = shared.NewApprovalRow;
type EventRow = shared.EventRow;
type NewEventRow = shared.NewEventRow;

let counter = 0;
const id = (prefix: string): string => `${prefix}-${++counter}`;
const now = (): Date => new Date('2026-07-05T12:00:00Z');

export class InMemCampaignRepo implements CampaignRepoPort {
  public rows = new Map<string, CampaignRow>();
  async create(row: NewCampaignRow): Promise<CampaignRow> {
    const full: CampaignRow = {
      id: row.id ?? id('camp'),
      goal: row.goal,
      autonomyLevel: row.autonomyLevel ?? 'supervised',
      messageStrategy: row.messageStrategy,
      owner: row.owner,
      createdAt: now(),
      updatedAt: now(),
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(cid: string): Promise<CampaignRow | undefined> {
    return this.rows.get(cid);
  }
  async setAutonomy(cid: string, level: CampaignRow['autonomyLevel']): Promise<CampaignRow> {
    const cur = this.rows.get(cid);
    if (!cur) throw new Error('no campaign');
    const next = { ...cur, autonomyLevel: level, updatedAt: now() };
    this.rows.set(cid, next);
    return next;
  }
}

export class InMemTargetRepo implements TargetRepoPort {
  public rows = new Map<string, TargetRow>();
  async create(row: NewTargetRow): Promise<TargetRow> {
    const full: TargetRow = {
      id: row.id ?? id('tgt'),
      campaignId: row.campaignId,
      prospectRef: row.prospectRef,
      linkedinUrn: row.linkedinUrn,
      externalContext: row.externalContext ?? {},
      stage: row.stage ?? 'sourced',
      createdAt: now(),
      updatedAt: now(),
    };
    this.rows.set(full.id, full);
    return full;
  }
  async createMany(rows: NewTargetRow[]): Promise<TargetRow[]> {
    const out: TargetRow[] = [];
    for (const r of rows) out.push(await this.create(r));
    return out;
  }
  async findById(tid: string): Promise<TargetRow | undefined> {
    return this.rows.get(tid);
  }
  async listByCampaign(campaignId: string): Promise<TargetRow[]> {
    return [...this.rows.values()].filter((r) => r.campaignId === campaignId);
  }
  async listByUrn(linkedinUrn: string): Promise<TargetRow[]> {
    return [...this.rows.values()].filter((r) => r.linkedinUrn === linkedinUrn);
  }
  async setExternalContext(tid: string, blob: NewTargetRow['externalContext']): Promise<TargetRow> {
    const cur = this.rows.get(tid);
    if (!cur) throw new Error('no target');
    const next = { ...cur, externalContext: blob ?? {}, updatedAt: now() };
    this.rows.set(tid, next);
    return next;
  }
  async mergeExternalContext(tid: string, patch: Record<string, unknown>): Promise<TargetRow> {
    const cur = this.rows.get(tid);
    if (!cur) throw new Error('no target');
    const base = (cur.externalContext ?? {}) as Record<string, unknown>;
    const next = { ...cur, externalContext: { ...base, ...patch }, updatedAt: now() };
    this.rows.set(tid, next);
    return next;
  }
  async setStage(tid: string, stage: TargetRow['stage']): Promise<TargetRow> {
    const cur = this.rows.get(tid);
    if (!cur) throw new Error('no target');
    const next = { ...cur, stage, updatedAt: now() };
    this.rows.set(tid, next);
    return next;
  }
}

export class InMemMessageRepo implements MessageRepoPort {
  public rows = new Map<string, MessageRow>();
  async create(row: NewMessageRow): Promise<MessageRow> {
    const full: MessageRow = {
      id: row.id ?? id('msg'),
      accountId: row.accountId,
      targetId: row.targetId,
      direction: row.direction,
      body: row.body,
      threadRef: row.threadRef,
      intent: row.intent ?? null,
      status: row.status ?? 'draft',
      createdAt: now(),
      updatedAt: now(),
      sentAt: null,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(mid: string): Promise<MessageRow | undefined> {
    return this.rows.get(mid);
  }
  async setStatus(mid: string, status: MessageRow['status']): Promise<MessageRow> {
    const cur = this.rows.get(mid);
    if (!cur) throw new Error('no message');
    const next = {
      ...cur,
      status,
      updatedAt: now(),
      ...(status === 'sent' ? { sentAt: now() } : {}),
    };
    this.rows.set(mid, next);
    return next;
  }
  async setBody(mid: string, body: string): Promise<MessageRow> {
    const cur = this.rows.get(mid);
    if (!cur) throw new Error('no message');
    const next = { ...cur, body, updatedAt: now() };
    this.rows.set(mid, next);
    return next;
  }
  async listByThread(threadRef: string): Promise<MessageRow[]> {
    return [...this.rows.values()].filter((r) => r.threadRef === threadRef);
  }
}

export class InMemApprovalRepo implements ApprovalRepoPort {
  public rows: ApprovalRow[] = [];
  async create(row: NewApprovalRow): Promise<ApprovalRow> {
    const full: ApprovalRow = {
      id: row.id ?? id('appr'),
      pendingItemRef: row.pendingItemRef,
      decision: row.decision,
      editor: row.editor,
      timestamp: now(),
    };
    this.rows.push(full);
    return full;
  }
}

/**
 * Append-only in-memory event store. Deliberately exposes only append + reads —
 * mirrors the real EventRepo's contract so a test can prove no update/delete
 * path exists.
 */
export class InMemEventRepo implements EventRepoPort {
  public rows: EventRow[] = [];
  async append(row: NewEventRow): Promise<EventRow> {
    const full: EventRow = {
      id: row.id ?? id('evt'),
      ts: now(),
      accountId: row.accountId ?? null,
      kind: row.kind,
      payload: row.payload ?? {},
    };
    this.rows.push(full);
    return full;
  }
  async listSuppression(): Promise<EventRow[]> {
    return this.rows.filter((r) => r.accountId === null && r.kind === 'target_suppressed');
  }
}

export class InMemScheduler implements SchedulerLikePort {
  public enqueued: {
    targetId: string;
    campaignId: string;
    notBefore: Date;
    reason: string;
  }[] = [];
  async enqueueFollowUp(input: {
    targetId: string;
    campaignId: string;
    notBefore: Date;
    reason: string;
  }): Promise<void> {
    this.enqueued.push(input);
  }
}
