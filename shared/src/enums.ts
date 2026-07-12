// Shared enums and string-literal unions. These are the vocabulary every
// package speaks. The values here mirror the pg enums in db/schema.ts; keep
// the two in sync.

export const ACCOUNT_STATES = [
  'Cold',
  'Warming',
  'Active',
  'Throttled',
  'Cooldown',
  'Restricted',
] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const AUTONOMY_LEVELS = ['supervised', 'semi_auto', 'autonomous'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const ACTION_TYPES = [
  'connect',
  'message',
  'view_profile',
  'follow',
  'withdraw_invite',
  'react',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_RESULTS = ['pending', 'success', 'failed', 'skipped', 'deferred'] as const;
export type ActionResult = (typeof ACTION_RESULTS)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = ['draft', 'approved', 'rejected', 'cancelled', 'sent'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const TARGET_STAGES = [
  'sourced',
  'queued',
  'invited',
  'connected',
  'in_conversation',
  'replied',
  'won',
  'lost',
] as const;
export type TargetStage = (typeof TARGET_STAGES)[number];

// Reply intent classes produced by the LLM when reading an inbound message.
export const REPLY_INTENTS = [
  'Interested',
  'Question',
  'Referral',
  'Objection',
  'NotNow',
  'OutOfOffice',
  'NotInterested',
  'Stop',
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

// Intent is an alias of ReplyIntent per the locked LLMProvider contract.
export type Intent = ReplyIntent;

// Signal kinds the detector can raise; the SafetyGate reacts to these.
export const SIGNAL_KINDS = [
  'velocity',
  'low_acceptance',
  'challenge',
  'ban_banner',
  'geo_drift',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

// Autonomy level under which an approval was captured, and the decision made.
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'edited'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// Campaign sequence step kinds. The action-bearing ones map 1:1 to ActionType
// (react = like); 'delay' is a pure wait step that only advances the cursor.
export const CAMPAIGN_STEP_TYPES = [
  'view_profile',
  'connect',
  'message',
  'follow',
  'react',
  'delay',
] as const;
export type CampaignStepType = (typeof CAMPAIGN_STEP_TYPES)[number];

// Per-target enrollment cursor state as it moves through a campaign sequence.
// 'replied' is terminal: an inbound reply pulls the target out of the funnel for
// manual handling and stops any further steps. 'awaiting_approval' is a park
// state: a step routed to human approval waits here (not due) so the dispatch
// tick does not re-enqueue an approval on every pass; it resolves back to
// 'in_progress' on approve, or terminal 'skipped' on reject. 'awaiting_connection'
// is a park state after a connect step (not due): the invite was sent and the
// cursor waits for it to be accepted. The acceptance tick releases it to the next
// step once the target connects, or a reply pulls it out.
export const PROGRESS_STATES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
  'replied',
  'awaiting_approval',
  'awaiting_connection',
] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

// Funnel-state lists shared between the runtime stores and the web server's
// removal query. An operator removal terminates a cursor ONLY from one of these
// active progress states; the same list must be used in both stores' stopFunnel
// and the removal query, so it lives here to stay in lockstep.
export const ACTIVE_PROGRESS_STATES = [
  'pending',
  'in_progress',
  'awaiting_approval',
  'awaiting_connection',
] as const;
export type ActiveProgressState = (typeof ACTIVE_PROGRESS_STATES)[number];

// Outbound message statuses a removal must cancel so an approved-but-unsent draft
// never fires after the target has left the funnel. Duplicated across both stores
// and the web removal query; keep them in lockstep by importing from here.
export const CANCELABLE_MESSAGE_STATUSES = ['draft', 'approved'] as const;
export type CancelableMessageStatus = (typeof CANCELABLE_MESSAGE_STATUSES)[number];

// Stages that mean real outreach has already happened. A removal marks a target
// 'lost' only from one of these; pre-contact stages stay untouched so eject does
// not inflate invite metrics. Shared so the stores and the removal query agree.
export const CONTACTED_TARGET_STAGES = [
  'invited',
  'connected',
  'in_conversation',
  'replied',
  'won',
] as const;
export type ContactedTargetStage = (typeof CONTACTED_TARGET_STAGES)[number];
