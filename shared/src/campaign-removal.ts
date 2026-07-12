// The policy for ejecting a target from a campaign, shared by the runtime's
// port-based remove path (adapters/mcp-ports.ts) and the web server's
// Drizzle-direct remove path (web/server/src/queries.ts). The two processes
// persist differently — runtime through store ports, web through a Drizzle
// transaction — so the IMPLEMENTATION can't be shared, but the DECISION can:
// which targets get marked 'lost', the default reason, and the target_removed
// event payload shape all live here, and each side applies the plan through its
// own persistence. Keep the two bindings in lockstep by routing both through
// planCampaignTargetRemoval.

import { CONTACTED_TARGET_STAGES, type ContactedTargetStage } from './enums.js';

/** Default removal reason when the caller doesn't supply one. */
export const CAMPAIGN_TARGET_REMOVAL_REASON = 'removed by operator';

/** Event kind written once per removed target (the audit spine reads this). */
export const TARGET_REMOVED_EVENT_KIND = 'target_removed';

/** A campaign-owned target eligible for removal. */
export interface RemovableTarget {
  id: string;
  linkedinUrn: string;
  stage: string;
}

/** Per-target outcome of the removal decision. */
export interface TargetRemovalDecision {
  targetId: string;
  linkedinUrn: string;
  /** Real outreach already happened, so the stage becomes 'lost'. */
  wasContacted: boolean;
}

/** The target_removed audit event both sides append. accountId is always null
 * (removal is operator-driven, not tied to a sender account). */
export interface TargetRemovedEvent {
  kind: typeof TARGET_REMOVED_EVENT_KIND;
  accountId: null;
  payload: {
    campaignId: string;
    targetId: string;
    linkedinUrn: string;
    reason: string;
    wasContacted: boolean;
  };
}

/** The full removal plan: what each side applies through its own persistence. */
export interface CampaignTargetRemovalPlan {
  /** The effective reason (default filled in), stamped on stopped cursors and
   * every event. */
  reason: string;
  /** One decision per owned target, in input order. */
  decisions: TargetRemovalDecision[];
  /** Target ids to set stage 'lost' — contacted targets only. Pre-contact
   * targets keep their stage so eject doesn't inflate invite metrics
   * (getMetrics counts 'lost' in the invited bucket). */
  lostTargetIds: string[];
  /** One target_removed event per removed target, in input order. */
  events: TargetRemovedEvent[];
}

/** True when a stage means real outreach has already happened. */
export function wasTargetContacted(stage: string): boolean {
  return CONTACTED_TARGET_STAGES.includes(stage as ContactedTargetStage);
}

/**
 * Decide how to eject a set of campaign-owned targets. Pure: no I/O. The caller
 * resolves which targets belong to the campaign, then applies the returned plan
 * through its own persistence — stopping active enrollment cursors (terminal
 * 'skipped'), cancelling undelivered outbound messages, setting the removal
 * marker, setting stage 'lost' for lostTargetIds, and appending events.
 */
export function planCampaignTargetRemoval(
  campaignId: string,
  ownedTargets: RemovableTarget[],
  reason: string = CAMPAIGN_TARGET_REMOVAL_REASON,
): CampaignTargetRemovalPlan {
  const decisions: TargetRemovalDecision[] = ownedTargets.map((t) => ({
    targetId: t.id,
    linkedinUrn: t.linkedinUrn,
    wasContacted: wasTargetContacted(t.stage),
  }));
  return {
    reason,
    decisions,
    lostTargetIds: decisions.filter((d) => d.wasContacted).map((d) => d.targetId),
    events: decisions.map((d) => ({
      kind: TARGET_REMOVED_EVENT_KIND,
      accountId: null,
      payload: {
        campaignId,
        targetId: d.targetId,
        linkedinUrn: d.linkedinUrn,
        reason,
        wasContacted: d.wasContacted,
      },
    })),
  };
}
