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

export interface CampaignSummary {
  id: string;
  goal: string;
  owner: string;
  autonomyLevel: string;
  messageStrategy: string;
  targetCount: number;
  byStage: Record<string, number>;
}

export interface CampaignDetail extends CampaignSummary {
  steps: Step[];
  byProgressState: Record<string, number>;
}

export interface VolumeRow {
  day: string;
  type: string;
  count: number;
}

export interface Account {
  id: string;
  handle: string;
  state: string;
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

export interface CreateCampaignFromListResult {
  ok: true;
  campaignId: string;
  targetCount: number;
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

export const api = {
  campaigns: () => get<CampaignSummary[]>('/api/campaigns'),
  campaign: (id: string) => get<CampaignDetail>(`/api/campaigns/${id}`),
  accounts: () => get<Account[]>('/api/accounts'),
  lists: () => get<ListSummary[]>('/api/lists'),
  getList: (id: string) => get<ListDetail>(`/api/lists/${id}`),
  createList: async (body: { name: string; description?: string }): Promise<CreateListResult> => {
    const res = await fetch('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.json() as Promise<CreateListResult>;
  },
  createCampaignFromList: async (
    listId: string,
    body: { goal: string; owner?: string; messageStrategy?: string },
  ): Promise<CreateCampaignFromListResult> => {
    const res = await fetch(`/api/lists/${listId}/campaign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return res.json() as Promise<CreateCampaignFromListResult>;
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
