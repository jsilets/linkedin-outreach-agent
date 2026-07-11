// Postgres-backed store: used when DATABASE_URL is set. It wraps PostgresDb and
// the orchestrator's concrete repositories, and adapts the account/action/event
// reads onto the async RuntimeStore surface.
//
// This path is structurally complete and typechecks. It has not been exercised
// against a live database in dev/smoke, which run in memory. Bringing it up
// requires a reachable Postgres with the shared Drizzle schema migrated.

import { db as shared } from '@loa/shared';
import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import {
  PostgresDb,
  makeRepositories,
  type Db,
  type Repositories,
} from '@loa/orchestrator';
import type {
  AccountStorePort,
  ActionStorePort,
  EventReadPort,
  LeadListStorePort,
  RuntimeStore,
  SequenceStorePort,
  TargetProgressPatch,
} from './index.js';

const { campaignSteps, targetProgress, targets, actions, messages, leadLists, leadListMembers } =
  shared.schema;

class PgAccountStore implements AccountStorePort {
  constructor(private readonly repos: Repositories) {}
  async create(row: shared.NewAccountRow): Promise<shared.AccountRow> {
    return this.repos.account.create(row);
  }
  async findById(id: string): Promise<shared.AccountRow | undefined> {
    return this.repos.account.findById(id);
  }
  async all(): Promise<shared.AccountRow[]> {
    return this.repos.account.list();
  }
  async update(id: string, patch: Partial<shared.AccountRow>): Promise<shared.AccountRow> {
    return this.repos.account.update(id, patch);
  }
}

class PgActionStore implements ActionStorePort {
  constructor(private readonly repos: Repositories) {}
  async create(row: shared.NewActionRow): Promise<shared.ActionRow> {
    return this.repos.action.create(row);
  }
  async findById(id: string): Promise<shared.ActionRow | undefined> {
    return this.repos.action.findById(id);
  }
  async listByAccount(accountId: string): Promise<shared.ActionRow[]> {
    return this.repos.action.listByAccount(accountId);
  }
  async setResult(
    id: string,
    result: shared.ActionRow['result'],
    executedAt: Date | null,
  ): Promise<shared.ActionRow> {
    return this.repos.action.setResult(id, result, executedAt);
  }
  async deleteById(id: string): Promise<void> {
    return this.repos.action.deleteById(id);
  }
}

class PgEventRead implements EventReadPort {
  constructor(private readonly repos: Repositories) {}
  async append(row: shared.NewEventRow): Promise<shared.EventRow> {
    return this.repos.event.append(row);
  }
  async listSuppression(): Promise<shared.EventRow[]> {
    return this.repos.event.listSuppression();
  }
  async listByAccount(accountId: string): Promise<shared.EventRow[]> {
    return this.repos.event.listByAccount(accountId);
  }
  async listAll(): Promise<shared.EventRow[]> {
    return this.repos.event.listAll();
  }
}

/** Campaign-sequence store over the Drizzle handle. The orchestrator repos do
 * not cover campaign_steps / target_progress, so these queries go direct. */
class PgSequenceStore implements SequenceStorePort {
  constructor(private readonly db: Db) {}

  async listCampaignSteps(campaignId: string): Promise<shared.CampaignStepRow[]> {
    return this.db.handle
      .select()
      .from(campaignSteps)
      .where(eq(campaignSteps.campaignId, campaignId))
      .orderBy(asc(campaignSteps.stepOrder));
  }

  async upsertCampaignStep(step: shared.NewCampaignStepRow): Promise<shared.CampaignStepRow> {
    if (step.id) {
      const [out] = await this.db.handle
        .update(campaignSteps)
        .set({ ...step, updatedAt: new Date() })
        .where(eq(campaignSteps.id, step.id))
        .returning();
      if (out) return out;
    }
    const [created] = await this.db.handle.insert(campaignSteps).values(step).returning();
    return created!;
  }

  async deleteCampaignStep(id: string): Promise<void> {
    await this.db.handle.delete(campaignSteps).where(eq(campaignSteps.id, id));
  }

  async reorderCampaignSteps(campaignId: string, orderedIds: string[]): Promise<void> {
    // Two-phase to dodge the (campaignId, stepOrder) unique index mid-swap:
    // park every row at a negative order, then write the final positions.
    await this.db.handle.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx
          .update(campaignSteps)
          .set({ stepOrder: -1 - i, updatedAt: new Date() })
          .where(and(eq(campaignSteps.id, orderedIds[i]!), eq(campaignSteps.campaignId, campaignId)));
      }
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx
          .update(campaignSteps)
          .set({ stepOrder: i, updatedAt: new Date() })
          .where(and(eq(campaignSteps.id, orderedIds[i]!), eq(campaignSteps.campaignId, campaignId)));
      }
    });
  }

  async enrollTarget(
    campaignId: string,
    targetId: string,
    accountId: string,
  ): Promise<shared.TargetProgressRow> {
    // Idempotent on the target_progress_target_idx unique index.
    const [out] = await this.db.handle
      .insert(targetProgress)
      .values({ campaignId, targetId, accountId, state: 'in_progress' })
      .onConflictDoNothing({ target: targetProgress.targetId })
      .returning();
    if (out) return out;
    const [existing] = await this.db.handle
      .select()
      .from(targetProgress)
      .where(eq(targetProgress.targetId, targetId));
    return existing!;
  }

  async listTargetProgress(campaignId: string): Promise<shared.TargetProgressRow[]> {
    return this.db.handle
      .select()
      .from(targetProgress)
      .where(eq(targetProgress.campaignId, campaignId));
  }

  async getTargetProgressByTarget(
    targetId: string,
  ): Promise<shared.TargetProgressRow | undefined> {
    const [row] = await this.db.handle
      .select()
      .from(targetProgress)
      .where(eq(targetProgress.targetId, targetId));
    return row;
  }

  async dueTargetProgress(now: Date): Promise<shared.TargetProgressRow[]> {
    return this.db.handle
      .select()
      .from(targetProgress)
      .where(
        and(
          eq(targetProgress.state, 'in_progress'),
          or(isNull(targetProgress.nextStepAt), lte(targetProgress.nextStepAt, now)),
        ),
      );
  }

  async awaitingConnectionEnrollments(): Promise<shared.TargetProgressRow[]> {
    return this.db.handle
      .select()
      .from(targetProgress)
      .where(eq(targetProgress.state, 'awaiting_connection'));
  }

  async activeEnrollments(): Promise<shared.TargetProgressRow[]> {
    return this.db.handle
      .select()
      .from(targetProgress)
      .where(
        or(
          eq(targetProgress.state, 'in_progress'),
          eq(targetProgress.state, 'pending'),
          eq(targetProgress.state, 'awaiting_approval'),
          eq(targetProgress.state, 'awaiting_connection'),
        ),
      );
  }

  async advanceTargetProgress(id: string, patch: TargetProgressPatch): Promise<void> {
    await this.db.handle
      .update(targetProgress)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(targetProgress.id, id));
  }

  async pullTargetFromFunnel(targetId: string, reason: string): Promise<void> {
    await this.db.handle
      .update(targetProgress)
      .set({ state: 'replied', nextStepAt: null, errorMessage: reason, updatedAt: new Date() })
      .where(
        and(
          eq(targetProgress.targetId, targetId),
          or(
            eq(targetProgress.state, 'in_progress'),
            eq(targetProgress.state, 'pending'),
            eq(targetProgress.state, 'awaiting_approval'),
            eq(targetProgress.state, 'awaiting_connection'),
          ),
        ),
      );
    // Cancel this target's undelivered outbound messages so an approved-but-unsent
    // draft never fires after the person has left the funnel.
    await this.db.handle
      .update(messages)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(messages.targetId, targetId),
          eq(messages.direction, 'outbound'),
          or(eq(messages.status, 'draft'), eq(messages.status, 'approved')),
        ),
      );
  }

  async campaignCounts(campaignId: string): Promise<{
    targets: number;
    byStage: Record<string, number>;
    byProgressState: Record<string, number>;
  }> {
    const stageRows = await this.db.handle
      .select({ stage: targets.stage, count: sql<number>`count(*)::int` })
      .from(targets)
      .where(eq(targets.campaignId, campaignId))
      .groupBy(targets.stage);
    const stateRows = await this.db.handle
      .select({ state: targetProgress.state, count: sql<number>`count(*)::int` })
      .from(targetProgress)
      .where(eq(targetProgress.campaignId, campaignId))
      .groupBy(targetProgress.state);
    const byStage: Record<string, number> = {};
    let total = 0;
    for (const r of stageRows) {
      byStage[r.stage] = r.count;
      total += r.count;
    }
    const byProgressState: Record<string, number> = {};
    for (const r of stateRows) byProgressState[r.state] = r.count;
    return { targets: total, byStage, byProgressState };
  }

  async actionVolume(
    accountId: string,
    sinceDays: number,
  ): Promise<Array<{ date: string; type: string; count: number }>> {
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const at = sql<Date>`coalesce(${actions.executedAt}, ${actions.scheduledAt})`;
    const dateExpr = sql<string>`to_char(${at}, 'YYYY-MM-DD')`;
    const rows = await this.db.handle
      .select({ date: dateExpr, type: actions.type, count: sql<number>`count(*)::int` })
      .from(actions)
      .where(and(eq(actions.accountId, accountId), gte(at, cutoff)))
      .groupBy(dateExpr, actions.type)
      .orderBy(dateExpr, actions.type);
    return rows.map((r) => ({ date: r.date, type: r.type, count: r.count }));
  }
}

/** Lead-list store over the Drizzle handle. Writes the same lead_lists /
 * lead_list_members tables the web UI's ListsView reads. Member inserts dedup on
 * the lead_list_members_list_urn_uq unique index. */
class PgLeadListStore implements LeadListStorePort {
  constructor(private readonly db: Db) {}

  async createList(input: { name: string; description?: string }): Promise<shared.LeadListRow> {
    const [row] = await this.db.handle
      .insert(leadLists)
      .values({ name: input.name, description: input.description ?? null })
      .returning();
    return row!;
  }

  async listWithCounts(): Promise<Array<shared.LeadListRow & { memberCount: number }>> {
    const rows = await this.db.handle
      .select({
        list: leadLists,
        memberCount: sql<number>`count(${leadListMembers.id})::int`,
      })
      .from(leadLists)
      .leftJoin(leadListMembers, eq(leadListMembers.listId, leadLists.id))
      .groupBy(leadLists.id)
      .orderBy(asc(leadLists.createdAt));
    return rows.map((r) => ({ ...r.list, memberCount: r.memberCount }));
  }

  async findById(id: string): Promise<shared.LeadListRow | undefined> {
    const [row] = await this.db.handle.select().from(leadLists).where(eq(leadLists.id, id));
    return row;
  }

  async listMembers(listId: string): Promise<shared.LeadListMemberRow[]> {
    return this.db.handle
      .select()
      .from(leadListMembers)
      .where(eq(leadListMembers.listId, listId))
      .orderBy(asc(leadListMembers.addedAt));
  }

  async insertMembers(rows: shared.NewLeadListMemberRow[]): Promise<{ inserted: number }> {
    if (rows.length === 0) return { inserted: 0 };
    const out = await this.db.handle
      .insert(leadListMembers)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: leadListMembers.id });
    return { inserted: out.length };
  }
}

export class PostgresStore implements RuntimeStore {
  readonly account: AccountStorePort;
  readonly action: ActionStorePort;
  readonly campaign: Repositories['campaign'];
  readonly target: Repositories['target'];
  readonly message: Repositories['message'];
  readonly approval: Repositories['approval'];
  readonly event: EventReadPort;
  readonly sequence: SequenceStorePort;
  readonly leadList: LeadListStorePort;
  private readonly db: Db;

  private readonly repos: Repositories;

  constructor(db: Db) {
    this.db = db;
    const repos = makeRepositories(db);
    this.repos = repos;
    this.account = new PgAccountStore(repos);
    this.action = new PgActionStore(repos);
    this.campaign = repos.campaign;
    this.target = repos.target;
    this.message = repos.message;
    this.approval = repos.approval;
    this.event = new PgEventRead(repos);
    this.sequence = new PgSequenceStore(db);
    this.leadList = new PgLeadListStore(db);
  }

  async listTargetsByCampaign(campaignId: string): Promise<shared.TargetRow[]> {
    return this.repos.target.listByCampaign(campaignId);
  }

  async close(): Promise<void> {
    if (this.db instanceof PostgresDb) {
      await this.db.close();
    }
  }
}

/** Build a Postgres store from DATABASE_URL. Throws if the URL is missing. */
export function makePostgresStore(url?: string): PostgresStore {
  const db = new PostgresDb(url ? { url } : {});
  return new PostgresStore(db);
}
