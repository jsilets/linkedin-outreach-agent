// Semantic status system shared by the funnel bar, lead chips, and activity feed.
// Every funnel/progress/stage/result key maps to a human label and a CSS color
// variable (defined in styles.css). Amber (--st-approval) is the single
// attention color: it means "this is waiting on you", so nothing else uses it.

// Progress-state pipeline order, left to right. This is the live "where is each
// enrolled lead" story; awaiting_approval sits mid-pipeline so the amber segment
// reads as a checkpoint you have to clear, not an endpoint.
export const PROGRESS_ORDER = [
  'pending',
  'in_progress',
  'awaiting_connection',
  'awaiting_approval',
  'replied',
  'completed',
  'failed',
  'skipped',
] as const;

// Stage order (outcome view): sourced -> ... -> won/lost.
export const STAGE_ORDER = [
  'sourced',
  'queued',
  'invited',
  'connected',
  'in_conversation',
  'replied',
  'won',
  'lost',
] as const;

type Meta = { label: string; varName: string };

const META: Record<string, Meta> = {
  // progress states
  pending: { label: 'Not started', varName: '--st-idle' },
  in_progress: { label: 'In progress', varName: '--st-active' },
  awaiting_connection: { label: 'Awaiting connection', varName: '--st-waiting' },
  awaiting_approval: { label: 'Needs approval', varName: '--st-approval' },
  replied: { label: 'Replied', varName: '--st-replied' },
  completed: { label: 'Completed', varName: '--st-done' },
  failed: { label: 'Failed', varName: '--st-failed' },
  skipped: { label: 'Skipped', varName: '--st-idle' },
  // target stages
  sourced: { label: 'Sourced', varName: '--st-idle' },
  queued: { label: 'Queued', varName: '--st-idle' },
  invited: { label: 'Invited', varName: '--st-waiting' },
  connected: { label: 'Connected', varName: '--st-active' },
  in_conversation: { label: 'In conversation', varName: '--st-active' },
  won: { label: 'Won', varName: '--st-done' },
  lost: { label: 'Lost', varName: '--st-failed' },
  // action results
  success: { label: 'Sent', varName: '--st-done' },
  deferred: { label: 'Deferred', varName: '--st-waiting' },
  // campaign status
  draft: { label: 'Draft', varName: '--st-idle' },
  active: { label: 'Active', varName: '--st-active' },
  done: { label: 'Done', varName: '--st-done' },
};

export function statusMeta(key: string): Meta {
  return META[key] ?? { label: key.replace(/_/g, ' '), varName: '--st-idle' };
}

/** CSS color for a status key, as a var() reference usable in inline styles. */
export function statusVar(key: string): string {
  return `var(${statusMeta(key).varName})`;
}

export function statusLabel(key: string): string {
  return statusMeta(key).label;
}

// Action-type display labels, shared by the activity feed.
export const ACTION_LABELS: Record<string, string> = {
  connect: 'Invite',
  message: 'Message',
  view_profile: 'Profile view',
  follow: 'Follow',
  react: 'Reaction',
  withdraw_invite: 'Withdraw',
};

export function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? type.replace(/_/g, ' ');
}
