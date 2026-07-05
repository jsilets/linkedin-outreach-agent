// Store selection. Dev and smoke use the in-memory store; a live deployment
// uses PostgresStore when DATABASE_URL is set. Both expose the orchestrator
// repo ports plus the account/action reads the runtime adapters need.
//
// The account/action/event-read surfaces are async so the same adapter code
// works over both the synchronous in-memory maps and the async Postgres driver.

import { db as shared } from '@loa/shared';
import type {
  ApprovalRepoPort,
  CampaignRepoPort,
  EventRepoPort,
  MessageRepoPort,
  TargetRepoPort,
} from '@loa/orchestrator';

export { InMemoryStore } from './in-memory-store.js';
export { makeInMemoryStore } from './in-memory-store.js';
export { makePostgresStore } from './postgres-store.js';

/** Read/write surface the runtime needs for accounts, beyond the repo ports. */
export interface AccountStorePort {
  findById(id: string): Promise<shared.AccountRow | undefined>;
  all(): Promise<shared.AccountRow[]>;
  create(row: shared.NewAccountRow): Promise<shared.AccountRow>;
  update(id: string, patch: Partial<shared.AccountRow>): Promise<shared.AccountRow>;
}

/** Read/write surface for action rows. */
export interface ActionStorePort {
  create(row: shared.NewActionRow): Promise<shared.ActionRow>;
  findById(id: string): Promise<shared.ActionRow | undefined>;
  listByAccount(accountId: string): Promise<shared.ActionRow[]>;
}

/** Event reads the admin audit-log adapter needs on top of EventRepoPort. */
export interface EventReadPort extends EventRepoPort {
  listByAccount(accountId: string): Promise<shared.EventRow[]>;
  /** Every event, oldest-first. Used by the smoke trace and audit tooling. */
  listAll(): Promise<shared.EventRow[]>;
}

/** The composed store shape the runtime adapters depend on. */
export interface RuntimeStore {
  account: AccountStorePort;
  action: ActionStorePort;
  campaign: CampaignRepoPort;
  target: TargetRepoPort;
  message: MessageRepoPort;
  approval: ApprovalRepoPort;
  event: EventReadPort;
  /** All targets for a campaign, for funnel metrics. */
  listTargetsByCampaign(campaignId: string): Promise<shared.TargetRow[]>;
  /** Release any underlying resources (Postgres pool). No-op in memory. */
  close(): Promise<void>;
}
