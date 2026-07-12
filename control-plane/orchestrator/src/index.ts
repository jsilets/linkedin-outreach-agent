// @loa/orchestrator — campaigns, targets, approvals, the append-only event log,
// reply-intent routing, and the data-access layer over the shared Drizzle schema.
//
// Public API:
//   Db seam                PostgresDb (real) or any Db (fake for tests).
//   makeRepositories       repositories for account/campaign/target/action/
//                          message/approval/event over a Db.
//   EventLog               the single write path for the audit spine.
//   CampaignService        create_campaign, add_targets, attach_external_context,
//                          set/read autonomy.
//   ApprovalService        enqueue pending, list, approve/edit_and_approve/reject.
//   SuppressionService     hard suppression across all campaigns.
//   ReplyRouter            route a classified intent to state + follow-up.
//   makeOrchestrator       convenience factory wiring all services over one Db.

import { ApprovalService } from './approvals.js';
import { CampaignService } from './campaigns.js';
import type { Db } from './db.js';
import { EventLog } from './event-log.js';
import { ReplyRouter, type SchedulerLikePort } from './reply-router.js';
import { makeRepositories, type Repositories } from './repositories.js';
import { SuppressionService } from './suppression.js';

export type {
  Decision,
  EnqueuePendingInput,
  PendingItem,
} from './approvals.js';
export { ApprovalService } from './approvals.js';
export type { AddTargetInput, CreateCampaignInput } from './campaigns.js';
export { CampaignService } from './campaigns.js';
export type { Database, Db, Schema } from './db.js';
export { PostgresDb } from './db.js';
export { EventLog } from './event-log.js';
export {
  rowToAccount,
  rowToCampaign,
  rowToMessage,
  rowToTarget,
} from './mappers.js';
export type {
  ProgressPulloutPort,
  RouteInput,
  RoutingOutcome,
  SchedulerLikePort,
} from './reply-router.js';
export { ReplyRouter } from './reply-router.js';
export type {
  ApprovalRepoPort,
  CampaignRepoPort,
  EventRepoPort,
  MessageRepoPort,
  TargetRepoPort,
} from './repo-ports.js';
export type { Repositories } from './repositories.js';
export {
  AccountRepo,
  ActionRepo,
  ApprovalRepo,
  CampaignRepo,
  EventRepo,
  MessageRepo,
  makeRepositories,
  TargetRepo,
} from './repositories.js';
export { SuppressionService } from './suppression.js';

/** Everything wired together over one Db seam. */
export interface Orchestrator {
  repos: Repositories;
  eventLog: EventLog;
  campaigns: CampaignService;
  approvals: ApprovalService;
  suppression: SuppressionService;
  replyRouter: ReplyRouter;
}

/**
 * Wire all orchestrator services over a Db seam and a scheduler port. The
 * scheduler is a PORT (satisfied by @loa/scheduler later); pass a fake in tests.
 */
export function makeOrchestrator(db: Db, scheduler: SchedulerLikePort): Orchestrator {
  const repos = makeRepositories(db);
  const eventLog = new EventLog(repos.event);
  const suppression = new SuppressionService(repos.target, repos.event, eventLog);
  return {
    repos,
    eventLog,
    campaigns: new CampaignService(repos.campaign, repos.target, eventLog),
    approvals: new ApprovalService(repos.message, repos.approval, eventLog),
    suppression,
    replyRouter: new ReplyRouter(repos.target, suppression, scheduler, eventLog),
  };
}
