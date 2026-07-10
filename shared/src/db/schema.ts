// Drizzle ORM schema for Postgres. The pg enums mirror the string unions in
// ../enums.ts; keep the two in sync. The `event` table is append-only: writers
// insert, nothing updates or deletes.

import {
  boolean,
  index,
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

// 'Cold' and 'Warming' are legacy/unused: there is no warmup ramp any more and
// nothing produces these states. They are kept in the enum (dropping a pg enum
// value requires recreating the type) and treated as Active by the safety gate.
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

export const campaignStepTypeEnum = pgEnum('campaign_step_type', [
  'view_profile',
  'connect',
  'message',
  'follow',
  'react',
  'delay',
]);

export const progressStateEnum = pgEnum('progress_state', [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
  'replied',
  'awaiting_approval',
  'awaiting_connection',
]);

// --- tables ----------------------------------------------------------------

export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  handle: text('handle').notNull(),
  // ProxyBinding + AccountHealth + DailyBudget are stored as jsonb blobs; the
  // domain layer owns their shape.
  proxyBinding: jsonb('proxy_binding').notNull(),
  state: accountStateEnum('state').notNull().default('Active'),
  health: jsonb('health').notNull(),
  budget: jsonb('budget').notNull(),
  // Operator-set automation limits (per-action daily caps). Editable in the UI
  // and enforced by the SafetyGate. Defaulted so existing rows backfill to the
  // conservative caps instead of a hidden zero.
  limits: jsonb('limits')
    .notNull()
    .default({
      caps: { connect: 20, message: 20, view_profile: 60, follow: 15, withdraw_invite: 10, react: 30 },
    }),
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

// A single ordered step in a campaign's sequence (the sequence template).
export const campaignSteps = pgTable(
  'campaign_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    stepOrder: integer('step_order').notNull(),
    stepType: campaignStepTypeEnum('step_type').notNull(),
    // Wait (seconds) after the previous step before this one becomes due.
    delaySeconds: integer('delay_seconds').notNull().default(0),
    // Inline content used per step type: note (connect), body (message),
    // reaction (react; defaults to LIKE when null).
    note: text('note'),
    body: text('body'),
    reaction: text('reaction'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('campaign_steps_order_idx').on(table.campaignId, table.stepOrder)],
);

// Per-target enrollment cursor: where a target sits in its campaign sequence.
// The dispatch tick selects due rows (state='in_progress' AND next_step_at<=now)
// and advances current_step; nextStepAt replaces the in-memory follow-up queue.
export const targetProgress = pgTable(
  'target_progress',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id),
    // The sender account assigned to this target (supports rotation later).
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    currentStep: integer('current_step').notNull().default(0),
    state: progressStateEnum('state').notNull().default('pending'),
    // When due. Null + in_progress means due immediately.
    nextStepAt: timestamp('next_step_at', { withTimezone: true }),
    lastStepAt: timestamp('last_step_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('target_progress_target_idx').on(table.targetId),
    index('target_progress_due_idx').on(table.state, table.nextStepAt),
  ],
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

// A named list of sourced leads, independent of any campaign. Lead gen (search)
// populates a list; a list can later be enrolled onto a campaign as targets.
export const leadLists = pgTable('lead_lists', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// A person in a lead list. Shape mirrors a people-search result; linkedinUrn is
// the stable identity used to dedup within a list. externalContext holds any
// enrichment blob the sourcing layer attached.
export const leadListMembers = pgTable(
  'lead_list_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    listId: uuid('list_id')
      .notNull()
      .references(() => leadLists.id, { onDelete: 'cascade' }),
    linkedinUrn: text('linkedin_urn').notNull(),
    name: text('name'),
    headline: text('headline'),
    profileUrl: text('profile_url'),
    degree: text('degree'),
    location: text('location'),
    currentCompany: text('current_company'),
    externalContext: jsonb('external_context').notNull().default({}),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lead_list_members_list_urn_uq').on(t.listId, t.linkedinUrn)],
);

// --- inferred types --------------------------------------------------------

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
export type CampaignRow = typeof campaigns.$inferSelect;
export type NewCampaignRow = typeof campaigns.$inferInsert;
export type TargetRow = typeof targets.$inferSelect;
export type NewTargetRow = typeof targets.$inferInsert;
export type CampaignStepRow = typeof campaignSteps.$inferSelect;
export type NewCampaignStepRow = typeof campaignSteps.$inferInsert;
export type TargetProgressRow = typeof targetProgress.$inferSelect;
export type NewTargetProgressRow = typeof targetProgress.$inferInsert;
export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type LeadListRow = typeof leadLists.$inferSelect;
export type NewLeadListRow = typeof leadLists.$inferInsert;
export type LeadListMemberRow = typeof leadListMembers.$inferSelect;
export type NewLeadListMemberRow = typeof leadListMembers.$inferInsert;

export const schema = {
  accounts,
  campaigns,
  campaignSteps,
  targets,
  targetProgress,
  actions,
  messages,
  approvals,
  events,
  leadLists,
  leadListMembers,
};
