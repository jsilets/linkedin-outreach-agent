// Store selection. Dev and smoke use the in-memory store; a live deployment
// uses PostgresStore when DATABASE_URL is set. Both expose the orchestrator
// repo ports plus the account/action reads the runtime adapters need.
//
// The account/action/event-read surfaces are async so the same adapter code
// works over both the synchronous in-memory maps and the async Postgres driver.

import { db as shared } from '@loa/shared';
import type { Json } from '@loa/shared';
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
  /** Persist the final outcome onto an action row: its result plus the time it
   * executed. The executor calls this after driving the action so the row no
   * longer reads 'pending'. */
  setResult(
    id: string,
    result: shared.ActionRow['result'],
    executedAt: Date | null,
  ): Promise<shared.ActionRow>;
  /** Remove an action row. Used to clean up a just-created pending row when a
   * mint-time safety re-check defers, so no orphan pending row is left behind. */
  deleteById(id: string): Promise<void>;
}

/** Event reads the admin audit-log adapter needs on top of EventRepoPort. */
export interface EventReadPort extends EventRepoPort {
  listByAccount(accountId: string): Promise<shared.EventRow[]>;
  /** Every event, oldest-first. Used by the smoke trace and audit tooling. */
  listAll(): Promise<shared.EventRow[]>;
}

/** Patch applied to a target-progress row as the dispatch tick advances it. */
export interface TargetProgressPatch {
  currentStep?: number;
  state?: shared.TargetProgressRow['state'];
  nextStepAt?: Date | null;
  lastStepAt?: Date | null;
  errorMessage?: string | null;
}

/** Campaign-sequence read/write surface: the step template (CRUD + reorder),
 * per-target enrollment cursors the dispatch tick walks, and the read-side
 * counts a UI consumes. Method names are load-bearing: another package's UI
 * consumes the read ones, so keep them exact. */
export interface SequenceStorePort {
  // --- step template ---
  listCampaignSteps(campaignId: string): Promise<shared.CampaignStepRow[]>;
  upsertCampaignStep(step: shared.NewCampaignStepRow): Promise<shared.CampaignStepRow>;
  deleteCampaignStep(id: string): Promise<void>;
  reorderCampaignSteps(campaignId: string, orderedIds: string[]): Promise<void>;

  // --- per-target cursor ---
  /** Enroll a target. Idempotent on targetId (unique index): a second call for
   * the same target returns the existing row unchanged. */
  enrollTarget(
    campaignId: string,
    targetId: string,
    accountId: string,
  ): Promise<shared.TargetProgressRow>;
  listTargetProgress(campaignId: string): Promise<shared.TargetProgressRow[]>;
  /** The single enrollment cursor for a target (unique on targetId), if any.
   * Used by the post-approval resume to move a parked cursor forward. */
  getTargetProgressByTarget(targetId: string): Promise<shared.TargetProgressRow | undefined>;
  /** Rows the dispatch tick should act on: state='in_progress' AND
   * (nextStepAt IS NULL OR nextStepAt<=now). */
  dueTargetProgress(now: Date): Promise<shared.TargetProgressRow[]>;
  /** Cursors parked after a connect step (state='awaiting_connection'), waiting
   * for the invite to be accepted. The acceptance tick reads these to release
   * connected targets into the next step. */
  awaitingConnectionEnrollments(): Promise<shared.TargetProgressRow[]>;
  /** Every still-live enrollment cursor (state IN in_progress, pending,
   * awaiting_approval, awaiting_connection), across all campaigns/accounts. The
   * reply tick scans these so a reply is caught even while a step waits on its
   * delay or an approval — not just the cursors that are due to act. */
  activeEnrollments(): Promise<shared.TargetProgressRow[]>;
  advanceTargetProgress(id: string, patch: TargetProgressPatch): Promise<void>;
  /** Pull a target out of every funnel it is in (terminal 'replied' state) and
   * stop further steps. Idempotent; a no-op if the target is not enrolled. */
  pullTargetFromFunnel(targetId: string, reason: string): Promise<void>;

  // --- read-side aggregates for the UI ---
  campaignCounts(campaignId: string): Promise<{
    targets: number;
    byStage: Record<string, number>;
    byProgressState: Record<string, number>;
  }>;
  actionVolume(
    accountId: string,
    sinceDays: number,
  ): Promise<Array<{ date: string; type: string; count: number }>>;
}

/** Lead-list read/write surface: named lists of sourced leads and their
 * members. These write the SAME lead_lists / lead_list_members tables the web
 * UI's ListsView reads, so a list sourced over MCP shows up in the UI. Member
 * writes are idempotent on (listId, linkedinUrn). */
export interface LeadListStorePort {
  createList(input: { name: string; description?: string }): Promise<shared.LeadListRow>;
  /** All lists with a per-list member count (empty lists included, count 0). */
  listWithCounts(): Promise<Array<shared.LeadListRow & { memberCount: number }>>;
  findById(id: string): Promise<shared.LeadListRow | undefined>;
  listMembers(listId: string): Promise<shared.LeadListMemberRow[]>;
  /** Insert members, skipping any already present (unique on listId +
   * linkedinUrn). Returns how many rows were newly inserted. */
  insertMembers(rows: shared.NewLeadListMemberRow[]): Promise<{ inserted: number }>;
  /** Merge a patch into one member's external_context (matched on listId +
   * linkedinUrn). Used by the harness-driven score_leads path to attach a score
   * an agent computed. Returns true when a member matched, false otherwise. */
  updateMemberContext(
    listId: string,
    linkedinUrn: string,
    patch: Record<string, Json>,
  ): Promise<boolean>;
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
  /** Campaign sequence templates + per-target enrollment cursors. */
  sequence: SequenceStorePort;
  /** Lead lists + members (lead gen, read by the web UI's ListsView). */
  leadList: LeadListStorePort;
  /** All targets for a campaign, for funnel metrics. */
  listTargetsByCampaign(campaignId: string): Promise<shared.TargetRow[]>;
  /** Release any underlying resources (Postgres pool). No-op in memory. */
  close(): Promise<void>;
}
