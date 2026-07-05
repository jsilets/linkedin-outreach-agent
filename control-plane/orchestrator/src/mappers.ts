// Row -> domain mappers. The Drizzle row types carry jsonb columns as loose
// types; the domain types in @loa/shared are precise. Narrow at this one
// boundary so the rest of the orchestrator works in domain terms.

import { db as shared } from '@loa/shared';
import type {
  Account,
  AccountHealth,
  Campaign,
  DailyBudget,
  Json,
  Message,
  ProxyBinding,
  Target,
} from '@loa/shared';

export function rowToCampaign(row: shared.CampaignRow): Campaign {
  return {
    id: row.id,
    goal: row.goal,
    autonomyLevel: row.autonomyLevel,
    messageStrategy: row.messageStrategy,
    owner: row.owner,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToTarget(row: shared.TargetRow): Target {
  return {
    id: row.id,
    prospectRef: row.prospectRef,
    linkedinUrn: row.linkedinUrn,
    externalContext: row.externalContext as Json,
    stage: row.stage,
    campaignId: row.campaignId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToMessage(row: shared.MessageRow): Message {
  return {
    id: row.id,
    direction: row.direction,
    body: row.body,
    threadRef: row.threadRef,
    intent: row.intent,
    status: row.status,
    accountId: row.accountId,
    targetId: row.targetId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToAccount(row: shared.AccountRow): Account {
  return {
    id: row.id,
    handle: row.handle,
    proxyBinding: row.proxyBinding as ProxyBinding,
    state: row.state,
    health: row.health as AccountHealth,
    budget: row.budget as DailyBudget,
    warmupDay: row.warmupDay,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
