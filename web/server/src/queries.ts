// Read queries and the steps write, all against the shared schema via Drizzle.
import { join } from 'node:path';
import { buildStorageStateFromPastedCookies, saveStorageState } from '@loa/account-runner';
import type { AccountLimits, AccountSchedule, ActionType } from '@loa/shared';
import {
  ACTION_TYPES,
  ACTIVE_PROGRESS_STATES,
  CAMPAIGN_TARGET_REMOVAL_REASON,
  CANCELABLE_MESSAGE_STATUSES,
  DEFAULT_CAPS,
  DEFAULT_SCHEDULE,
  defaultLimits,
  extractCompany,
  FAILURE_EVENT_KIND_SUFFIXES,
  planCampaignTargetRemoval,
  readIcpScore,
} from '@loa/shared';
import type { SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Db, db, schema } from './db.js';
import { type NormalizedStep, normalizeSteps } from './steps.js';

const {
  campaigns,
  campaignSteps,
  targets,
  targetProgress,
  actions,
  messages,
  accounts,
  events,
  leadLists,
  leadListMembers,
} = schema;

/** Lifecycle a campaign has reached, derived from its enrollment cursors. */
export type CampaignStatus = 'draft' | 'active' | 'done';

// Progress states that render a campaign "active" in lifecycle derivation. A
// narrower set than the shared ACTIVE_PROGRESS_STATES (removal-eligibility): a
// pending cursor is enrolled-but-not-started, which does not by itself make the
// campaign lifecycle active.
const ACTIVE_LIFECYCLE_STATES = [
  'in_progress',
  'awaiting_approval',
  'awaiting_connection',
] as const;

/**
 * Derive campaign lifecycle from its progress-state histogram: no enrollment
 * cursors at all -> draft; any cursor in an active state -> active; cursors exist
 * but all terminal -> done.
 */
function deriveStatus(byProgressState: Record<string, number>): CampaignStatus {
  const enrolled = Object.values(byProgressState).reduce((sum, n) => sum + n, 0);
  if (enrolled === 0) return 'draft';
  const active = ACTIVE_LIFECYCLE_STATES.some((s) => (byProgressState[s] ?? 0) > 0);
  return active ? 'active' : 'done';
}

/**
 * HeyReach-style per-campaign performance counts. Absolute totals only; the UI
 * derives acceptance/reply rates from these client-side.
 */
export interface CampaignPerformance {
  /** connect actions that succeeded. */
  invitesSent: number;
  /** invite_accepted events attributed to this campaign. */
  invitesAccepted: number;
  /** message actions that succeeded. */
  messagesSent: number;
  /** distinct targets with a persisted inbound LinkedIn message. */
  replies: number;
}

function emptyPerformance(): CampaignPerformance {
  return { invitesSent: 0, invitesAccepted: 0, messagesSent: 0, replies: 0 };
}

export interface CampaignSummary {
  id: string;
  goal: string;
  owner: string;
  autonomyLevel: string;
  messageStrategy: string;
  targetCount: number;
  byStage: Record<string, number>;
  byProgressState: Record<string, number>;
  status: CampaignStatus;
  pendingCount: number;
  performance: CampaignPerformance;
}

// Successful outbound actions grouped by campaign + type, the actions half of the
// performance rollup (invitesSent = connect, messagesSent = message). Extracted so
// its SQL shape (result='success' filter, grouped) is assertable without a live DB
// (see buildVolumeQuery).
export function buildCampaignPerformanceActionsQuery() {
  return db
    .select({
      campaignId: actions.campaignId,
      type: actions.type,
      count: sql<number>`count(*)::int`,
    })
    .from(actions)
    .where(eq(actions.result, 'success'))
    .groupBy(actions.campaignId, actions.type);
}

// Campaigns list with per-campaign target counts, a stage histogram, a progress
// histogram, the derived lifecycle status, and a pending-approval count. Three
// grouped queries feed every campaign (one per histogram/count) so the whole list
// costs a fixed number of round-trips regardless of campaign count.
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

  const progressRows = await db
    .select({
      campaignId: targetProgress.campaignId,
      state: targetProgress.state,
      count: sql<number>`count(*)::int`,
    })
    .from(targetProgress)
    .groupBy(targetProgress.campaignId, targetProgress.state);

  const pendingRows = await db
    .select({
      campaignId: targets.campaignId,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(pendingDraftFilter())
    .groupBy(targets.campaignId);

  const queuedByCampaign = queuedTypeCountsByCampaign(await buildApprovedQueuedCountsQuery());

  // Performance rollup: three more grouped queries, folded in by campaign id the
  // same way the histograms above are. Invites/messages come from successful
  // actions; accepts from the invite_accepted event log (campaign lives in the
  // jsonb payload); replies from distinct targets with a persisted inbound
  // message. Intent can move a target to `lost`, so stage is not a reply metric.
  const perfActionRows = await buildCampaignPerformanceActionsQuery();
  const acceptedRows = await db
    .select({
      campaignId: sql<string | null>`${events.payload}->>'campaignId'`,
      count: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(eq(events.kind, 'invite_accepted'))
    .groupBy(sql`${events.payload}->>'campaignId'`);
  const replyRows = await db
    .select({
      campaignId: targets.campaignId,
      count: sql<number>`count(distinct ${messages.targetId})::int`,
    })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(eq(messages.direction, 'inbound'))
    .groupBy(targets.campaignId);

  const stageByCampaign = new Map<string, { total: number; byStage: Record<string, number> }>();
  for (const r of stageRows) {
    const entry = stageByCampaign.get(r.campaignId) ?? { total: 0, byStage: {} };
    entry.byStage[r.stage] = r.count;
    entry.total += r.count;
    stageByCampaign.set(r.campaignId, entry);
  }
  const progressByCampaign = new Map<string, Record<string, number>>();
  for (const r of progressRows) {
    const entry = progressByCampaign.get(r.campaignId) ?? {};
    entry[r.state] = r.count;
    progressByCampaign.set(r.campaignId, entry);
  }
  const pendingByCampaign = new Map<string, number>();
  for (const r of pendingRows) pendingByCampaign.set(r.campaignId, r.count);

  const perfByCampaign = new Map<string, CampaignPerformance>();
  const ensurePerf = (id: string): CampaignPerformance => {
    let p = perfByCampaign.get(id);
    if (!p) {
      p = emptyPerformance();
      perfByCampaign.set(id, p);
    }
    return p;
  };
  for (const r of perfActionRows) {
    const p = ensurePerf(r.campaignId);
    if (r.type === 'connect') p.invitesSent = r.count;
    else if (r.type === 'message') p.messagesSent = r.count;
  }
  for (const r of acceptedRows) {
    if (!r.campaignId) continue;
    ensurePerf(r.campaignId).invitesAccepted = r.count;
  }
  for (const r of replyRows) ensurePerf(r.campaignId).replies = r.count;

  return rows.map((c) => {
    const counts = stageByCampaign.get(c.id) ?? { total: 0, byStage: {} };
    // Status is derived from the RAW histogram (awaiting_approval still counts as
    // an active lifecycle state); the split only reshapes what the funnel renders.
    const rawByProgressState = progressByCampaign.get(c.id) ?? {};
    const byProgressState = splitApprovedQueued(
      rawByProgressState,
      queuedByCampaign.get(c.id) ?? {},
    );
    return {
      id: c.id,
      goal: c.goal,
      owner: c.owner,
      autonomyLevel: c.autonomyLevel,
      messageStrategy: c.messageStrategy,
      targetCount: counts.total,
      byStage: counts.byStage,
      byProgressState,
      status: deriveStatus(rawByProgressState),
      pendingCount: pendingByCampaign.get(c.id) ?? 0,
      performance: perfByCampaign.get(c.id) ?? emptyPerformance(),
    };
  });
}

export interface CampaignDetail extends CampaignSummary {
  steps: Array<typeof campaignSteps.$inferSelect>;
  enrolledCount: number;
}

// One campaign with its ordered steps, both count histograms, the derived
// lifecycle status, and the pending-approval + enrolled counts.
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

  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(and(eq(targets.campaignId, id), pendingDraftFilter()));

  const byStage: Record<string, number> = {};
  let total = 0;
  for (const r of stageRows) {
    byStage[r.stage] = r.count;
    total += r.count;
  }
  const rawByProgressState: Record<string, number> = {};
  let enrolledCount = 0;
  for (const r of progressRows) {
    rawByProgressState[r.state] = r.count;
    enrolledCount += r.count;
  }
  const queuedByType =
    queuedTypeCountsByCampaign(await buildApprovedQueuedCountsQuery(id)).get(id) ?? {};
  const byProgressState = splitApprovedQueued(rawByProgressState, queuedByType);

  // Same performance rollup as listCampaigns, scoped to this one campaign.
  const performance = emptyPerformance();
  const perfActionRows = await db
    .select({ type: actions.type, count: sql<number>`count(*)::int` })
    .from(actions)
    .where(and(eq(actions.campaignId, id), eq(actions.result, 'success')))
    .groupBy(actions.type);
  for (const r of perfActionRows) {
    if (r.type === 'connect') performance.invitesSent = r.count;
    else if (r.type === 'message') performance.messagesSent = r.count;
  }
  const [accepted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.kind, 'invite_accepted'), eq(sql`${events.payload}->>'campaignId'`, id)));
  performance.invitesAccepted = accepted?.count ?? 0;
  const [replied] = await db
    .select({ count: sql<number>`count(distinct ${messages.targetId})::int` })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(and(eq(targets.campaignId, id), eq(messages.direction, 'inbound')));
  performance.replies = replied?.count ?? 0;

  return {
    id: campaign.id,
    goal: campaign.goal,
    owner: campaign.owner,
    autonomyLevel: campaign.autonomyLevel,
    messageStrategy: campaign.messageStrategy,
    targetCount: total,
    byStage,
    byProgressState,
    // Derived from the raw histogram: awaiting_approval is an active lifecycle
    // state, and the split only reshapes what the funnel renders (see listCampaigns).
    status: deriveStatus(rawByProgressState),
    pendingCount: pending?.count ?? 0,
    enrolledCount,
    steps,
    performance,
  };
}

// A pending approval is a draft outbound message with its ActRequest binding
// still attached (pending_req). The binding is what the runtime dispatches on
// approve, so its message id doubles as the MCP pendingId; a draft without one
// is un-approvable and is not "pending". Reused by every pending count/list so
// the UI, the per-lead flag, and the live MCP list_pending all agree.
function pendingDraftFilter() {
  return and(
    eq(messages.status, 'draft'),
    eq(messages.direction, 'outbound'),
    isNotNull(messages.pendingReq),
  );
}

// The subset of a target's external_context blob the UI shows. Every field is
// optional (free-tier sourcing fills what it can), so read defensively.
interface LeadContext {
  name?: unknown;
  headline?: unknown;
  profileUrl?: unknown;
  company?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// name / company / headline / profileUrl pulled from the external_context blob.
// Company falls back to extractCompany(headline) when not explicitly present.
export function readLeadContext(raw: unknown): {
  name: string | null;
  company: string | null;
  headline: string | null;
  profileUrl: string | null;
  score: number | null;
  offIcp: boolean;
} {
  const ec = (raw ?? {}) as LeadContext;
  const headline = str(ec.headline);
  const { score, offIcp } = readIcpScore(raw);
  return {
    name: str(ec.name),
    company: str(ec.company) ?? extractCompany(headline ?? undefined) ?? null,
    headline,
    profileUrl: str(ec.profileUrl),
    score,
    offIcp,
  };
}

export interface Lead {
  targetId: string;
  name: string | null;
  company: string | null;
  headline: string | null;
  profileUrl: string | null;
  /** ICP fit score carried from the source list onto the target, or null. */
  score: number | null;
  /** Advisory below-threshold flag, for badging off-ICP targets in the funnel. */
  offIcp: boolean;
  stage: string;
  progressState: string | null;
  currentStep: number | null;
  /** Type of the step the cursor is about to run (e.g. "message", "connect"),
   * so the UI can say "Message in 22h" rather than a bare "next step". */
  nextStepType: string | null;
  nextStepAt: string | null;
  lastStepAt: string | null;
  errorMessage: string | null;
  lastAction: { type: string; result: string; executedAt: string | null } | null;
  pendingMessageId: string | null;
  /** True when the cursor sits at awaiting_approval with no pending draft yet an
   * outbound message already approved: the human approved and the send is only
   * waiting on the dispatch pacer ("send queued", not "needs approval"). */
  approvedQueued: boolean;
  /** The pending_req type of the approved-but-paced outbound item ("message" /
   * "connect"), so the UI can name the queued action ("Message queued" vs "Invite
   * queued"). Null when approvedQueued is false. */
  queuedActionType: string | null;
}

// A lead is "send queued" (approved, waiting on the dispatch pacer) rather than
// "needs approval" when its cursor sits at awaiting_approval, it has no pending
// draft to approve, yet an outbound message is already approved. Pure so the
// derivation is unit-testable.
export function deriveApprovedQueued(
  progressState: string | null,
  hasPendingDraft: boolean,
  hasApprovedMessage: boolean,
): boolean {
  return progressState === 'awaiting_approval' && !hasPendingDraft && hasApprovedMessage;
}

// Targets in a campaign with at least one approved outbound message, plus the
// action type of that approved item (pending_req->>'type': "message"/"connect"/…)
// so a queued send can be named for what it actually is. Isolated so a test can
// assert its SQL shape without a live DB (see buildVolumeQuery), and grouped like
// pendingRows so one round-trip covers the whole campaign.
export function buildApprovedMessagesQuery(campaignId: string) {
  return db
    .select({
      targetId: messages.targetId,
      queuedActionType: sql<string | null>`max(${messages.pendingReq} ->> 'type')`,
    })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(
      and(
        eq(targets.campaignId, campaignId),
        eq(messages.direction, 'outbound'),
        eq(messages.status, 'approved'),
      ),
    )
    .groupBy(messages.targetId);
}

// Per-campaign, per-target breakdown of approved-queued leads at awaiting_approval:
// a cursor parked at awaiting_approval whose outbound message is already approved
// and which has no pending draft left to approve (the SQL twin of
// deriveApprovedQueued). Each row carries the approved item's action type so the
// caller can bucket it as message_queued vs invite_queued. One row per target
// (grouped, action type collapsed with max). Optional campaignId narrows to one.
// Isolated so a test can assert its SQL shape without a live DB.
export function buildApprovedQueuedCountsQuery(campaignId?: string) {
  // A raw NOT EXISTS on a second reference to `messages`: emit the base table with
  // its alias (`"messages" "draft"`) explicitly, since a raw sql fragment has no
  // FROM clause to register the alias the way the query builder would.
  const draft = alias(messages, 'draft');
  const noPendingDraft = sql`not exists (select 1 from ${messages} ${draft} where ${draft.targetId} = ${targetProgress.targetId} and ${draft.direction} = 'outbound' and ${draft.status} = 'draft' and ${draft.pendingReq} is not null)`;
  const conditions = [
    eq(targetProgress.state, 'awaiting_approval'),
    eq(messages.direction, 'outbound'),
    eq(messages.status, 'approved'),
    noPendingDraft,
  ];
  if (campaignId) conditions.push(eq(targetProgress.campaignId, campaignId));
  return db
    .select({
      campaignId: targetProgress.campaignId,
      targetId: targetProgress.targetId,
      actionType: sql<string | null>`max(${messages.pendingReq} ->> 'type')`,
    })
    .from(targetProgress)
    .innerJoin(messages, eq(messages.targetId, targetProgress.targetId))
    .where(and(...conditions))
    .groupBy(targetProgress.campaignId, targetProgress.targetId);
}

// Redistribute the approved-queued slice out of the raw awaiting_approval bucket
// into action-specific message_queued / invite_queued buckets, so the funnel
// stops claiming "needs approval" for leads whose message a human already
// approved (it is only waiting on the send pacer). `queuedByType` is a per-action-
// type count of approved-queued leads keyed by pending_req type; a connect buckets
// as invite_queued, anything else (message, or a missing type) as message_queued.
// Pure and shared by listCampaigns + getCampaign so the two views can't drift.
export function splitApprovedQueued(
  byProgressState: Record<string, number>,
  queuedByType: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...byProgressState };
  let moved = 0;
  for (const [type, n] of Object.entries(queuedByType)) {
    if (n <= 0) continue;
    const bucket = type === 'connect' ? 'invite_queued' : 'message_queued';
    out[bucket] = (out[bucket] ?? 0) + n;
    moved += n;
  }
  if (moved > 0) {
    const remaining = (out.awaiting_approval ?? 0) - moved;
    if (remaining > 0) out.awaiting_approval = remaining;
    else delete out.awaiting_approval;
  }
  return out;
}

// Roll approved-queued count rows (buildApprovedQueuedCountsQuery) up per campaign
// into the per-type shape splitApprovedQueued consumes. A null action type falls
// back to "message" so it buckets as message_queued.
function queuedTypeCountsByCampaign(
  rows: Array<{ campaignId: string; actionType: string | null }>,
): Map<string, Record<string, number>> {
  const byCampaign = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const type = r.actionType ?? 'message';
    const entry = byCampaign.get(r.campaignId) ?? {};
    entry[type] = (entry[type] ?? 0) + 1;
    byCampaign.set(r.campaignId, entry);
  }
  return byCampaign;
}

// Per-progressState sort rank; anything unlisted (incl. no cursor) sorts last.
const LEAD_STATE_ORDER = [
  'awaiting_approval',
  // Approved-but-paced buckets sort with awaiting_approval (same raw cursor).
  'message_queued',
  'invite_queued',
  'in_progress',
  'awaiting_connection',
  'pending',
  'replied',
  'completed',
  'failed',
  'skipped',
];

function leadStateRank(state: string | null): number {
  const i = state ? LEAD_STATE_ORDER.indexOf(state) : -1;
  return i === -1 ? LEAD_STATE_ORDER.length : i;
}

// Normalize a state key for filtering: case-insensitive, spaces↔underscores
// collapsed ("Awaiting Approval" == "awaiting_approval").
function normalizeStateKey(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '_');
}

// The funnel-segment key a lead falls under: its raw progress state (or stage when
// unenrolled), except an approved-queued awaiting_approval lead reports the action-
// specific message_queued / invite_queued bucket the histogram split put it in.
// Mirrors splitApprovedQueued so a funnel click and the histogram agree; the client
// LeadsTable.leadFilterKey mirrors this across the package boundary.
export function leadFunnelBucket(
  l: Pick<Lead, 'progressState' | 'stage' | 'approvedQueued' | 'queuedActionType'>,
): string {
  if (l.progressState === 'awaiting_approval' && l.approvedQueued) {
    return l.queuedActionType === 'connect' ? 'invite_queued' : 'message_queued';
  }
  return l.progressState ?? l.stage;
}

/**
 * Per-lead drill-down for one campaign: every target joined to its enrollment
 * cursor, its most-recent action, and any pending draft message. Optional filter
 * matches a target's progress state OR its stage (case-insensitive, spaces and
 * underscores interchangeable). Sorted by progress-state priority, then soonest
 * next step (nulls last), then name.
 */
export async function getCampaignLeads(campaignId: string, stateFilter?: string): Promise<Lead[]> {
  const rows = await db
    .select({
      targetId: targets.id,
      externalContext: targets.externalContext,
      stage: targets.stage,
      progressState: targetProgress.state,
      currentStep: targetProgress.currentStep,
      nextStepAt: targetProgress.nextStepAt,
      lastStepAt: targetProgress.lastStepAt,
      errorMessage: targetProgress.errorMessage,
    })
    .from(targets)
    .leftJoin(targetProgress, eq(targetProgress.targetId, targets.id))
    .where(eq(targets.campaignId, campaignId));

  // Most-recent action per target (by executed-else-scheduled time), one row each.
  const ordering = sql`coalesce(${actions.executedAt}, ${actions.scheduledAt})`;
  const actionRows = await db
    .selectDistinctOn([actions.targetId], {
      targetId: actions.targetId,
      type: actions.type,
      result: actions.result,
      executedAt: actions.executedAt,
    })
    .from(actions)
    .where(eq(actions.campaignId, campaignId))
    .orderBy(actions.targetId, desc(ordering));
  const lastActionByTarget = new Map(actionRows.map((a) => [a.targetId, a]));

  // Pending draft message id per target (newest first, keep the first seen).
  const pendingRows = await db
    .select({ targetId: messages.targetId, id: messages.id })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(and(eq(targets.campaignId, campaignId), pendingDraftFilter()))
    .orderBy(desc(messages.createdAt));
  const pendingByTarget = new Map<string, string>();
  for (const p of pendingRows)
    if (!pendingByTarget.has(p.targetId)) pendingByTarget.set(p.targetId, p.id);

  // Targets whose latest human step already produced an approved outbound
  // message; combined with an awaiting_approval cursor and no pending draft this
  // is the "send queued" state (see deriveApprovedQueued).
  const approvedRows = await buildApprovedMessagesQuery(campaignId);
  const approvedTargets = new Set(approvedRows.map((a) => a.targetId));
  const approvedTypeByTarget = new Map(approvedRows.map((a) => [a.targetId, a.queuedActionType]));

  // The campaign's enabled steps in order; the cursor's currentStep indexes into
  // this list, so steps[currentStep] is the step about to run.
  const stepRows = await db
    .select({ stepType: campaignSteps.stepType, enabled: campaignSteps.enabled })
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, campaignId))
    .orderBy(asc(campaignSteps.stepOrder));
  const enabledStepTypes = stepRows.filter((s) => s.enabled).map((s) => s.stepType);

  const leads: Lead[] = rows.map((r) => {
    const ctx = readLeadContext(r.externalContext);
    const action = lastActionByTarget.get(r.targetId);
    const nextStepType =
      r.currentStep !== null && r.currentStep >= 0
        ? (enabledStepTypes[r.currentStep] ?? null)
        : null;
    const approvedQueued = deriveApprovedQueued(
      r.progressState ?? null,
      pendingByTarget.has(r.targetId),
      approvedTargets.has(r.targetId),
    );
    return {
      targetId: r.targetId,
      name: ctx.name,
      company: ctx.company,
      headline: ctx.headline,
      profileUrl: ctx.profileUrl,
      score: ctx.score,
      offIcp: ctx.offIcp,
      stage: r.stage,
      progressState: r.progressState ?? null,
      currentStep: r.currentStep ?? null,
      nextStepType,
      nextStepAt: r.nextStepAt ? r.nextStepAt.toISOString() : null,
      lastStepAt: r.lastStepAt ? r.lastStepAt.toISOString() : null,
      errorMessage: r.errorMessage ?? null,
      lastAction: action
        ? {
            type: action.type,
            result: action.result,
            executedAt: action.executedAt ? action.executedAt.toISOString() : null,
          }
        : null,
      pendingMessageId: pendingByTarget.get(r.targetId) ?? null,
      approvedQueued,
      queuedActionType: approvedQueued ? (approvedTypeByTarget.get(r.targetId) ?? null) : null,
    };
  });

  const filtered = stateFilter
    ? leads.filter((l) => {
        const key = normalizeStateKey(stateFilter);
        // Match the funnel bucket (covers the split message_queued / invite_queued
        // keys and keeps awaiting_approval to true drafts), then fall back to stage.
        return normalizeStateKey(leadFunnelBucket(l)) === key || normalizeStateKey(l.stage) === key;
      })
    : leads;

  filtered.sort((a, b) => {
    const rank = leadStateRank(a.progressState) - leadStateRank(b.progressState);
    if (rank !== 0) return rank;
    // Secondary: soonest next step first, nulls last.
    if (a.nextStepAt !== b.nextStepAt) {
      if (a.nextStepAt === null) return 1;
      if (b.nextStepAt === null) return -1;
      return a.nextStepAt < b.nextStepAt ? -1 : 1;
    }
    return (a.name ?? '').localeCompare(b.name ?? '');
  });

  return filtered;
}

export interface Pending {
  messageId: string;
  campaignId: string | null;
  campaignGoal: string | null;
  targetId: string;
  name: string | null;
  company: string | null;
  profileUrl: string | null;
  body: string;
  intent: string | null;
  accountId: string;
  createdAt: string;
}

/**
 * Pending message approvals (draft outbound with a live binding), joined to
 * their target and campaign. Optional campaignId narrows to one campaign. Newest
 * first. Each messageId is the pendingId for the MCP approve/reject tools.
 */
export async function getPending(campaignId?: string): Promise<Pending[]> {
  const where = campaignId
    ? and(eq(targets.campaignId, campaignId), pendingDraftFilter())
    : pendingDraftFilter();
  const rows = await db
    .select({
      messageId: messages.id,
      campaignId: targets.campaignId,
      campaignGoal: campaigns.goal,
      targetId: messages.targetId,
      externalContext: targets.externalContext,
      body: messages.body,
      intent: messages.intent,
      accountId: messages.accountId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .innerJoin(campaigns, eq(targets.campaignId, campaigns.id))
    .where(where)
    .orderBy(desc(messages.createdAt));

  return rows.map((r) => {
    const ctx = readLeadContext(r.externalContext);
    return {
      messageId: r.messageId,
      campaignId: r.campaignId,
      campaignGoal: r.campaignGoal,
      targetId: r.targetId,
      name: ctx.name,
      company: ctx.company,
      profileUrl: ctx.profileUrl,
      body: r.body,
      intent: r.intent ?? null,
      accountId: r.accountId,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** One persisted message rendered in the unified inbox. The inbox deliberately
 * reads only our local audit history: opening the web app must not open a
 * LinkedIn session or perform a live inbox read. */
export interface InboxMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  status: string;
  intent: string | null;
  createdAt: string;
  /** Present only for a draft the operator can approve or reject. */
  pendingMessageId: string | null;
  /** When this follow-up becomes eligible to enter the send queue. Null means
   * it is eligible now. This is intentionally not a promise that it will send
   * at that exact moment: approval and send-window pacing still apply. */
  eligibleAt: string | null;
}

export interface InboxThread {
  /** Account + target, not threadRef: outbound drafts start with a local
   * pending:<account>:<target> ref before LinkedIn assigns a thread urn. */
  id: string;
  accountId: string;
  targetId: string;
  name: string | null;
  company: string | null;
  headline: string | null;
  profileUrl: string | null;
  campaignGoal: string | null;
  latestAt: string;
  latestPreview: string;
  hasInbound: boolean;
  needsApproval: boolean;
  messages: InboxMessage[];
}

type InboxRow = {
  messageId: string;
  accountId: string;
  targetId: string;
  externalContext: unknown;
  campaignGoal: string | null;
  direction: 'inbound' | 'outbound';
  body: string;
  status: string;
  intent: string | null;
  pendingReq: unknown;
  nextStepAt?: Date | null;
  createdAt: Date;
};

/** Group an ordered audit stream into people-centric conversations. Exported so
 * the key invariant stays unit-testable without a database: never split a
 * conversation just because LinkedIn has not assigned the outbound a thread
 * urn yet. */
export function groupInboxRows(rows: InboxRow[]): InboxThread[] {
  const threads = new Map<string, InboxThread>();
  for (const row of rows) {
    // Cancelled drafts are audit records, not conversation events. Showing them
    // in the operator inbox makes a discarded message look like it was sent.
    if (row.status === 'cancelled') continue;
    const id = `${row.accountId}:${row.targetId}`;
    let thread = threads.get(id);
    if (!thread) {
      const ctx = readLeadContext(row.externalContext);
      thread = {
        id,
        accountId: row.accountId,
        targetId: row.targetId,
        name: ctx.name,
        company: ctx.company,
        headline: ctx.headline,
        profileUrl: ctx.profileUrl,
        campaignGoal: row.campaignGoal,
        latestAt: row.createdAt.toISOString(),
        latestPreview: row.body,
        hasInbound: false,
        needsApproval: false,
        messages: [],
      };
      threads.set(id, thread);
    }
    const canApprove =
      row.direction === 'outbound' && row.status === 'draft' && row.pendingReq != null;
    thread.messages.push({
      id: row.messageId,
      direction: row.direction,
      body: row.body,
      status: row.status,
      intent: row.intent,
      createdAt: row.createdAt.toISOString(),
      pendingMessageId: canApprove ? row.messageId : null,
      eligibleAt: canApprove && row.nextStepAt ? row.nextStepAt.toISOString() : null,
    });
    thread.hasInbound ||= row.direction === 'inbound';
    thread.needsApproval ||= canApprove;
    if (row.createdAt.getTime() >= new Date(thread.latestAt).getTime()) {
      thread.latestAt = row.createdAt.toISOString();
      thread.latestPreview = row.body;
    }
  }
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return [...threads.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

/** Every locally known conversation, newest first. This is intentionally a
 * read-only projection over the message audit trail. Inbound messages enter the
 * same trail when reply detection observes them. Cancelled drafts remain in the
 * audit log but are deliberately excluded from this operator-facing inbox. */
export async function getInbox(): Promise<InboxThread[]> {
  const rows = await db
    .select({
      messageId: messages.id,
      accountId: messages.accountId,
      targetId: messages.targetId,
      externalContext: targets.externalContext,
      campaignGoal: campaigns.goal,
      direction: messages.direction,
      body: messages.body,
      status: messages.status,
      intent: messages.intent,
      pendingReq: messages.pendingReq,
      nextStepAt: targetProgress.nextStepAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .innerJoin(campaigns, eq(targets.campaignId, campaigns.id))
    .leftJoin(targetProgress, eq(targetProgress.targetId, targets.id))
    .where(ne(messages.status, 'cancelled'))
    .orderBy(asc(messages.createdAt));
  return groupInboxRows(rows);
}

// --- Reply detector health --------------------------------------------------

export type ReplyDetectorStatus = 'healthy' | 'failing' | 'stale' | 'disabled' | 'never_run';

export interface ReplyDetectorHealth {
  status: ReplyDetectorStatus;
  /** The newest completed observation pass, not an estimate. */
  lastSuccessfulScanAt: string | null;
  /** A recent detector failure, if it has not since been followed by success. */
  error: { at: string; phase: string; message: string } | null;
  /** Current scan coverage from the newest successful pass. */
  coverage: {
    accounts: number;
    listedThreads: number;
    mappedThreads: number;
    unmatchedThreads: number;
    unmatchedInboundMessages: number;
  } | null;
}

type ReplyDetectorEventRow = { kind: string; ts: Date; payload: unknown };

const REPLY_DETECTOR_EVENTS = [
  'reply_detector_started',
  'reply_detector_idle',
  'reply_scan_succeeded',
  'reply_scan_failed',
] as const;

function eventObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function eventNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Read the detector's append-only health trail. The dashboard deliberately
 * does not infer health from the inbox count: zero replies can be healthy, an
 * unrun detector, or a failed LinkedIn read. */
export function deriveReplyDetectorHealth(
  rows: ReplyDetectorEventRow[],
  now = new Date(),
): ReplyDetectorHealth {
  const newest = (kind: (typeof REPLY_DETECTOR_EVENTS)[number]) =>
    rows.find((row) => row.kind === kind);
  const success = newest('reply_scan_succeeded');
  const failure = newest('reply_scan_failed');
  const started = newest('reply_detector_started');
  const idle = newest('reply_detector_idle');
  const successPayload = success ? eventObject(success.payload) : null;
  const failedAfterSuccess = !!failure && (!success || failure.ts.getTime() > success.ts.getTime());

  if (!success && !failure) {
    return {
      status:
        idle && (!started || idle.ts.getTime() > started.ts.getTime()) ? 'disabled' : 'never_run',
      lastSuccessfulScanAt: null,
      error: null,
      coverage: null,
    };
  }

  if (failedAfterSuccess && failure) {
    const payload = eventObject(failure.payload);
    return {
      status: 'failing',
      lastSuccessfulScanAt: success?.ts.toISOString() ?? null,
      error: {
        at: failure.ts.toISOString(),
        phase: typeof payload.phase === 'string' ? payload.phase : 'unknown',
        message: typeof payload.error === 'string' ? payload.error : 'Unknown detector error',
      },
      coverage: successPayload
        ? {
            accounts: eventNumber(successPayload, 'accounts'),
            listedThreads: eventNumber(successPayload, 'listedThreads'),
            mappedThreads: eventNumber(successPayload, 'mappedThreads'),
            unmatchedThreads: eventNumber(successPayload, 'unmatchedThreads'),
            unmatchedInboundMessages: eventNumber(successPayload, 'unmatchedInboundMessages'),
          }
        : null,
    };
  }

  const intervalMs = started ? eventNumber(eventObject(started.payload), 'intervalMs') : 0;
  const staleAfterMs = intervalMs > 0 ? intervalMs * 2 : 60 * 60 * 1000;
  return {
    status: success && now.getTime() - success.ts.getTime() > staleAfterMs ? 'stale' : 'healthy',
    lastSuccessfulScanAt: success?.ts.toISOString() ?? null,
    error: null,
    coverage: successPayload
      ? {
          accounts: eventNumber(successPayload, 'accounts'),
          listedThreads: eventNumber(successPayload, 'listedThreads'),
          mappedThreads: eventNumber(successPayload, 'mappedThreads'),
          unmatchedThreads: eventNumber(successPayload, 'unmatchedThreads'),
          unmatchedInboundMessages: eventNumber(successPayload, 'unmatchedInboundMessages'),
        }
      : null,
  };
}

export async function getReplyDetectorHealth(now = new Date()): Promise<ReplyDetectorHealth> {
  const rows = await db
    .select({ kind: events.kind, ts: events.ts, payload: events.payload })
    .from(events)
    .where(inArray(events.kind, [...REPLY_DETECTOR_EVENTS]))
    .orderBy(desc(events.ts))
    .limit(32);
  return deriveReplyDetectorHealth(rows, now);
}

export interface ActivityItem {
  actionId: string;
  type: string;
  result: string;
  executedAt: string | null;
  scheduledAt: string;
  targetId: string;
  name: string | null;
  profileUrl: string | null;
  campaignId: string | null;
  /** Why a failed action failed (from the matching action_failed event), for a
   * hover tooltip on the result chip. Null when the action did not fail. */
  failureDetail: string | null;
}

// Reverse-chron outbound action rows for the activity feed, newest first, with
// the target's name + profileUrl pulled from external_context. Isolated so a
// test can assert its SQL shape (incl. the profileUrl projection) without a live
// DB (see buildVolumeQuery).
export function buildActivityActionsQuery(opts: { campaignId?: string; limit: number }) {
  const ordering = sql`coalesce(${actions.executedAt}, ${actions.scheduledAt})`;
  return db
    .select({
      actionId: actions.id,
      type: actions.type,
      result: actions.result,
      executedAt: actions.executedAt,
      scheduledAt: actions.scheduledAt,
      targetId: actions.targetId,
      campaignId: actions.campaignId,
      name: sql<string | null>`${targets.externalContext}->>'name'`,
      profileUrl: sql<string | null>`${targets.externalContext}->>'profileUrl'`,
      // The reason string the executor recorded when this action failed. It lives
      // in the action_failed event payload (keyed by actionId), not on the action
      // row, so correlate the latest such event here. Null for non-failed actions.
      failureDetail: sql<string | null>`(
        select ${events.payload}->>'detail'
        from ${events}
        where ${events.kind} like 'action_failed%'
          and ${events.payload}->>'actionId' = ${actions.id}::text
        order by ${events.ts} desc
        limit 1
      )`,
    })
    .from(actions)
    .innerJoin(targets, eq(actions.targetId, targets.id))
    .where(opts.campaignId ? eq(actions.campaignId, opts.campaignId) : undefined)
    .orderBy(desc(ordering))
    .limit(opts.limit);
}

/** Received LinkedIn messages are activity in their own right, rather than an
 * inferred side effect of a funnel stage. Keep each message in the timeline,
 * while campaign performance separately counts distinct replying targets. */
export function buildReplyActivityQuery(opts: { campaignId?: string; limit: number }) {
  return db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      targetId: messages.targetId,
      campaignId: targets.campaignId,
      name: sql<string | null>`${targets.externalContext}->>'name'`,
      profileUrl: sql<string | null>`${targets.externalContext}->>'profileUrl'`,
    })
    .from(messages)
    .innerJoin(targets, eq(messages.targetId, targets.id))
    .where(
      and(
        eq(messages.direction, 'inbound'),
        ...(opts.campaignId ? [eq(targets.campaignId, opts.campaignId)] : []),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(opts.limit);
}

/**
 * Reverse-chron feed of what happened, newest first: outbound actions AND
 * inbound milestones: invite accepts and received replies show up alongside
 * sends. Neither is an action row, so they are projected from their durable
 * event/message records. Optional campaignId narrows every source. limit is
 * clamped by the caller (default 50, max 200).
 */
export async function getActivity(opts: {
  campaignId?: string;
  limit: number;
}): Promise<ActivityItem[]> {
  const actionRows = await buildActivityActionsQuery(opts);
  const replyRows = await buildReplyActivityQuery(opts);

  // Acceptance events carry targetId/campaignId/name/profileUrl in their jsonb
  // payload — but older events were written without profileUrl, so fall back to
  // the target row's external_context (joined by the payload's targetId). The
  // join compares as text to avoid a cast error on any malformed payload id.
  const payloadCampaign = sql<string | null>`${events.payload}->>'campaignId'`;
  const acceptRows = await db
    .select({
      id: events.id,
      ts: events.ts,
      targetId: sql<string | null>`${events.payload}->>'targetId'`,
      campaignId: payloadCampaign,
      name: sql<
        string | null
      >`coalesce(${events.payload}->>'name', ${targets.externalContext}->>'name')`,
      profileUrl: sql<
        string | null
      >`coalesce(${events.payload}->>'profileUrl', ${targets.externalContext}->>'profileUrl')`,
    })
    .from(events)
    .leftJoin(targets, sql`${targets.id}::text = ${events.payload}->>'targetId'`)
    .where(
      opts.campaignId
        ? and(eq(events.kind, 'invite_accepted'), eq(payloadCampaign, opts.campaignId))
        : eq(events.kind, 'invite_accepted'),
    )
    .orderBy(desc(events.ts))
    .limit(opts.limit);

  const items: ActivityItem[] = [
    ...actionRows.map((r) => ({
      actionId: r.actionId,
      type: r.type,
      result: r.result,
      executedAt: r.executedAt ? r.executedAt.toISOString() : null,
      scheduledAt: r.scheduledAt.toISOString(),
      targetId: r.targetId,
      name: r.name,
      profileUrl: r.profileUrl,
      campaignId: r.campaignId,
      failureDetail: r.failureDetail,
    })),
    ...acceptRows.map((r) => ({
      actionId: r.id,
      type: 'invite_accepted',
      result: 'success',
      executedAt: r.ts.toISOString(),
      scheduledAt: r.ts.toISOString(),
      targetId: r.targetId ?? '',
      name: r.name,
      profileUrl: r.profileUrl ?? null,
      campaignId: r.campaignId,
      failureDetail: null,
    })),
    ...replyRows.map((r) => ({
      actionId: r.id,
      type: 'reply_received',
      result: 'success',
      executedAt: r.createdAt.toISOString(),
      scheduledAt: r.createdAt.toISOString(),
      targetId: r.targetId,
      name: r.name,
      profileUrl: r.profileUrl,
      campaignId: r.campaignId,
      failureDetail: null,
    })),
  ];

  // Merge both streams by time and cap at the requested limit.
  items.sort((a, b) => {
    const ta = new Date(a.executedAt ?? a.scheduledAt).getTime();
    const tb = new Date(b.executedAt ?? b.scheduledAt).getTime();
    return tb - ta;
  });
  return items.slice(0, opts.limit);
}

export interface ScheduledItem {
  targetId: string;
  campaignId: string;
  campaignGoal: string | null;
  name: string | null;
  profileUrl: string | null;
  /** The step about to run (connect / message / …), null if the cursor points past the flow. */
  nextStepType: string | null;
  /** When it becomes due. Null means due immediately (next dispatch tick). */
  nextStepAt: string | null;
  /** The cursor state: 'in_progress' fires on the clock; 'awaiting_approval' is a
   * drafted step that waits for approval before it sends. Lets the UI tell a
   * ready-to-fire send apart from one parked behind the approval gate. */
  state: string;
  /** Forecast of when this actually goes out, accounting for the per-type daily
   * cap and working hours: a due-now backlog does not all fire at once, so item N
   * past today's remaining budget is projected onto a later working day. Null
   * means "today's budget" (fires as capacity frees today). See
   * projectScheduledSends. */
  projectedAt: string | null;
  /** For an awaiting_approval cursor: true when its outbound message is already
   * APPROVED and only waiting for its send tick (no draft left to approve), false
   * when a draft is still pending the operator's approval. Lets the UI say
   * "sending soon" for what you already approved instead of "pending approval".
   * Always false for non-approval states. (SQL twin: deriveApprovedQueued.) */
  approvedQueued: boolean;
}

// ── Scheduled-send forecast ──────────────────────────────────────────────────
// The Scheduled table is a forecast of WHEN queued work goes out, not a dump of
// raw next_step_at. A backlog of due-now cursors (e.g. 60 overdue invites) does
// not fire at once — the safety gate paces it to the per-type daily cap within
// working hours, so item 21 really goes out tomorrow, item 41 the day after. This
// ladders each due-now cursor onto the earliest working day with spare cap,
// mirroring the runtime's StaggerAllocator / dueAfterDelay so the forecast tracks
// how dispatch will pace. (Deliberate duplication of runtime/src/dispatch logic;
// consolidate into @loa/shared when the read model and runtime share more.)

const PROJ_DAY_SECONDS = 86_400;

/** Local calendar-day bucket key (server-local, matching the runtime's clock). */
function projDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Working-window start `delaySeconds` out, skipping days off. Mirrors runtime
 * dueAfterDelay: sub-day delays stay exact; day-level snaps to hoursStart. */
function projWindowStart(now: Date, delaySeconds: number, s: AccountSchedule): Date | null {
  if (delaySeconds <= 0) return null;
  const raw = new Date(now.getTime() + delaySeconds * 1000);
  if (delaySeconds < PROJ_DAY_SECONDS) return raw;
  let d = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate(), s.hoursStart, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (s.days.includes(d.getDay())) return d;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, s.hoursStart, 0, 0, 0);
  }
  return d;
}

/** Hands out the earliest working day whose per-type occupancy is below the cap.
 * Day 0 yields null (today's budget); later days yield the working-window start. */
class DaySlotter {
  private readonly occ = new Map<string, number>();
  constructor(
    private readonly now: Date,
    private readonly cap: number,
    private readonly schedule: AccountSchedule,
    seed: Array<Date | null>,
  ) {
    for (const at of seed) this.bump(at !== null && at > now ? at : now);
  }
  private bump(d: Date): void {
    const k = projDayKey(d);
    this.occ.set(k, (this.occ.get(k) ?? 0) + 1);
  }
  next(): Date | null {
    for (let day = 0; ; day += 1) {
      const at =
        day === 0 ? null : projWindowStart(this.now, day * PROJ_DAY_SECONDS, this.schedule);
      const k = projDayKey(at ?? this.now);
      if ((this.occ.get(k) ?? 0) < Math.max(this.cap, 1)) {
        this.bump(at ?? this.now);
        return at;
      }
    }
  }
}

export interface ProjectableCursor {
  accountId: string | null;
  /** Action type of the next step (connect / message / …); drives which cap applies. */
  type: string | null;
  state: string;
  nextStepAt: Date | null;
}

export interface ProjectInputs {
  now: Date;
  /** Per-account caps + working-hours schedule. */
  configById: Map<string, { caps: Record<string, number>; schedule: AccountSchedule }>;
  /** Already-sent-today count per `${accountId}:${type}`, seeded onto day 0. */
  usedToday: Map<string, number>;
}

/**
 * Projected send time per cursor, in the SAME order as `cursors`. A cursor with a
 * real future next_step_at keeps it (its time is already known). A due-now cursor
 * (in_progress, null/past next_step_at) is laddered onto the earliest working day
 * whose per-type cap still has room. Null projectedAt = today's budget ("due now").
 * Callers should pass cursors in due-order (oldest first) so the earliest-waiting
 * gets the earliest slot.
 */
export function projectScheduledSends(
  cursors: ProjectableCursor[],
  { now, configById, usedToday }: ProjectInputs,
): Array<Date | null> {
  const keyOf = (acct: string, type: string) => `${acct}:${type}`;
  const isBacklog = (c: ProjectableCursor) =>
    c.state === 'in_progress' && (c.nextStepAt === null || c.nextStepAt <= now);

  // Seed each (account,type) slotter with today's already-used count plus every
  // fixed (non-backlog) cursor on its own day, so backlog never double-books a
  // slot a known send already holds.
  const seedByKey = new Map<string, Array<Date | null>>();
  for (const c of cursors) {
    const key = keyOf(c.accountId ?? '', c.type ?? '');
    if (!seedByKey.has(key)) {
      const used = usedToday.get(key) ?? 0;
      seedByKey.set(
        key,
        Array.from({ length: used }, () => now),
      );
    }
    if (!isBacklog(c) && c.nextStepAt) seedByKey.get(key)?.push(c.nextStepAt);
  }

  const slotters = new Map<string, DaySlotter>();
  const slotterFor = (acct: string, type: string): DaySlotter => {
    const key = keyOf(acct, type);
    let s = slotters.get(key);
    if (!s) {
      const cfg = configById.get(acct);
      const cap = cfg?.caps[type] ?? DEFAULT_CAPS[type as ActionType] ?? 20;
      const schedule = cfg?.schedule ?? DEFAULT_SCHEDULE;
      s = new DaySlotter(now, cap, schedule, seedByKey.get(key) ?? []);
      slotters.set(key, s);
    }
    return s;
  };

  return cursors.map((c) =>
    isBacklog(c) ? slotterFor(c.accountId ?? '', c.type ?? '').next() : c.nextStepAt,
  );
}

/**
 * What the runtime has queued: every enrollment cursor whose next step is a real
 * scheduled send — the `in_progress` cursors the dispatch tick fires on the clock
 * PLUS the `awaiting_approval` cursors holding a drafted message with its send
 * time — across all campaigns, soonest first (null next_step_at sorts first).
 * `awaiting_connection` is excluded on purpose: an invite waiting to be accepted
 * has no send time to schedule and would only add timeless rows to a table meant
 * to be read/filtered by when things go out. The step type comes from indexing
 * the campaign's enabled steps with the cursor's current_step — same derivation
 * as getCampaignLeads.
 */
export async function getScheduled(limit: number): Promise<ScheduledItem[]> {
  const rows = await db
    .select({
      targetId: targets.id,
      campaignId: targets.campaignId,
      campaignGoal: campaigns.goal,
      name: sql<string | null>`${targets.externalContext}->>'name'`,
      profileUrl: sql<string | null>`${targets.externalContext}->>'profileUrl'`,
      currentStep: targetProgress.currentStep,
      nextStepAt: targetProgress.nextStepAt,
      state: targetProgress.state,
      accountId: targetProgress.accountId,
    })
    .from(targetProgress)
    .innerJoin(targets, eq(targetProgress.targetId, targets.id))
    .innerJoin(campaigns, eq(targets.campaignId, campaigns.id))
    .where(inArray(targetProgress.state, ['in_progress', 'awaiting_approval']))
    .orderBy(sql`${targetProgress.nextStepAt} asc nulls first`)
    .limit(limit);

  // Enabled step types per involved campaign, in flow order.
  const campaignIds = [...new Set(rows.map((r) => r.campaignId))];
  const stepsByCampaign = new Map<string, string[]>();
  if (campaignIds.length > 0) {
    const stepRows = await db
      .select({
        campaignId: campaignSteps.campaignId,
        stepType: campaignSteps.stepType,
      })
      .from(campaignSteps)
      .where(and(inArray(campaignSteps.campaignId, campaignIds), eq(campaignSteps.enabled, true)))
      .orderBy(asc(campaignSteps.stepOrder));
    for (const s of stepRows) {
      const list = stepsByCampaign.get(s.campaignId) ?? [];
      list.push(s.stepType);
      stepsByCampaign.set(s.campaignId, list);
    }
  }

  const typeOf = (r: (typeof rows)[number]): string | null =>
    r.currentStep !== null && r.currentStep >= 0
      ? (stepsByCampaign.get(r.campaignId)?.[r.currentStep] ?? null)
      : null;

  // Forecast inputs: per-account caps + schedule, and how much each type has
  // already sent today (which eats into today's budget before the backlog does).
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((a): a is string => !!a))];
  const configById = new Map<string, { caps: Record<string, number>; schedule: AccountSchedule }>();
  const usedToday = new Map<string, number>();
  if (accountIds.length > 0) {
    const acctRows = await db
      .select({ id: accounts.id, limits: accounts.limits })
      .from(accounts)
      .where(inArray(accounts.id, accountIds));
    for (const a of acctRows) {
      const lim = (a.limits ?? {}) as Partial<AccountLimits>;
      configById.set(a.id, {
        caps: lim.caps ?? DEFAULT_CAPS,
        schedule: lim.schedule ?? DEFAULT_SCHEDULE,
      });
    }
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const usedRows = await db
      .select({
        accountId: actions.accountId,
        type: actions.type,
        n: sql<number>`cast(count(*) as int)`,
      })
      .from(actions)
      .where(
        and(
          eq(actions.result, 'success'),
          gte(actions.executedAt, midnight),
          inArray(actions.accountId, accountIds),
        ),
      )
      .groupBy(actions.accountId, actions.type);
    for (const u of usedRows) usedToday.set(`${u.accountId}:${u.type}`, u.n);
  }

  const projected = projectScheduledSends(
    rows.map((r) => ({
      accountId: r.accountId,
      type: typeOf(r),
      state: r.state,
      nextStepAt: r.nextStepAt,
    })),
    { now: new Date(), configById, usedToday },
  );

  // Which awaiting_approval cursors are actually APPROVED-and-queued (message
  // already approved, no draft left to approve) vs still pending the operator.
  // Same SQL as the leads view's approved-queued split, so the two agree.
  const approvedQueuedTargets = new Set(
    (await buildApprovedQueuedCountsQuery()).map((r) => r.targetId),
  );

  return rows.map((r, i) => ({
    targetId: r.targetId,
    campaignId: r.campaignId,
    campaignGoal: r.campaignGoal,
    name: r.name,
    profileUrl: r.profileUrl,
    nextStepType: typeOf(r),
    nextStepAt: r.nextStepAt ? r.nextStepAt.toISOString() : null,
    state: r.state,
    projectedAt: projected[i] ? (projected[i] as Date).toISOString() : null,
    approvedQueued: approvedQueuedTargets.has(r.targetId),
  }));
}

export interface ErrorItem {
  /** Where the row came from: an events-table failure kind, or a failed action. */
  source: 'event' | 'action';
  /** For events, the event kind (reply_probe_failed, ...); for actions, the
   * action type prefixed so the two never collide in a histogram
   * (action_failed:connect). */
  kind: string;
  ts: string;
  campaignId: string | null;
  targetId: string | null;
  accountId: string | null;
  /** Human-readable context pulled from the payload (event detail / action type). */
  detail: string | null;
}

export interface ErrorsSummary {
  /** Trailing window this feed covers, echoed back for the caller. */
  hours: number;
  total: number;
  /** Per-kind rollup: count and the window's first/last occurrence. */
  byKind: Array<{ kind: string; count: number; firstSeen: string; lastSeen: string }>;
}

export interface ErrorsResult {
  summary: ErrorsSummary;
  items: ErrorItem[];
}

// SQL predicate matching failure-ish event kinds by suffix (see
// FAILURE_EVENT_KIND_SUFFIXES). Underscore is a LIKE wildcard, so it is escaped
// to match a literal '_'. Built from the shared list so adding a new suffix is a
// one-line change that both this query and the ops-report script pick up.
export function failureKindPredicate(): SQL {
  const likes = FAILURE_EVENT_KIND_SUFFIXES.map(
    (suffix) => sql`${events.kind} LIKE ${`%\\${suffix}`} ESCAPE '\\'`,
  );
  // or() over one element returns that element; over many, the disjunction.
  return (likes.length === 1 ? likes[0] : or(...likes)) as SQL;
}

// The failure-events query, isolated so a test can assert its SQL shape without a
// live DB. Reverse-chron events whose kind is failure-ish, within the trailing
// window.
export function buildErrorEventsQuery(hours: number) {
  const since = sql`now() - (${hours} * interval '1 hour')`;
  return db
    .select({
      id: events.id,
      ts: events.ts,
      kind: events.kind,
      accountId: events.accountId,
      campaignId: sql<string | null>`${events.payload}->>'campaignId'`,
      targetId: sql<string | null>`${events.payload}->>'targetId'`,
      detail: sql<string | null>`${events.payload}->>'detail'`,
    })
    .from(events)
    .where(and(gte(events.ts, since), failureKindPredicate()))
    .orderBy(desc(events.ts));
}

// The failed-actions query, isolated for the same reason. Actions whose result is
// 'failed', within the trailing window (by executed-else-scheduled time).
export function buildFailedActionsQuery(hours: number) {
  const ts = sql`coalesce(${actions.executedAt}, ${actions.scheduledAt})`;
  const since = sql`now() - (${hours} * interval '1 hour')`;
  return db
    .select({
      id: actions.id,
      ts,
      type: actions.type,
      accountId: actions.accountId,
      campaignId: actions.campaignId,
      targetId: actions.targetId,
    })
    .from(actions)
    .where(and(eq(actions.result, 'failed'), gte(ts, since)))
    .orderBy(desc(ts));
}

/**
 * Ops/errors feed: a reverse-chron view of everything that went wrong in the last
 * `hours`, merged from two sources that today have no single home — failure-ish
 * events (reply_probe_failed and any *_failed / *_cancelled kind) and actions
 * that executed with result='failed'. Each item carries its campaign/target/
 * account context so an operator can trace a failure back to a lead without a
 * second query. A `summary` rolls the feed up by kind with first/last-seen so a
 * silent, repeating failure (the reply-probe incident) is one glance, not 200
 * scrolled rows.
 */
export async function getErrors(opts: { hours: number }): Promise<ErrorsResult> {
  const eventRows = await buildErrorEventsQuery(opts.hours);
  const actionRows = await buildFailedActionsQuery(opts.hours);

  const items: ErrorItem[] = [
    ...eventRows.map((r) => ({
      source: 'event' as const,
      kind: r.kind,
      ts: r.ts.toISOString(),
      campaignId: r.campaignId,
      targetId: r.targetId,
      accountId: r.accountId,
      detail: r.detail,
    })),
    ...actionRows.map((r) => ({
      source: 'action' as const,
      // Namespaced so a failed connect action doesn't merge into a connect event.
      kind: `action_failed:${r.type}`,
      ts: (r.ts as Date).toISOString(),
      campaignId: r.campaignId,
      targetId: r.targetId,
      accountId: r.accountId,
      detail: r.type,
    })),
  ];

  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  // Roll up by kind: count + first/last seen across the window.
  const rollup = new Map<string, { count: number; firstSeen: string; lastSeen: string }>();
  for (const it of items) {
    const cur = rollup.get(it.kind);
    if (!cur) {
      rollup.set(it.kind, { count: 1, firstSeen: it.ts, lastSeen: it.ts });
    } else {
      cur.count += 1;
      if (it.ts < cur.firstSeen) cur.firstSeen = it.ts;
      if (it.ts > cur.lastSeen) cur.lastSeen = it.ts;
    }
  }
  const byKind = [...rollup.entries()]
    .map(([kind, v]) => ({ kind, ...v }))
    .sort((a, b) => b.count - a.count);

  return {
    summary: { hours: opts.hours, total: items.length, byKind },
    items,
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

// Ordered delete statements that clear a campaign's dependents and then the
// campaign row itself. The campaigns table is referenced with ON DELETE NO
// ACTION from target_progress, actions, targets, and campaign_steps, and
// messages hang off the campaign's targets, so everything must go before the
// campaign row. Exposed (and parameterized on the executor) so a test can assert
// the SQL shape and order without a live DB; deleteCampaign runs them inside a
// transaction against tx. Order: rows referencing targets (progress, actions,
// messages) first, then targets, then the campaign's steps, then the campaign.
export function campaignDeleteStatements(exec: Db, id: string) {
  const campaignTargets = db
    .select({ id: targets.id })
    .from(targets)
    .where(eq(targets.campaignId, id));
  return [
    exec.delete(targetProgress).where(eq(targetProgress.campaignId, id)),
    exec.delete(actions).where(eq(actions.campaignId, id)),
    exec.delete(messages).where(inArray(messages.targetId, campaignTargets)),
    exec.delete(targets).where(eq(targets.campaignId, id)),
    exec.delete(campaignSteps).where(eq(campaignSteps.campaignId, id)),
    exec.delete(campaigns).where(eq(campaigns.id, id)),
  ];
}

// Delete a campaign and every dependent row in one transaction. Returns false
// when no campaign with that id exists (so the route can answer 404).
export async function deleteCampaign(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, id));
    if (!campaign) return false;
    for (const stmt of campaignDeleteStatements(tx, id)) {
      await stmt;
    }
    return true;
  });
}

export interface VolumeRow {
  day: string;
  type: string;
  count: number;
}

// The server's IANA timezone (e.g. "America/Los_Angeles"), resolved once. Day
// buckets are cut on this zone's calendar so the chart lines up with the
// machine-local clock the runtime schedules against — not UTC, which would open
// a "tomorrow" bar after 5pm Pacific. Sanitized to the IANA charset because it
// is inlined as a SQL literal below (not a bound param): the day expression must
// be byte-identical across SELECT/GROUP BY/ORDER BY for Postgres to accept the
// grouping, which a `$n` placeholder breaks.
const SERVER_TZ =
  (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').replace(/[^A-Za-z0-9_/+-]/g, '') ||
  'UTC';

// Build the volume aggregation query. Isolated so a test can assert the SQL
// shape without a live DB. Counts successful actions per calendar day per type,
// over the trailing `days` window, optionally filtered to one account. Days are
// bucketed in the server's local timezone (SERVER_TZ), so the boundary matches
// what the operator sees as "today".
export function buildVolumeQuery(opts: { accountId?: string; days: number }) {
  const since = sql`now() - (${opts.days} * interval '1 day')`;
  const conditions = [
    eq(actions.result, 'success'),
    gte(sql`coalesce(${actions.executedAt}, ${actions.scheduledAt})`, since),
  ];
  if (opts.accountId) {
    conditions.push(eq(actions.accountId, opts.accountId));
  }
  // `AT TIME ZONE` converts the stored timestamptz to local wall-clock time in
  // SERVER_TZ before truncating, so the calendar day is the local one. The zone
  // is inlined via sql.raw (SERVER_TZ is sanitized above) so the expression is
  // identical everywhere it appears — a bound param renders as $1/$4/$5 and
  // Postgres then rejects the GROUP BY.
  const tz = sql.raw(`'${SERVER_TZ}'`);
  const day = sql<string>`to_char(date_trunc('day', coalesce(${actions.executedAt}, ${actions.scheduledAt}) AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;
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
  limits: AccountLimits;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      handle: accounts.handle,
      state: accounts.state,
      limits: accounts.limits,
    })
    .from(accounts)
    .orderBy(asc(accounts.handle));
  // Legacy rows created before the limits column backfill to the default so the
  // UI always has caps to render and edit.
  return rows.map((r) => ({
    ...r,
    limits: (r.limits as AccountLimits | null) ?? defaultLimits(),
  }));
}

/** Thrown when a limits patch fails validation. The route maps this to a 400. */
export class LimitsError extends Error {}

/**
 * Coerce arbitrary input into a valid caps map: every action type present, each
 * a non-negative integer. Rejects unknown keys, negatives, and non-integers so
 * a bad edit can never write a nonsense cap.
 */
function validateCaps(input: unknown): Record<ActionType, number> {
  if (typeof input !== 'object' || input === null) {
    throw new LimitsError('caps must be an object of action -> daily limit.');
  }
  const raw = input as Record<string, unknown>;
  const out = {} as Record<ActionType, number>;
  for (const type of ACTION_TYPES) {
    const v = raw[type] ?? DEFAULT_CAPS[type];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new LimitsError(`cap for ${type} must be a non-negative integer.`);
    }
    out[type] = v;
  }
  return out;
}

/**
 * Coerce arbitrary input into a valid schedule: an 8am-8pm-style local-hour
 * window and a set of active weekdays (0=Sun..6=Sat). Rejects out-of-range
 * hours, a non-earlier start, and an empty/garbage day set so a bad edit can
 * never write a schedule that silently sends 24/7 or never sends.
 */
function validateSchedule(input: unknown): AccountSchedule {
  if (typeof input !== 'object' || input === null) {
    throw new LimitsError('schedule must be an object.');
  }
  const raw = input as Record<string, unknown>;
  const start = raw.hoursStart;
  const end = raw.hoursEnd;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start > 23) {
    throw new LimitsError('hoursStart must be an integer 0-23.');
  }
  if (typeof end !== 'number' || !Number.isInteger(end) || end < 1 || end > 24) {
    throw new LimitsError('hoursEnd must be an integer 1-24.');
  }
  if (end <= start) {
    throw new LimitsError('hoursEnd must be after hoursStart.');
  }
  if (!Array.isArray(raw.days)) {
    throw new LimitsError('days must be an array of weekday numbers (0-6).');
  }
  const days = [...new Set(raw.days)].filter(
    (d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6,
  );
  if (days.length === 0) {
    throw new LimitsError('at least one working day is required.');
  }
  days.sort((a, b) => a - b);
  return { hoursStart: start, hoursEnd: end, days };
}

/** Patch one account's editable automation limits: daily caps and, when
 * provided, the working-hours/days schedule. An omitted schedule is left
 * unchanged; passing one replaces it wholesale. */
export async function updateAccountLimits(
  accountId: string,
  caps: unknown,
  schedule?: unknown,
): Promise<AccountLimits> {
  const [existing] = await db
    .select({ limits: accounts.limits })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!existing) throw new LimitsError('unknown account.');
  const prev = (existing.limits as AccountLimits | null) ?? defaultLimits();

  const validated: AccountLimits = { caps: validateCaps(caps) };
  const nextSchedule = schedule !== undefined ? validateSchedule(schedule) : prev.schedule;
  if (nextSchedule) validated.schedule = nextSchedule;

  const [row] = await db
    .update(accounts)
    .set({ limits: validated, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning({ limits: accounts.limits });
  if (!row) throw new LimitsError('unknown account.');
  return row.limits as AccountLimits;
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
      state: 'Active',
      proxyBinding: { proxyId: `paste-${input.handle}`, region: 'local', sticky: false },
      health: { acceptanceRate: 0, replyRate: 0, challengesLast7d: 0, lastCheckedAt: new Date() },
      budget: { date: today, caps: { ...DEFAULT_CAPS }, used: emptyUsed() },
      limits: defaultLimits(),
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
  /** 0..100 ICP fit score read from external_context, or null when unscored. */
  score: number | null;
  scoreReasons: string[] | null;
  icp: string | null;
  /** Advisory below-threshold flag. */
  offIcp: boolean;
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

  const rows = await db
    .select({
      id: leadListMembers.id,
      linkedinUrn: leadListMembers.linkedinUrn,
      name: leadListMembers.name,
      headline: leadListMembers.headline,
      profileUrl: leadListMembers.profileUrl,
      degree: leadListMembers.degree,
      location: leadListMembers.location,
      currentCompany: leadListMembers.currentCompany,
      externalContext: leadListMembers.externalContext,
    })
    .from(leadListMembers)
    .where(eq(leadListMembers.listId, id))
    .orderBy(asc(leadListMembers.addedAt));

  const members: ListMember[] = rows.map(({ externalContext, ...m }) => {
    const { score, scoreReasons, icp, offIcp } = readIcpScore(externalContext);
    return { ...m, score, scoreReasons, icp, offIcp };
  });

  return { ...list, members };
}

// Delete a list (cascade removes its members). True when a row was removed.
export async function deleteList(id: string): Promise<boolean> {
  const deleted = await db
    .delete(leadLists)
    .where(eq(leadLists.id, id))
    .returning({ id: leadLists.id });
  return deleted.length > 0;
}

// Remove specific members from a list by member id. Scoped to the listId so a
// stray id from another list can't delete across lists. Returns how many rows
// were removed.
export async function deleteListMembers(
  listId: string,
  memberIds: string[],
): Promise<{ removed: number }> {
  if (memberIds.length === 0) return { removed: 0 };
  const removed = await db
    .delete(leadListMembers)
    .where(and(eq(leadListMembers.listId, listId), inArray(leadListMembers.id, memberIds)))
    .returning({ id: leadListMembers.id });
  return { removed: removed.length };
}

// Remove targets from a campaign (operator ejecting off-ICP or mistargeted
// people). A LOGICAL removal that mirrors the runtime's remove path: stop each
// active enrollment cursor (terminal 'skipped', not 'replied', so reply metrics
// stay honest) and cancel any approved-but-unsent message. The target row is
// kept for the audit trail. Scoped to the campaign, so a stray id can't touch
// another campaign. Returns { removed }.
export async function removeCampaignTargets(
  campaignId: string,
  targetIds: string[],
  reason = CAMPAIGN_TARGET_REMOVAL_REASON,
): Promise<{ removed: number }> {
  if (targetIds.length === 0) return { removed: 0 };
  return db.transaction(async (tx) => {
    // Only targets that actually belong to this campaign are eligible. Fetch the
    // stage too so the shared policy can split contacted from pre-contact targets.
    const owned = await tx
      .select({ id: targets.id, linkedinUrn: targets.linkedinUrn, stage: targets.stage })
      .from(targets)
      .where(and(eq(targets.campaignId, campaignId), inArray(targets.id, targetIds)));
    const ownedIds = owned.map((t) => t.id);
    if (ownedIds.length === 0) return { removed: 0 };

    // The removal decision (which targets go 'lost', the event payloads) is the
    // shared policy the runtime's remove path also runs; this transaction just
    // applies it via Drizzle.
    const plan = planCampaignTargetRemoval(campaignId, owned, reason);

    await tx
      .update(targetProgress)
      .set({ state: 'skipped', nextStepAt: null, errorMessage: plan.reason, updatedAt: new Date() })
      .where(
        and(
          inArray(targetProgress.targetId, ownedIds),
          inArray(targetProgress.state, [...ACTIVE_PROGRESS_STATES]),
        ),
      );

    await tx
      .update(messages)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          inArray(messages.targetId, ownedIds),
          eq(messages.direction, 'outbound'),
          inArray(messages.status, [...CANCELABLE_MESSAGE_STATUSES]),
        ),
      );

    // Mark the stage 'lost' ONLY for targets that were already contacted (the
    // policy filters these). getMetrics counts 'lost' in the invited bucket, so
    // using it on a pre-contact target would inflate invite metrics; those
    // targets are still fully stopped by the terminal 'skipped' cursor and
    // cancelled messages above, so their stage is left unchanged.
    if (plan.lostTargetIds.length > 0) {
      await tx
        .update(targets)
        .set({ stage: 'lost', updatedAt: new Date() })
        .where(inArray(targets.id, plan.lostTargetIds));
    }

    // Durable removal marker (mirrors the runtime's removeTargets). A never-
    // enrolled target has no progress row, so without this a later launch would
    // sweep it back into the funnel; launchCampaign skips marked targets.
    await tx
      .update(targets)
      .set({
        externalContext: sql`${targets.externalContext} || '{"removed": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(inArray(targets.id, ownedIds));

    // Append one audit event per removed target, the same kind the runtime writes.
    await tx.insert(events).values(
      plan.events.map((ev) => ({
        kind: ev.kind,
        accountId: ev.accountId,
        payload: ev.payload,
      })),
    );

    return { removed: ownedIds.length };
  });
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
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) throw new LaunchError('campaign not found');

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account) throw new LaunchError('unknown sender account; link an account first');

  const [stepCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignSteps)
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.enabled, true)));
  if (!stepCount || stepCount.n === 0) {
    throw new LaunchError('define a funnel (at least one enabled step) before launching');
  }

  // Targets an operator removed carry a `removed` marker in external_context;
  // launching must not sweep them back into the funnel.
  const targetRows = await db
    .select({ id: targets.id })
    .from(targets)
    .where(
      and(
        eq(targets.campaignId, campaignId),
        sql`NOT (${targets.externalContext} @> '{"removed": true}'::jsonb)`,
      ),
    );
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
