// Drizzle ORM schema for Postgres. The pg enums mirror the string unions in
// ../enums.ts; keep the two in sync. The `event` table is append-only: writers
// insert, nothing updates or deletes.

import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// --- enums -----------------------------------------------------------------

export const accountStateEnum = pgEnum('account_state', [
  'Cold',
  'Warming',
  'Active',
  'Throttled',
  'Cooldown',
  'Restricted',
]);

export const autonomyLevelEnum = pgEnum('autonomy_level', [
  'supervised',
  'semi_auto',
  'autonomous',
]);

export const actionTypeEnum = pgEnum('action_type', [
  'connect',
  'message',
  'view_profile',
  'follow',
  'withdraw_invite',
  'react',
]);

export const actionResultEnum = pgEnum('action_result', [
  'pending',
  'success',
  'failed',
  'skipped',
  'deferred',
]);

export const messageDirectionEnum = pgEnum('message_direction', [
  'inbound',
  'outbound',
]);

export const messageStatusEnum = pgEnum('message_status', ['draft', 'sent']);

export const targetStageEnum = pgEnum('target_stage', [
  'sourced',
  'queued',
  'invited',
  'connected',
  'in_conversation',
  'replied',
  'won',
  'lost',
]);

export const replyIntentEnum = pgEnum('reply_intent', [
  'Interested',
  'Question',
  'Referral',
  'Objection',
  'NotNow',
  'OutOfOffice',
  'NotInterested',
  'Stop',
]);

export const approvalDecisionEnum = pgEnum('approval_decision', [
  'approved',
  'rejected',
  'edited',
]);

// --- tables ----------------------------------------------------------------

export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  handle: text('handle').notNull(),
  // ProxyBinding + AccountHealth + DailyBudget are stored as jsonb blobs; the
  // domain layer owns their shape.
  proxyBinding: jsonb('proxy_binding').notNull(),
  state: accountStateEnum('state').notNull().default('Cold'),
  health: jsonb('health').notNull(),
  budget: jsonb('budget').notNull(),
  warmupDay: integer('warmup_day').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  goal: text('goal').notNull(),
  autonomyLevel: autonomyLevelEnum('autonomy_level').notNull().default('supervised'),
  messageStrategy: text('message_strategy').notNull(),
  owner: text('owner').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const targets = pgTable('targets', {
  id: uuid('id').defaultRandom().primaryKey(),
  campaignId: uuid('campaign_id')
    .notNull()
    .references(() => campaigns.id),
  prospectRef: text('prospect_ref').notNull(),
  linkedinUrn: text('linkedin_urn').notNull(),
  externalContext: jsonb('external_context').notNull().default({}),
  stage: targetStageEnum('stage').notNull().default('sourced'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const actions = pgTable(
  'actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    type: actionTypeEnum('type').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    result: actionResultEnum('result').notNull().default('pending'),
    dedupKey: text('dedup_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('actions_dedup_key_idx').on(table.dedupKey)],
);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  targetId: uuid('target_id')
    .notNull()
    .references(() => targets.id),
  direction: messageDirectionEnum('direction').notNull(),
  body: text('body').notNull(),
  threadRef: text('thread_ref').notNull(),
  intent: replyIntentEnum('intent'),
  status: messageStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const approvals = pgTable('approvals', {
  id: uuid('id').defaultRandom().primaryKey(),
  pendingItemRef: text('pending_item_ref').notNull(),
  decision: approvalDecisionEnum('decision').notNull(),
  editor: text('editor').notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
});

// Append-only audit log. No updatedAt; rows are immutable once written.
export const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  accountId: uuid('account_id').references(() => accounts.id),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull().default({}),
});

// --- inferred types --------------------------------------------------------

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
export type CampaignRow = typeof campaigns.$inferSelect;
export type NewCampaignRow = typeof campaigns.$inferInsert;
export type TargetRow = typeof targets.$inferSelect;
export type NewTargetRow = typeof targets.$inferInsert;
export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

export const schema = {
  accounts,
  campaigns,
  targets,
  actions,
  messages,
  approvals,
  events,
};
