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
  defaultLimits,
  extractCompany,
  FAILURE_EVENT_KIND_SUFFIXES,
  planCampaignTargetRemoval,
  readIcpScore,
} from '@loa/shared';
import type { SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
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

  return rows.map((c) => {
    const counts = stageByCampaign.get(c.id) ?? { total: 0, byStage: {} };
    const byProgressState = progressByCampaign.get(c.id) ?? {};
    return {
      id: c.id,
      goal: c.goal,
      owner: c.owner,
      autonomyLevel: c.autonomyLevel,
      messageStrategy: c.messageStrategy,
      targetCount: counts.total,
      byStage: counts.byStage,
      byProgressState,
      status: deriveStatus(byProgressState),
      pendingCount: pendingByCampaign.get(c.id) ?? 0,
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
  const byProgressState: Record<string, number> = {};
  let enrolledCount = 0;
  for (const r of progressRows) {
    byProgressState[r.state] = r.count;
    enrolledCount += r.count;
  }

  return {
    id: campaign.id,
    goal: campaign.goal,
    owner: campaign.owner,
    autonomyLevel: campaign.autonomyLevel,
    messageStrategy: campaign.messageStrategy,
    targetCount: total,
    byStage,
    byProgressState,
    status: deriveStatus(byProgressState),
    pendingCount: pending?.count ?? 0,
    enrolledCount,
    steps,
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

// Targets in a campaign with at least one approved outbound message. Isolated so
// a test can assert its SQL shape without a live DB (see buildVolumeQuery), and
// grouped like pendingRows so one round-trip covers the whole campaign.
export function buildApprovedMessagesQuery(campaignId: string) {
  return db
    .select({ targetId: messages.targetId })
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

// Per-progressState sort rank; anything unlisted (incl. no cursor) sorts last.
const LEAD_STATE_ORDER = [
  'awaiting_approval',
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
      approvedQueued: deriveApprovedQueued(
        r.progressState ?? null,
        pendingByTarget.has(r.targetId),
        approvedTargets.has(r.targetId),
      ),
    };
  });

  const filtered = stateFilter
    ? leads.filter((l) => {
        const key = normalizeStateKey(stateFilter);
        return (
          (l.progressState !== null && normalizeStateKey(l.progressState) === key) ||
          normalizeStateKey(l.stage) === key
        );
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
    })
    .from(actions)
    .innerJoin(targets, eq(actions.targetId, targets.id))
    .where(opts.campaignId ? eq(actions.campaignId, opts.campaignId) : undefined)
    .orderBy(desc(ordering))
    .limit(opts.limit);
}

/**
 * Reverse-chron feed of what happened, newest first: outbound actions AND
 * inbound invite_accepted events, so an acceptance shows up alongside the sends
 * ("X accepted your invite"). An acceptance is not an action row, so it is
 * unioned in from the event log. Optional campaignId narrows both. limit is
 * clamped by the caller (default 50, max 200).
 */
export async function getActivity(opts: {
  campaignId?: string;
  limit: number;
}): Promise<ActivityItem[]> {
  const actionRows = await buildActivityActionsQuery(opts);

  // Acceptance events carry targetId/campaignId/name/profileUrl in their jsonb payload.
  const payloadCampaign = sql<string | null>`${events.payload}->>'campaignId'`;
  const acceptRows = await db
    .select({
      id: events.id,
      ts: events.ts,
      targetId: sql<string | null>`${events.payload}->>'targetId'`,
      campaignId: payloadCampaign,
      name: sql<string | null>`${events.payload}->>'name'`,
      profileUrl: sql<string | null>`${events.payload}->>'profileUrl'`,
    })
    .from(events)
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
