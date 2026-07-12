// Repository ports: the minimal method surface each service needs. Services
// depend on these interfaces, not the concrete repo classes, so tests can pass
// in-memory implementations and skip Postgres entirely. The concrete repos in
// repositories.ts satisfy these structurally.

import { db as shared } from '@loa/shared';

type CampaignRow = shared.CampaignRow;
type NewCampaignRow = shared.NewCampaignRow;
type TargetRow = shared.TargetRow;
type NewTargetRow = shared.NewTargetRow;
type MessageRow = shared.MessageRow;
type NewMessageRow = shared.NewMessageRow;
type ApprovalRow = shared.ApprovalRow;
type NewApprovalRow = shared.NewApprovalRow;
type EventRow = shared.EventRow;
type NewEventRow = shared.NewEventRow;

export interface CampaignRepoPort {
  create(row: NewCampaignRow): Promise<CampaignRow>;
  findById(id: string): Promise<CampaignRow | undefined>;
  setAutonomy(id: string, level: CampaignRow['autonomyLevel']): Promise<CampaignRow>;
}

export interface TargetRepoPort {
  create(row: NewTargetRow): Promise<TargetRow>;
  createMany(rows: NewTargetRow[]): Promise<TargetRow[]>;
  findById(id: string): Promise<TargetRow | undefined>;
  listByCampaign(campaignId: string): Promise<TargetRow[]>;
  setExternalContext(id: string, blob: NewTargetRow['externalContext']): Promise<TargetRow>;
  setStage(id: string, stage: TargetRow['stage']): Promise<TargetRow>;
}

export interface MessageRepoPort {
  create(row: NewMessageRow): Promise<MessageRow>;
  findById(id: string): Promise<MessageRow | undefined>;
  setStatus(id: string, status: MessageRow['status']): Promise<MessageRow>;
  setBody(id: string, body: string): Promise<MessageRow>;
  listByThread(threadRef: string): Promise<MessageRow[]>;
  /** Every draft (pending) message across all threads. Backs the durable
   * pending queue: after a restart the binding is rebuilt from these rows. */
  listDrafts(): Promise<MessageRow[]>;
  /** Every approved-but-unsent message. The dispatch tick sends these when the
   * working-hours window opens (an off-hours approval needs no re-approval). */
  listApproved(): Promise<MessageRow[]>;
}

export interface ApprovalRepoPort {
  create(row: NewApprovalRow): Promise<ApprovalRow>;
}

export interface EventRepoPort {
  append(row: NewEventRow): Promise<EventRow>;
  listSuppression(): Promise<EventRow[]>;
}
