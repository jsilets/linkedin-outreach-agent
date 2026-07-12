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

type Meta = { label: string; varName: string };

const META: Record<string, Meta> = {
  // progress states
  pending: { label: 'Not started', varName: '--st-idle' },
  in_progress: { label: 'In progress', varName: '--st-active' },
  awaiting_connection: { label: 'Invite sent', varName: '--st-waiting' },
  awaiting_approval: { label: 'Needs approval', varName: '--st-approval' },
  replied: { label: 'Replied', varName: '--st-replied' },
  completed: { label: 'Completed', varName: '--st-done' },
  failed: { label: 'Failed', varName: '--st-failed' },
  skipped: { label: 'Skipped', varName: '--st-idle' },
  // derived lead milestones (see deriveLeadStatus) — finer than the raw states
  invite_queued: { label: 'Invite queued', varName: '--st-idle' },
  messaged: { label: 'Message sent', varName: '--st-active' },
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

function statusMeta(key: string): Meta {
  return META[key] ?? { label: key.replace(/_/g, ' '), varName: '--st-idle' };
}

// The fields deriveLeadStatus reads. A structural subset of the Lead type, kept
// local so status.ts has no import back into api.ts.
export interface LeadStatusInput {
  stage: string;
  progressState: string | null;
  lastAction: { type: string; result: string } | null;
}

/**
 * Collapse a lead's raw (stage, progressState, lastAction) into ONE milestone
 * key that says where the person actually is in the funnel — because the raw
 * progress state ("in_progress") is the same string whether we haven't invited
 * them yet, they just accepted, or we've already messaged them. Milestones,
 * roughly in order: invite queued -> invite sent -> connected -> message sent ->
 * replied, with the human-gated (needs approval) and terminal states surfaced
 * as-is.
 */
export function deriveLeadStatus(l: LeadStatusInput): string {
  const st = l.progressState;
  // Terminal / attention states read straight through — they already say it.
  if (st === 'awaiting_approval') return 'awaiting_approval';
  if (st === 'replied') return 'replied';
  if (st === 'completed') return 'completed';
  if (st === 'failed') return 'failed';
  if (st === 'skipped') return 'skipped';
  // Invite is out, waiting for the person to accept.
  if (st === 'awaiting_connection') return 'awaiting_connection';

  // Actively stepping: disambiguate by what has actually happened.
  if (st === 'in_progress' || st === 'pending') {
    const did = l.lastAction?.result === 'success' ? l.lastAction.type : null;
    // A message already went out — we're waiting on a reply / follow-up.
    if (did === 'message') return 'messaged';
    // Accepted (stage advanced) but no message sent yet: message is scheduled.
    if (l.stage === 'connected') return 'connected';
    // Invite sent but the cursor hasn't parked yet (brief window post-connect).
    if (did === 'connect') return 'awaiting_connection';
    // Enrolled, invite not yet sent — waiting on a send slot (cap / window).
    return 'invite_queued';
  }

  // Not enrolled: fall back to the sourcing stage.
  return l.stage;
}

/** CSS color for a status key, as a var() reference usable in inline styles. */
export function statusVar(key: string): string {
  return `var(${statusMeta(key).varName})`;
}

export function statusLabel(key: string): string {
  return statusMeta(key).label;
}

// Action-type display labels, shared by the activity feed.
const ACTION_LABELS: Record<string, string> = {
  connect: 'Invite',
  message: 'Message',
  view_profile: 'Profile view',
  follow: 'Follow',
  react: 'Reaction',
  withdraw_invite: 'Withdraw',
  // Inbound (from the event log), not an outbound action — the prospect accepted.
  invite_accepted: 'Invite accepted',
};

export function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? type.replace(/_/g, ' ');
}
