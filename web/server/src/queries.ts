// Read queries and the steps write, all against the shared schema via Drizzle.
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from './db.js';
import { normalizeSteps, type NormalizedStep } from './steps.js';

const { campaigns, campaignSteps, targets, targetProgress, actions, accounts } = schema;

export interface CampaignSummary {
  id: string;
  goal: string;
  owner: string;
  autonomyLevel: string;
  messageStrategy: string;
  targetCount: number;
  byStage: Record<string, number>;
}

// Campaigns list with per-campaign target counts and a stage histogram.
export async function listCampaigns(): Promise<CampaignSummary[]> {
  const rows = await db.select().from(campaigns).orderBy(asc(campaigns.createdAt));

  const stageRows = await db
    .select({
      campaignId: targets.campaignId,
      stage: targets.stage,
      count: sql<number>`count(*)::int`,
    })
    .from(targets)
    .groupBy(targets.campaignId, targets.stage);

  const byCampaign = new Map<string, { total: number; byStage: Record<string, number> }>();
  for (const r of stageRows) {
    const entry = byCampaign.get(r.campaignId) ?? { total: 0, byStage: {} };
    entry.byStage[r.stage] = r.count;
    entry.total += r.count;
    byCampaign.set(r.campaignId, entry);
  }

  return rows.map((c) => {
    const counts = byCampaign.get(c.id) ?? { total: 0, byStage: {} };
    return {
      id: c.id,
      goal: c.goal,
      owner: c.owner,
      autonomyLevel: c.autonomyLevel,
      messageStrategy: c.messageStrategy,
      targetCount: counts.total,
      byStage: counts.byStage,
    };
  });
}

export interface CampaignDetail extends CampaignSummary {
  steps: Array<typeof campaignSteps.$inferSelect>;
  byProgressState: Record<string, number>;
}

// One campaign with its ordered steps and both count histograms.
export async function getCampaign(id: string): Promise<CampaignDetail | null> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) return null;

  const steps = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, id))
    .orderBy(asc(campaignSteps.stepOrder));

  const stageRows = await db
    .select({ stage: targets.stage, count: sql<number>`count(*)::int` })
    .from(targets)
    .where(eq(targets.campaignId, id))
    .groupBy(targets.stage);

  const progressRows = await db
    .select({ state: targetProgress.state, count: sql<number>`count(*)::int` })
    .from(targetProgress)
    .where(eq(targetProgress.campaignId, id))
    .groupBy(targetProgress.state);

  const byStage: Record<string, number> = {};
  let total = 0;
  for (const r of stageRows) {
    byStage[r.stage] = r.count;
    total += r.count;
  }
  const byProgressState: Record<string, number> = {};
  for (const r of progressRows) byProgressState[r.state] = r.count;

  return {
    id: campaign.id,
    goal: campaign.goal,
    owner: campaign.owner,
    autonomyLevel: campaign.autonomyLevel,
    messageStrategy: campaign.messageStrategy,
    targetCount: total,
    byStage,
    byProgressState,
    steps,
  };
}

// Replace the whole step list for a campaign in one transaction: delete the
// existing rows, then insert the normalized list. Deleting first sidesteps the
// unique (campaign_id, step_order) index during a reorder.
export async function replaceSteps(campaignId: string, input: unknown): Promise<NormalizedStep[]> {
  const normalized = normalizeSteps(input);

  await db.transaction(async (tx) => {
    await tx.delete(campaignSteps).where(eq(campaignSteps.campaignId, campaignId));
    if (normalized.length > 0) {
      await tx.insert(campaignSteps).values(
        normalized.map((s) => ({
          campaignId,
          stepOrder: s.stepOrder,
          stepType: s.stepType,
          delaySeconds: s.delaySeconds,
          note: s.note,
          body: s.body,
          reaction: s.reaction,
          enabled: s.enabled,
        })),
      );
    }
  });

  return normalized;
}

export interface VolumeRow {
  day: string;
  type: string;
  count: number;
}

// Build the volume aggregation query. Isolated so a test can assert the SQL
// shape without a live DB. Counts successful actions per calendar day per type,
// over the trailing `days` window, optionally filtered to one account.
export function buildVolumeQuery(opts: { accountId?: string; days: number }) {
  const since = sql`now() - (${opts.days} * interval '1 day')`;
  const conditions = [
    eq(actions.result, 'success'),
    gte(sql`coalesce(${actions.executedAt}, ${actions.scheduledAt})`, since),
  ];
  if (opts.accountId) {
    conditions.push(eq(actions.accountId, opts.accountId));
  }
  const day = sql<string>`to_char(date_trunc('day', coalesce(${actions.executedAt}, ${actions.scheduledAt})), 'YYYY-MM-DD')`;
  return db
    .select({ day, type: actions.type, count: sql<number>`count(*)::int` })
    .from(actions)
    .where(and(...conditions))
    .groupBy(day, actions.type)
    .orderBy(day);
}

export async function getVolume(opts: { accountId?: string; days: number }): Promise<VolumeRow[]> {
  return buildVolumeQuery(opts);
}

export interface AccountRow {
  id: string;
  handle: string;
  state: string;
  warmupDay: number;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      handle: accounts.handle,
      state: accounts.state,
      warmupDay: accounts.warmupDay,
    })
    .from(accounts)
    .orderBy(asc(accounts.handle));
  return rows;
}
