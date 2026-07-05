// Reply-intent routing. Given a classified intent for a target, update the
// campaign/target state and decide follow-up:
//   Stop            -> hard-suppress the target across ALL campaigns, no sends.
//   Interested      -> advance stage, route to a drafted reply (human gate).
//   Question        -> route to a drafted reply (human gate).
//   Referral        -> advance to replied, route to a drafted reply.
//   Objection       -> advance to replied, route to a drafted reply.
//   NotNow          -> update state, schedule a paced follow-up.
//   OutOfOffice     -> update state, schedule a paced follow-up.
//   NotInterested   -> mark lost, no follow-up.
//
// The router never schedules directly. It emits an intent for the scheduler via
// a SchedulerLikePort so timing stays in @loa/scheduler. It never sends: replies
// go through the human gate elsewhere. It only sets state, suppresses, and emits.

import type { Intent, TargetStage } from '@loa/shared';
import type { EventLog } from './event-log.js';
import type { TargetRepoPort } from './repo-ports.js';
import type { SuppressionService } from './suppression.js';

/** The slice of the scheduler the router emits follow-ups to. */
export interface SchedulerLikePort {
  enqueueFollowUp(input: {
    targetId: string;
    campaignId: string;
    notBefore: Date;
    reason: string;
  }): Promise<void>;
}

/** What the router decided, returned for the caller and for tests. */
export interface RoutingOutcome {
  intent: Intent;
  /** Whether a reply should be drafted behind the human gate. */
  needsReply: boolean;
  /** New target stage, if the router changed it. */
  stage?: TargetStage;
  /** Whether the target was hard-suppressed. */
  suppressed: boolean;
  /** Whether a paced follow-up was emitted to the scheduler. */
  scheduledFollowUp: boolean;
}

export interface RouteInput {
  targetId: string;
  campaignId: string;
  intent: Intent;
  /** How far out to place a paced follow-up. Defaults to 3 days. */
  followUpDelayMs?: number;
  now?: Date;
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export class ReplyRouter {
  constructor(
    private readonly targets: TargetRepoPort,
    private readonly suppression: SuppressionService,
    private readonly scheduler: SchedulerLikePort,
    private readonly log: EventLog,
  ) {}

  async route(input: RouteInput): Promise<RoutingOutcome> {
    const { targetId, campaignId, intent } = input;
    const now = input.now ?? new Date();
    const delay = input.followUpDelayMs ?? THREE_DAYS_MS;

    const outcome: RoutingOutcome = {
      intent,
      needsReply: false,
      suppressed: false,
      scheduledFollowUp: false,
    };

    switch (intent) {
      case 'Stop': {
        // Hard suppression across all campaigns, plus no further sends. The
        // target's own stage moves to lost.
        await this.suppression.suppressByTarget(targetId);
        outcome.stage = await this.setStage(targetId, 'lost');
        outcome.suppressed = true;
        break;
      }

      case 'Interested': {
        outcome.stage = await this.setStage(targetId, 'in_conversation');
        outcome.needsReply = true;
        break;
      }

      case 'Question': {
        outcome.stage = await this.setStage(targetId, 'in_conversation');
        outcome.needsReply = true;
        break;
      }

      case 'Referral':
      case 'Objection': {
        outcome.stage = await this.setStage(targetId, 'replied');
        outcome.needsReply = true;
        break;
      }

      case 'NotNow':
      case 'OutOfOffice': {
        outcome.stage = await this.setStage(targetId, 'replied');
        await this.scheduler.enqueueFollowUp({
          targetId,
          campaignId,
          notBefore: new Date(now.getTime() + delay),
          reason: intent === 'NotNow' ? 'not_now_followup' : 'out_of_office_followup',
        });
        outcome.scheduledFollowUp = true;
        break;
      }

      case 'NotInterested': {
        outcome.stage = await this.setStage(targetId, 'lost');
        break;
      }

      default: {
        const never: never = intent;
        throw new Error(`unhandled reply intent: ${String(never)}`);
      }
    }

    await this.log.recordEvent('reply_routed', null, {
      targetId,
      campaignId,
      intent,
      needsReply: outcome.needsReply,
      suppressed: outcome.suppressed,
      scheduledFollowUp: outcome.scheduledFollowUp,
      stage: outcome.stage ?? null,
    });
    return outcome;
  }

  private async setStage(targetId: string, stage: TargetStage): Promise<TargetStage> {
    const row = await this.targets.setStage(targetId, stage);
    return row.stage;
  }
}
