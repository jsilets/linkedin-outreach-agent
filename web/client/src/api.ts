// Small typed fetch wrapper around the JSON API. Same-origin /api works in dev
// (Vite proxy) and prod (express static server).

export const CAMPAIGN_STEP_TYPES = [
  'view_profile',
  'connect',
  'message',
  'follow',
  'react',
  'delay',
] as const;
export type CampaignStepType = (typeof CAMPAIGN_STEP_TYPES)[number];

export interface Step {
  id?: string;
  stepOrder: number;
  stepType: CampaignStepType;
  delaySeconds: number;
  note: string | null;
  body: string | null;
  reaction: string | null;
  enabled: boolean;
}

type CampaignStatus = 'draft' | 'active' | 'done';

export interface CampaignPerformance {
  invitesSent: number;
  /** Distinct targets with at least one successful invite — the people count
   * behind invitesSent, so `eligible - invitedTargets` is "invites still to go". */
  invitedTargets: number;
  invitesAccepted: number;
  /** Total message VOLUME: every successful message action, including follow-ups
   * to the same person. Not a population — do not divide replies by it. */
  messagesSent: number;
  /** Distinct targets that received at least one message. The denominator for
   * reply rate: `replies` counts distinct repliers, so both are populations. */
  messagedTargets: number;
  replies: number;
  /** Removed (skipped) leads bucketed by the furthest stage they reached before
   * we pulled them. Exit semantics: a lead removed after we invited it counts
   * through the stage it reached, then leaves the funnel, so it neither inflates
   * coverage nor drags the conversion rate of a stage it never got a chance at.
   * Absent (or all-zero) when nothing was removed after being invited. */
  removedByStage?: RemovedByStage;
}

/** Counts of removed leads by the furthest funnel stage each one reached. */
interface RemovedByStage {
  /** Reached invited, removed before accepting. */
  atInvited: number;
  /** Accepted, removed before we messaged. */
  atAccepted: number;
  /** Messaged, removed before a reply. */
  atMessaged: number;
  /** Replied, then removed (terminal; kept only for the invited denominator). */
  atReplied: number;
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
  // Headline funnel counts for the campaign's stat chips. Optional on the wire so
  // the UI renders before the server side lands; read defensively.
  performance: CampaignPerformance;
}

export interface CampaignDetail extends CampaignSummary {
  steps: Step[];
  enrolledCount: number;
}

export interface Lead {
  targetId: string;
  name: string | null;
  company: string | null;
  headline: string | null;
  profileUrl: string | null;
  score: number | null;
  offIcp: boolean;
  stage: string;
  progressState: string | null;
  currentStep: number | null;
  nextStepType: string | null;
  nextStepAt: string | null;
  lastStepAt: string | null;
  errorMessage: string | null;
  lastAction: { type: string; result: string; executedAt: string | null } | null;
  pendingMessageId: string | null;
  // The operator already approved this lead's message; it's only waiting on the
  // dispatch pacer / send window. Distinct from "still needs approval".
  approvedQueued: boolean;
  // The action the queued send will fire ("message" / "connect"), so the row can
  // name it ("Message soon" vs "Invite soon"). Null when approvedQueued is false.
  queuedActionType: string | null;
}

export interface Pending {
  messageId: string;
  campaignId: string | null;
  campaignGoal: string | null;
  targetId: string;
  name: string | null;
  company: string | null;
  body: string;
  intent: string | null;
  accountId: string;
  createdAt: string;
  profileUrl: string | null;
}

/** What has actually happened to a message, and when it will happen if it
 * hasn't yet. `createdAt` is the draft's birth time regardless of status, so it
 * answers none of those questions on its own. */
export type MessageTiming =
  | { kind: 'received'; at: string }
  | { kind: 'sent'; at: string }
  | { kind: 'queued_soon' }
  | { kind: 'queued_window'; at: string }
  | { kind: 'queued_capped'; at: string }
  /** The gate denies this account outright: nothing sends until a human resumes
   * it or lifts the state. No timestamp — none of these clear on a schedule. */
  | { kind: 'queued_blocked'; reason: 'paused' | 'restricted' | 'cooldown' | 'disabled' }
  | { kind: 'awaiting_approval'; readyAt: string | null };

export interface InboxMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  status: string;
  intent: string | null;
  createdAt: string;
  /** Present only when this is a live, sendable approval item. */
  pendingMessageId: string | null;
  /** When a pending follow-up becomes eligible to enter the send queue. Null
   * means it is eligible now; actual delivery remains subject to approval and
   * the account's pacing window. */
  eligibleAt: string | null;
  timing: MessageTiming;
}

export interface InboxThread {
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

export interface ReplyDetectorHealth {
  status: 'healthy' | 'failing' | 'stale' | 'disabled' | 'never_run';
  lastSuccessfulScanAt: string | null;
  error: { at: string; phase: string; message: string } | null;
  coverage: {
    accounts: number;
    listedThreads: number;
    mappedThreads: number;
    unmatchedThreads: number;
    unmatchedInboundMessages: number;
  } | null;
}

/** Whether the dispatch tick — the loop that actually sends queued messages — is
 * running. When it is not, every "Queued" label in the inbox is a lie. */
export interface DispatchHealth {
  status: 'running' | 'disabled' | 'never_run';
  intervalMs: number | null;
  lastStartedAt: string | null;
}

export interface ActivityItem {
  actionId: string;
  type: string;
  result: string;
  executedAt: string | null;
  scheduledAt: string;
  targetId: string;
  name: string | null;
  campaignId: string | null;
  profileUrl: string | null;
  /** For a failed action, the reason from the action_failed event (e.g. "email-gated"),
   * shown as a hover tooltip on the result chip. Null for successful/inbound rows. */
  failureDetail: string | null;
}

export interface BulkApproveResult {
  results: Array<{ messageId: string; ok: boolean; error?: string }>;
}

export interface ScheduledItem {
  targetId: string;
  campaignId: string;
  campaignGoal: string | null;
  name: string | null;
  profileUrl: string | null;
  nextStepType: string | null;
  nextStepAt: string | null;
  /** 'in_progress' fires on the clock; 'awaiting_approval' waits for approval. */
  state: string;
  /** Forecast send time accounting for daily caps + working hours (a due-now
   * backlog is laddered across future days). Null = today's budget. */
  projectedAt: string | null;
  /** awaiting_approval only: true = message already approved, just waiting to send
   * ("sending soon"); false = a draft still pending your approval. */
  approvedQueued: boolean;
}

export interface VolumeRow {
  day: string;
  type: string;
  count: number;
}

// The per-action daily caps an operator can edit. Mirrors the server's
// ActionType union; kept as a plain list so the UI can render one field each.
const ACTION_TYPES = [
  'connect',
  'message',
  'view_profile',
  'follow',
  'withdraw_invite',
  'react',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// When an account is allowed to act: a local-hour window and its active
// weekdays (0=Sun..6=Sat). Optional — absent means the server's default window.
export interface AccountSchedule {
  hoursStart: number;
  hoursEnd: number;
  days: number[];
}

export const DEFAULT_SCHEDULE: AccountSchedule = {
  hoursStart: 8,
  hoursEnd: 20,
  days: [0, 1, 2, 3, 4, 5, 6],
};

export interface AccountLimits {
  caps: Record<ActionType, number>;
  enabled?: Partial<Record<ActionType, boolean>>;
  schedule?: AccountSchedule;
  schedules?: Partial<Record<ActionType, AccountSchedule>>;
}

export interface Account {
  id: string;
  handle: string;
  state: string;
  limits: AccountLimits;
  /** Operator pause: the hardest stop in the system. While true the safety gate
   * denies every outbound action, so nothing queued can leave. */
  paused: boolean;
  /** Approved outbound messages waiting on the sender — what a pause is holding. */
  queuedMessageCount: number;
  /** Successful connects in the trailing 7 days. The gate checks this against
   * weeklyInviteCeiling on every connect, independently of the daily cap. */
  weeklyInvitesUsed: number;
  /** Rolling 7-day ceiling on invites. At it, connects defer to tomorrow. */
  weeklyInviteCeiling: number;
  /** Invites sent but not yet accepted. */
  outstandingInvites: number;
  /** Ceiling on unaccepted invites. At it, connects are DENIED rather than
   * deferred — the pile only drains by withdrawing stale invites. */
  outstandingInviteCeiling: number;
}

export interface ListSummary {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
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
  score: number | null;
  scoreReasons: string[] | null;
  icp: string | null;
  offIcp: boolean;
}

export interface ListDetail {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  members: ListMember[];
}

export interface CreateListResult {
  id: string;
  name: string;
  description: string | null;
}

export interface LinkAccountBody {
  handle: string;
  liAt: string;
  jsessionId: string;
}

export interface LinkAccountResult {
  ok: true;
  accountId: string;
  handle: string;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json() as Promise<T>;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json() as Promise<T>;
}

export const api = {
  campaigns: () => get<CampaignSummary[]>('/api/campaigns'),
  campaign: (id: string) => get<CampaignDetail>(`/api/campaigns/${id}`),
  leads: (id: string, state?: string) => {
    const q = state ? `?state=${encodeURIComponent(state)}` : '';
    return get<Lead[]>(`/api/campaigns/${id}/leads${q}`);
  },
  pending: (campaignId?: string) => {
    const q = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : '';
    return get<Pending[]>(`/api/pending${q}`);
  },
  inbox: () => get<InboxThread[]>('/api/inbox'),
  inboxHealth: () => get<ReplyDetectorHealth>('/api/inbox/health'),
  dispatchHealth: () => get<DispatchHealth>('/api/dispatch/health'),
  activity: (opts: { campaignId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.campaignId) params.set('campaignId', opts.campaignId);
    if (opts.limit) params.set('limit', String(opts.limit));
    const q = params.toString();
    return get<ActivityItem[]>(`/api/activity${q ? `?${q}` : ''}`);
  },
  approve: (messageId: string, body?: string) =>
    send<{ ok: true; action: unknown }>(
      `/api/pending/${messageId}/approve`,
      'POST',
      body ? { body } : {},
    ),
  reject: (messageId: string, reason: string) =>
    send<{ ok: true }>(`/api/pending/${messageId}/reject`, 'POST', { reason }),
  bulkApprove: (messageIds: string[]) =>
    send<BulkApproveResult>('/api/pending/approve', 'POST', { messageIds }),
  accounts: () => get<Account[]>('/api/accounts'),
  // No pause/resume client calls: Settings drives the per-action gates instead.
  // The account-wide pause remains the harder stop (it denies every action type
  // and backs kill_all) and is reached through the privileged MCP tools, which
  // deliberately bypass this HTTP path so they work when it is wedged.
  lists: () => get<ListSummary[]>('/api/lists'),
  getList: (id: string) => get<ListDetail>(`/api/lists/${id}`),
  removeListMembers: (id: string, memberIds: string[]) =>
    send<{ removed: number }>(`/api/lists/${id}/members/remove`, 'POST', { memberIds }),
  removeCampaignTargets: (id: string, targetIds: string[], reason?: string) =>
    send<{ removed: number }>(`/api/campaigns/${id}/targets/remove`, 'POST', { targetIds, reason }),
  createList: async (body: { name: string; description?: string }): Promise<CreateListResult> => {
    const res = await fetch('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.json() as Promise<CreateListResult>;
  },
  linkAccount: async (body: LinkAccountBody): Promise<LinkAccountResult> => {
    const res = await fetch('/api/accounts/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.json() as Promise<LinkAccountResult>;
  },
  updateAccountLimits: async (
    id: string,
    caps: Record<ActionType, number>,
    schedule?: AccountSchedule,
    enabled?: Partial<Record<ActionType, boolean>>,
    schedules?: Partial<Record<ActionType, AccountSchedule>>,
  ): Promise<AccountLimits> => {
    const res = await fetch(`/api/accounts/${id}/limits`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caps, schedule, enabled, schedules }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const body = (await res.json()) as { limits: AccountLimits };
    return body.limits;
  },
  volume: (accountId: string, days: number) => {
    const params = new URLSearchParams({ days: String(days) });
    if (accountId) params.set('accountId', accountId);
    return get<VolumeRow[]>(`/api/metrics/volume?${params.toString()}`);
  },
  scheduled: (limit = 60) => get<ScheduledItem[]>(`/api/scheduled?limit=${limit}`),
  launchCampaign: async (
    id: string,
    accountId: string,
  ): Promise<{ ok: true; enrolled: number; alreadyEnrolled: number }> => {
    const res = await fetch(`/api/campaigns/${id}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.json() as Promise<{ ok: true; enrolled: number; alreadyEnrolled: number }>;
  },
  saveSteps: async (id: string, steps: Step[]): Promise<Step[]> => {
    const res = await fetch(`/api/campaigns/${id}/steps`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const body = (await res.json()) as { steps: Step[] };
    return body.steps;
  },
};
