// Orchestrator wiring: construct the orchestrator services directly over the
// runtime store's repo ports (not makeOrchestrator, which wants a Db). This is
// the ONE orchestrator the whole runtime shares; every event write funnels
// through its EventLog.recordEvent.

import {
  ApprovalService,
  CampaignService,
  EventLog,
  ReplyRouter,
  SuppressionService,
  type SchedulerLikePort,
} from '@loa/orchestrator';
import type { RuntimeStore } from '../store/index.js';

export interface OrchestratorServices {
  eventLog: EventLog;
  campaigns: CampaignService;
  approvals: ApprovalService;
  suppression: SuppressionService;
  replyRouter: ReplyRouter;
}

/** Build the orchestrator services over the store and a scheduler follow-up
 * port. The scheduler port is supplied by the scheduler adapter. */
export function makeOrchestratorServices(
  store: RuntimeStore,
  scheduler: SchedulerLikePort,
): OrchestratorServices {
  const eventLog = new EventLog(store.event);
  const suppression = new SuppressionService(store.target, store.event, eventLog);
  return {
    eventLog,
    campaigns: new CampaignService(store.campaign, store.target, eventLog),
    approvals: new ApprovalService(store.message, store.approval, eventLog),
    suppression,
    // Pass the sequence store so any inbound reply pulls the target out of its
    // campaign funnel (terminal 'replied' progress state).
    replyRouter: new ReplyRouter(store.target, suppression, scheduler, eventLog, store.sequence),
  };
}
