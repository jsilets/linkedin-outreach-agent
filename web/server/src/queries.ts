// Read queries and the steps write, all against the shared schema via Drizzle.
import { join } from 'node:path';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { buildStorageStateFromPastedCookies, saveStorageState } from '@loa/account-runner';
import type { ActionType } from '@loa/shared';
import { db, schema } from './db.js';
import { normalizeSteps, type NormalizedStep } from './steps.js';

const { campaigns, campaignSteps, targets, targetProgress, actions, accounts, leadLists, leadListMembers } =
  schema;

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

// --- Account linking (paste session cookies -> sealed vault) ---------------

function emptyUsed(): Record<ActionType, number> {
  return { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 };
}

export interface LinkAccountInput {
  handle: string;
  liAt: string;
  jsessionId: string;
}

export interface LinkAccountResult {
  accountId: string;
  handle: string;
}

/**
 * Link a LinkedIn account from pasted session cookies: validate + build the
 * storage state, create the account row, then seal the session into the vault
 * keyed by the new account id (the same id the executor resolves at
 * pageFor(accountId)). If sealing fails, the half-created row is rolled back so
 * we never leave an account with no session. buildStorageStateFromPastedCookies
 * throws VaultError on malformed input, which the route maps to a 400.
 */
export async function linkAccount(input: LinkAccountInput): Promise<LinkAccountResult> {
  // Validate the cookies BEFORE touching the database.
  const state = buildStorageStateFromPastedCookies({
    liAt: input.liAt,
    jsessionId: input.jsessionId,
  });

  const today = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(accounts)
    .values({
      handle: input.handle,
      state: 'Warming',
      warmupDay: 0,
      proxyBinding: { proxyId: `paste-${input.handle}`, region: 'local', sticky: false },
      health: { acceptanceRate: 0, replyRate: 0, challengesLast7d: 0, lastCheckedAt: new Date() },
      budget: { date: today, caps: emptyUsed(), used: emptyUsed() },
    })
    .returning({ id: accounts.id, handle: accounts.handle });
  if (!row) throw new Error('failed to create account row');

  const vaultDir = process.env.LOA_VAULT_DIR ?? '/data/vault';
  try {
    await saveStorageState(join(vaultDir, `${row.id}.vault.json`), state);
  } catch (err) {
    // Roll back the orphan row so the account list never shows a session-less account.
    await db.delete(accounts).where(eq(accounts.id, row.id));
    throw err;
  }
  return { accountId: row.id, handle: row.handle };
}

// --- Lead lists ------------------------------------------------------------

export interface ListSummary {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
}

// Lists with a per-list member count via a left join so empty lists still show
// (count 0). Ordered oldest-first.
export async function listLists(): Promise<ListSummary[]> {
  const rows = await db
    .select({
      id: leadLists.id,
      name: leadLists.name,
      description: leadLists.description,
      createdAt: sql<string>`to_char(${leadLists.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      memberCount: sql<number>`count(${leadListMembers.id})::int`,
    })
    .from(leadLists)
    .leftJoin(leadListMembers, eq(leadListMembers.listId, leadLists.id))
    .groupBy(leadLists.id)
    .orderBy(asc(leadLists.createdAt));
  return rows;
}

export async function createList(input: {
  name: string;
  description?: string;
}): Promise<{ id: string; name: string; description: string | null }> {
  const [row] = await db
    .insert(leadLists)
    .values({ name: input.name, description: input.description ?? null })
    .returning({ id: leadLists.id, name: leadLists.name, description: leadLists.description });
  if (!row) throw new Error('failed to create lead list');
  return row;
}

export interface ListMember {
  id: string;
  linkedinUrn: string;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  degree: string | null;
  location: string | null;
  currentCompany: string | null;
}

export interface ListDetail {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  members: ListMember[];
}

// One list plus its members, ordered oldest-added first. Null when the list row
// does not exist.
export async function getList(id: string): Promise<ListDetail | null> {
  const [list] = await db
    .select({
      id: leadLists.id,
      name: leadLists.name,
      description: leadLists.description,
      createdAt: sql<string>`to_char(${leadLists.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(leadLists)
    .where(eq(leadLists.id, id));
  if (!list) return null;

  const members = await db
    .select({
      id: leadListMembers.id,
      linkedinUrn: leadListMembers.linkedinUrn,
      name: leadListMembers.name,
      headline: leadListMembers.headline,
      profileUrl: leadListMembers.profileUrl,
      degree: leadListMembers.degree,
      location: leadListMembers.location,
      currentCompany: leadListMembers.currentCompany,
    })
    .from(leadListMembers)
    .where(eq(leadListMembers.listId, id))
    .orderBy(asc(leadListMembers.addedAt));

  return { ...list, members };
}

// Delete a list (cascade removes its members). True when a row was removed.
export async function deleteList(id: string): Promise<boolean> {
  const deleted = await db.delete(leadLists).where(eq(leadLists.id, id)).returning({ id: leadLists.id });
  return deleted.length > 0;
}

export interface CreateCampaignFromListInput {
  goal: string;
  owner?: string;
  messageStrategy?: string;
}

export interface CreateCampaignFromListResult {
  campaignId: string;
  targetCount: number;
}

/**
 * Create a campaign from a lead list: make the campaign, then copy every list
 * member in as a target (stage 'sourced'). Done in one transaction so a campaign
 * is never created without its leads. The funnel (sequence) is set afterwards in
 * the flow editor, and enrollment under a sender account happens from there.
 * Throws if the list has no members (nothing to campaign).
 */
export async function createCampaignFromList(
  listId: string,
  input: CreateCampaignFromListInput,
): Promise<CreateCampaignFromListResult> {
  const members = await db
    .select({
      linkedinUrn: leadListMembers.linkedinUrn,
      externalContext: leadListMembers.externalContext,
    })
    .from(leadListMembers)
    .where(eq(leadListMembers.listId, listId));
  if (members.length === 0) {
    throw new EmptyListError('cannot create a campaign from an empty list');
  }

  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        goal: input.goal,
        autonomyLevel: 'supervised',
        messageStrategy: input.messageStrategy ?? 'one specific, relevant reason; short',
        owner: input.owner ?? 'operator',
      })
      .returning({ id: campaigns.id });
    if (!campaign) throw new Error('failed to create campaign');

    await tx.insert(targets).values(
      members.map((m) => ({
        campaignId: campaign.id,
        prospectRef: m.linkedinUrn,
        linkedinUrn: m.linkedinUrn,
        externalContext: m.externalContext,
        stage: 'sourced' as const,
      })),
    );

    return { campaignId: campaign.id, targetCount: members.length };
  });
}

/** Thrown when creating a campaign from a list that has no leads. Maps to 400. */
export class EmptyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyListError';
  }
}

/** Thrown when a launch is missing a precondition (no steps / no account). 400. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

export interface LaunchResult {
  enrolled: number;
  alreadyEnrolled: number;
}

/**
 * Launch a campaign: enroll every target into the sequence under a sender
 * account by creating an in_progress cursor (target_progress). Mirrors the
 * runtime sequence store's enrollTarget — a null nextStepAt with state
 * in_progress is "due now", so the next dispatch tick fires the first step.
 * Idempotent per target (unique on target_id): re-launching only enrolls the
 * targets that aren't enrolled yet. Refuses to launch a campaign with no enabled
 * steps or an unknown account.
 */
export async function launchCampaign(campaignId: string, accountId: string): Promise<LaunchResult> {
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new LaunchError('campaign not found');

  const [account] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new LaunchError('unknown sender account; link an account first');

  const [stepCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignSteps)
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.enabled, true)));
  if (!stepCount || stepCount.n === 0) {
    throw new LaunchError('define a funnel (at least one enabled step) before launching');
  }

  const targetRows = await db.select({ id: targets.id }).from(targets).where(eq(targets.campaignId, campaignId));
  if (targetRows.length === 0) throw new LaunchError('campaign has no targets to enroll');

  const inserted = await db
    .insert(targetProgress)
    .values(
      targetRows.map((t) => ({
        campaignId,
        targetId: t.id,
        accountId,
        state: 'in_progress' as const,
      })),
    )
    .onConflictDoNothing({ target: targetProgress.targetId })
    .returning({ id: targetProgress.id });

  return { enrolled: inserted.length, alreadyEnrolled: targetRows.length - inserted.length };
}
