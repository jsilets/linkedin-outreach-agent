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

export type CampaignStatus = 'draft' | 'active' | 'done';

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
}

export interface BulkApproveResult {
  results: Array<{ messageId: string; ok: boolean; error?: string }>;
}

export interface VolumeRow {
  day: string;
  type: string;
  count: number;
}

// The per-action daily caps an operator can edit. Mirrors the server's
// ActionType union; kept as a plain list so the UI can render one field each.
export const ACTION_TYPES = [
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
  schedule?: AccountSchedule;
}

export interface Account {
  id: string;
  handle: string;
  state: string;
  limits: AccountLimits;
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
  ): Promise<AccountLimits> => {
    const res = await fetch(`/api/accounts/${id}/limits`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(schedule ? { caps, schedule } : { caps }),
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
