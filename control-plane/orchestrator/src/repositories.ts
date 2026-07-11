// Data-access layer over the shared Drizzle schema. One repository per entity.
// All go through the Db seam so tests can run without Postgres. These are thin:
// they map rows in and out and expose the queries the orchestrator needs. They
// deliberately do not encode business rules (that lives in the services).

import { db as shared } from '@loa/shared';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from './db.js';

const {
  accounts,
  campaigns,
  targets,
  actions,
  messages,
  approvals,
  events,
} = shared.schema;

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

export class AccountRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewAccountRow): Promise<AccountRow> {
    const [out] = await this.db.handle.insert(accounts).values(row).returning();
    return out!;
  }

  async findById(id: string): Promise<AccountRow | undefined> {
    const [out] = await this.db.handle
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
    return out;
  }

  /** Every account. Backs safety rehydration and killAll across the fleet. */
  async list(): Promise<AccountRow[]> {
    return this.db.handle.select().from(accounts);
  }

  /** Patch an account row. Used by admin pause/resume and budget edits. */
  async update(id: string, patch: Partial<AccountRow>): Promise<AccountRow> {
    const [out] = await this.db.handle
      .update(accounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(accounts.id, id))
      .returning();
    return out!;
  }
}

export class CampaignRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewCampaignRow): Promise<CampaignRow> {
    const [out] = await this.db.handle.insert(campaigns).values(row).returning();
    return out!;
  }

  async findById(id: string): Promise<CampaignRow | undefined> {
    const [out] = await this.db.handle
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id));
    return out;
  }

  async setAutonomy(id: string, level: CampaignRow['autonomyLevel']): Promise<CampaignRow> {
    const [out] = await this.db.handle
      .update(campaigns)
      .set({ autonomyLevel: level, updatedAt: new Date() })
      .where(eq(campaigns.id, id))
      .returning();
    return out!;
  }
}

export class TargetRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewTargetRow): Promise<TargetRow> {
    const [out] = await this.db.handle.insert(targets).values(row).returning();
    return out!;
  }

  async createMany(rows: NewTargetRow[]): Promise<TargetRow[]> {
    if (rows.length === 0) return [];
    return this.db.handle.insert(targets).values(rows).returning();
  }

  async findById(id: string): Promise<TargetRow | undefined> {
    const [out] = await this.db.handle
      .select()
      .from(targets)
      .where(eq(targets.id, id));
    return out;
  }

  async listByCampaign(campaignId: string): Promise<TargetRow[]> {
    return this.db.handle
      .select()
      .from(targets)
      .where(eq(targets.campaignId, campaignId));
  }

  /** Every target row across all campaigns that shares a LinkedIn URN. */
  async listByUrn(linkedinUrn: string): Promise<TargetRow[]> {
    return this.db.handle
      .select()
      .from(targets)
      .where(eq(targets.linkedinUrn, linkedinUrn));
  }

  async setExternalContext(id: string, blob: NewTargetRow['externalContext']): Promise<TargetRow> {
    const [out] = await this.db.handle
      .update(targets)
      .set({ externalContext: blob, updatedAt: new Date() })
      .where(eq(targets.id, id))
      .returning();
    return out!;
  }

  async setStage(id: string, stage: TargetRow['stage']): Promise<TargetRow> {
    const [out] = await this.db.handle
      .update(targets)
      .set({ stage, updatedAt: new Date() })
      .where(eq(targets.id, id))
      .returning();
    return out!;
  }
}

export class ActionRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewActionRow): Promise<ActionRow> {
    const [out] = await this.db.handle.insert(actions).values(row).returning();
    return out!;
  }

  async findById(id: string): Promise<ActionRow | undefined> {
    const [out] = await this.db.handle
      .select()
      .from(actions)
      .where(eq(actions.id, id));
    return out;
  }

  async setResult(id: string, result: ActionRow['result'], executedAt: Date | null): Promise<ActionRow> {
    const [out] = await this.db.handle
      .update(actions)
      .set({ result, executedAt, updatedAt: new Date() })
      .where(eq(actions.id, id))
      .returning();
    return out!;
  }

  /** Remove an action row. Used to clean up a just-created pending row when a
   * mint-time safety re-check defers, so no orphan pending row is left behind. */
  async deleteById(id: string): Promise<void> {
    await this.db.handle.delete(actions).where(eq(actions.id, id));
  }

  /** Every action for one account. Backs the weekly-invite counter. */
  async listByAccount(accountId: string): Promise<ActionRow[]> {
    return this.db.handle
      .select()
      .from(actions)
      .where(eq(actions.accountId, accountId));
  }
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewMessageRow): Promise<MessageRow> {
    const [out] = await this.db.handle.insert(messages).values(row).returning();
    return out!;
  }

  async findById(id: string): Promise<MessageRow | undefined> {
    const [out] = await this.db.handle
      .select()
      .from(messages)
      .where(eq(messages.id, id));
    return out;
  }

  async setIntent(id: string, intent: MessageRow['intent']): Promise<MessageRow> {
    const [out] = await this.db.handle
      .update(messages)
      .set({ intent, updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();
    return out!;
  }

  async setStatus(id: string, status: MessageRow['status']): Promise<MessageRow> {
    const [out] = await this.db.handle
      .update(messages)
      .set({ status, updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();
    return out!;
  }

  async setBody(id: string, body: string): Promise<MessageRow> {
    const [out] = await this.db.handle
      .update(messages)
      .set({ body, updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();
    return out!;
  }

  async listByThread(threadRef: string): Promise<MessageRow[]> {
    return this.db.handle
      .select()
      .from(messages)
      .where(eq(messages.threadRef, threadRef));
  }

  async listDrafts(): Promise<MessageRow[]> {
    return this.db.handle
      .select()
      .from(messages)
      .where(eq(messages.status, 'draft'))
      .orderBy(asc(messages.createdAt));
  }

  /** Approved-but-unsent messages, oldest first. The dispatch tick sends these
   * when the working-hours window is open, so an off-hours approval goes out at
   * the next window with no second approval. */
  async listApproved(): Promise<MessageRow[]> {
    return this.db.handle
      .select()
      .from(messages)
      .where(eq(messages.status, 'approved'))
      .orderBy(asc(messages.createdAt));
  }
}

export class ApprovalRepo {
  constructor(private readonly db: Db) {}

  async create(row: NewApprovalRow): Promise<ApprovalRow> {
    const [out] = await this.db.handle.insert(approvals).values(row).returning();
    return out!;
  }

  async listByPendingItem(pendingItemRef: string): Promise<ApprovalRow[]> {
    return this.db.handle
      .select()
      .from(approvals)
      .where(eq(approvals.pendingItemRef, pendingItemRef));
  }
}

/**
 * EventRepo is append-only by construction: it exposes append and reads, and no
 * update or delete. This is the audit spine; everything funnels through append.
 */
export class EventRepo {
  constructor(private readonly db: Db) {}

  async append(row: NewEventRow): Promise<EventRow> {
    const [out] = await this.db.handle.insert(events).values(row).returning();
    return out!;
  }

  async listByAccount(accountId: string): Promise<EventRow[]> {
    return this.db.handle
      .select()
      .from(events)
      .where(eq(events.accountId, accountId))
      .orderBy(desc(events.ts));
  }

  async listByKind(accountId: string, kind: string): Promise<EventRow[]> {
    return this.db.handle
      .select()
      .from(events)
      .where(and(eq(events.accountId, accountId), eq(events.kind, kind)))
      .orderBy(desc(events.ts));
  }

  /** Every event, oldest-first. Backs the smoke trace and audit tooling. */
  async listAll(): Promise<EventRow[]> {
    return this.db.handle.select().from(events).orderBy(asc(events.ts));
  }

  /** Suppression events are account-null; read that bucket for the router. */
  async listSuppression(): Promise<EventRow[]> {
    return this.db.handle
      .select()
      .from(events)
      .where(and(isNull(events.accountId), eq(events.kind, 'target_suppressed')))
      .orderBy(desc(events.ts));
  }
}

/** All repositories, constructed over one Db seam. */
export interface Repositories {
  account: AccountRepo;
  campaign: CampaignRepo;
  target: TargetRepo;
  action: ActionRepo;
  message: MessageRepo;
  approval: ApprovalRepo;
  event: EventRepo;
}

export function makeRepositories(db: Db): Repositories {
  return {
    account: new AccountRepo(db),
    campaign: new CampaignRepo(db),
    target: new TargetRepo(db),
    action: new ActionRepo(db),
    message: new MessageRepo(db),
    approval: new ApprovalRepo(db),
    event: new EventRepo(db),
  };
}
