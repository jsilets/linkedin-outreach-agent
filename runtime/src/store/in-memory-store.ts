// InMemoryStore: a Postgres-free implementation of the runtime store, promoted
// from the orchestrator's test fakes into a first-class store. Dev and smoke use
// this; a live deployment swaps in the Postgres store.
//
// The orchestrator's own fakes cover campaign/target/message/approval/event but
// not accounts or actions, which the runtime needs (the safety weekly counter
// reads action rows; the executor writes them). This store adds both. The
// account/action/event-read surfaces are async to match the RuntimeStore shape.

import { db as shared } from '@loa/shared';
import type {
  ApprovalRepoPort,
  CampaignRepoPort,
  EventRepoPort,
  MessageRepoPort,
  TargetRepoPort,
} from '@loa/orchestrator';
import type {
  AccountStorePort,
  ActionStorePort,
  EventReadPort,
  RuntimeStore,
} from './index.js';

type AccountRow = shared.AccountRow;
type NewAccountRow = shared.NewAccountRow;
type CampaignRow = shared.CampaignRow;
type NewCampaignRow = shared.NewCampaignRow;
type TargetRow = shared.TargetRow;
type NewTargetRow = shared.NewTargetRow;
type ActionRow = shared.ActionRow;
type NewActionRow = shared.NewActionRow;
type MessageRow = shared.MessageRow;
type NewMessageRow = shared.NewMessageRow;
type ApprovalRow = shared.ApprovalRow;
type NewApprovalRow = shared.NewApprovalRow;
type EventRow = shared.EventRow;
type NewEventRow = shared.NewEventRow;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

class InMemAccountStore implements AccountStorePort {
  readonly rows = new Map<string, AccountRow>();
  async create(row: NewAccountRow): Promise<AccountRow> {
    const now = new Date();
    const full: AccountRow = {
      id: row.id ?? nextId('acct'),
      handle: row.handle,
      proxyBinding: row.proxyBinding,
      state: row.state ?? 'Cold',
      health: row.health,
      budget: row.budget,
      warmupDay: row.warmupDay ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<AccountRow | undefined> {
    return this.rows.get(id);
  }
  async all(): Promise<AccountRow[]> {
    return [...this.rows.values()];
  }
  async update(id: string, patch: Partial<AccountRow>): Promise<AccountRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no account: ${id}`);
    const next: AccountRow = { ...cur, ...patch, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
}

class InMemActionStore implements ActionStorePort {
  readonly rows = new Map<string, ActionRow>();
  async create(row: NewActionRow): Promise<ActionRow> {
    const now = new Date();
    const full: ActionRow = {
      id: row.id ?? nextId('act'),
      accountId: row.accountId,
      targetId: row.targetId,
      campaignId: row.campaignId,
      type: row.type,
      scheduledAt: row.scheduledAt,
      executedAt: row.executedAt ?? null,
      result: row.result ?? 'pending',
      dedupKey: row.dedupKey,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<ActionRow | undefined> {
    return this.rows.get(id);
  }
  async listByAccount(accountId: string): Promise<ActionRow[]> {
    return [...this.rows.values()].filter((r) => r.accountId === accountId);
  }
}

class InMemCampaignRepo implements CampaignRepoPort {
  readonly rows = new Map<string, CampaignRow>();
  async create(row: NewCampaignRow): Promise<CampaignRow> {
    const now = new Date();
    const full: CampaignRow = {
      id: row.id ?? nextId('camp'),
      goal: row.goal,
      autonomyLevel: row.autonomyLevel ?? 'supervised',
      messageStrategy: row.messageStrategy,
      owner: row.owner,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<CampaignRow | undefined> {
    return this.rows.get(id);
  }
  async setAutonomy(id: string, level: CampaignRow['autonomyLevel']): Promise<CampaignRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no campaign: ${id}`);
    const next = { ...cur, autonomyLevel: level, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
}

class InMemTargetRepo implements TargetRepoPort {
  readonly rows = new Map<string, TargetRow>();
  async create(row: NewTargetRow): Promise<TargetRow> {
    const now = new Date();
    const full: TargetRow = {
      id: row.id ?? nextId('tgt'),
      campaignId: row.campaignId,
      prospectRef: row.prospectRef,
      linkedinUrn: row.linkedinUrn,
      externalContext: row.externalContext ?? {},
      stage: row.stage ?? 'sourced',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async createMany(rows: NewTargetRow[]): Promise<TargetRow[]> {
    const out: TargetRow[] = [];
    for (const r of rows) out.push(await this.create(r));
    return out;
  }
  async findById(id: string): Promise<TargetRow | undefined> {
    return this.rows.get(id);
  }
  async setExternalContext(id: string, blob: NewTargetRow['externalContext']): Promise<TargetRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no target: ${id}`);
    const next = { ...cur, externalContext: blob ?? {}, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
  async setStage(id: string, stage: TargetRow['stage']): Promise<TargetRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no target: ${id}`);
    const next = { ...cur, stage, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
}

class InMemMessageRepo implements MessageRepoPort {
  readonly rows = new Map<string, MessageRow>();
  async create(row: NewMessageRow): Promise<MessageRow> {
    const now = new Date();
    const full: MessageRow = {
      id: row.id ?? nextId('msg'),
      accountId: row.accountId,
      targetId: row.targetId,
      direction: row.direction,
      body: row.body,
      threadRef: row.threadRef,
      intent: row.intent ?? null,
      status: row.status ?? 'draft',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<MessageRow | undefined> {
    return this.rows.get(id);
  }
  async setStatus(id: string, status: MessageRow['status']): Promise<MessageRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no message: ${id}`);
    const next = { ...cur, status, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
  async setBody(id: string, body: string): Promise<MessageRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no message: ${id}`);
    const next = { ...cur, body, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
  async listByThread(threadRef: string): Promise<MessageRow[]> {
    return [...this.rows.values()].filter((r) => r.threadRef === threadRef);
  }
}

class InMemApprovalRepo implements ApprovalRepoPort {
  readonly rows: ApprovalRow[] = [];
  async create(row: NewApprovalRow): Promise<ApprovalRow> {
    const full: ApprovalRow = {
      id: row.id ?? nextId('appr'),
      pendingItemRef: row.pendingItemRef,
      decision: row.decision,
      editor: row.editor,
      timestamp: new Date(),
    };
    this.rows.push(full);
    return full;
  }
}

/** Append-only in-memory event store. Only append + reads; no update or delete,
 * so the audit spine stays immutable by construction. */
class InMemEventRepo implements EventReadPort {
  readonly rows: EventRow[] = [];
  async append(row: NewEventRow): Promise<EventRow> {
    const full: EventRow = {
      id: row.id ?? nextId('evt'),
      ts: new Date(),
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
  async listByAccount(accountId: string): Promise<EventRow[]> {
    return this.rows
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
  }
  async listAll(): Promise<EventRow[]> {
    return [...this.rows];
  }
}

/** The full in-memory store implementing RuntimeStore. */
export class InMemoryStore implements RuntimeStore {
  readonly account: InMemAccountStore = new InMemAccountStore();
  readonly action: InMemActionStore = new InMemActionStore();
  readonly campaign: InMemCampaignRepo = new InMemCampaignRepo();
  readonly target: InMemTargetRepo = new InMemTargetRepo();
  readonly message: InMemMessageRepo = new InMemMessageRepo();
  readonly approval: InMemApprovalRepo = new InMemApprovalRepo();
  readonly event: InMemEventRepo = new InMemEventRepo();
  async listTargetsByCampaign(campaignId: string): Promise<TargetRow[]> {
    return [...this.target.rows.values()].filter((t) => t.campaignId === campaignId);
  }
  async close(): Promise<void> {
    // Nothing to release.
  }
}

export function makeInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}
