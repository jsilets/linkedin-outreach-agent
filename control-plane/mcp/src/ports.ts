// PORT interfaces: the integration contract this server codes against.
//
// The MCP package must not import sibling control-plane packages (they are
// written in parallel). Instead it defines these ports and every tool handler
// calls a port method. The real orchestrator / scheduler / safety / account
// admin packages implement these later and get injected at wiring time.
//
// Nothing in here does browser or DB work. These are pure boundaries.

import type {
  Account,
  AccountState,
  Action,
  ActionType,
  ApprovalDecision,
  AutonomyLevel,
  Campaign,
  CampaignStepType,
  DailyBudget,
  Decision,
  Json,
  Target,
} from '@loa/shared';

// ---------------------------------------------------------------------------
// Observe port: read-only LinkedIn / graph reads. Runs open (no gating).
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  linkedinUrn: string;
  handle: string;
  name: string;
  headline: string;
  raw: Json;
}

export interface PostSummary {
  postUrn: string;
  authorUrn: string;
  text: string;
  postedAt: Date;
}

export interface EngagerSummary {
  linkedinUrn: string;
  name: string;
  reaction: string;
}

export interface JobSummary {
  jobId: string;
  title: string;
  location: string;
  postedAt: Date;
}

export interface ConversationSummary {
  threadRef: string;
  messages: Array<{ direction: string; body: string; at: Date }>;
}

/**
 * Structured people-search query for free-tier Voyager. A bare string is still
 * accepted at the tool boundary and normalized to { keywords }. Seniority
 * ("manager or above") has no free-tier facet, so it is approximated by the
 * caller with titleKeywords (manager/senior/director/head/lead). Sales Navigator
 * facets (real seniority/function) belong to a later salesApiPeopleSearch
 * backend, not here.
 */
export interface PeopleQuery {
  /** Free-text keywords (the search box). */
  keywords?: string;
  /** Title keyword filters; OR-ed. Also the seniority approximation. */
  titleKeywords?: string[];
  /** Free-text current-company names; OR-ed. */
  companyKeywords?: string[];
  /** Company entity ids for the currentCompany facet (e.g. "1035"); OR-ed. */
  companyUrns?: string[];
  /** Single geography facet id (e.g. "103644278" for United States). Kept for
   * back-compat; prefer geoUrns. When both are set they are merged. */
  geoUrn?: string;
  /** Geography facet ids for the geoUrn facet (e.g. ["103644278","101174742"]
   * for US + Canada); OR-ed, like companyUrns. */
  geoUrns?: string[];
  /** Connection-degree facet: F=1st, S=2nd, O=3rd+. */
  network?: Array<'F' | 'S' | 'O'>;
  /** Max results to return across pages; capped at the ~1000 flagship limit. */
  limit?: number;
}

export interface PersonSearchResult {
  /** Stable identifier. Present for every real result. */
  entityUrn: string;
  /** Public vanity id from the profile URL, when the payload carries it. */
  publicId?: string;
  name?: string;
  headline?: string;
  /** Canonical https://www.linkedin.com/in/... URL. */
  profileUrl: string;
  /** "1st" | "2nd" | "3rd" | "OUT_OF_NETWORK" style distance, when present. */
  degree?: string;
  location?: string;
  currentCompany?: string;
  /**
   * Kept so callers migrating off the old thin shape (linkedinUrn/name/headline)
   * still compile. Mirrors entityUrn.
   */
  linkedinUrn?: string;
}

export interface ObservePort {
  getProfile(accountId: string, linkedinUrn: string): Promise<ProfileSummary>;
  getRecentPosts(accountId: string, linkedinUrn: string, limit: number): Promise<PostSummary[]>;
  getPostEngagers(accountId: string, postUrn: string, limit: number): Promise<EngagerSummary[]>;
  getCompanyJobs(accountId: string, companyUrn: string, limit: number): Promise<JobSummary[]>;
  getConversation(accountId: string, threadRef: string): Promise<ConversationSummary>;
  searchPeople(
    accountId: string,
    query: PeopleQuery,
    limit: number,
  ): Promise<PersonSearchResult[]>;
}

// ---------------------------------------------------------------------------
// Executor port: the only thing that actually performs a mutating LinkedIn
// action. gateAct() dispatches here ONLY when autonomy + SafetyGate allow it.
// The MCP server never calls this directly from a tool handler.
// ---------------------------------------------------------------------------

/** A mutating action request, before it becomes a persisted Action. */
export interface ActRequest {
  type: ActionType;
  accountId: string;
  targetId: string;
  campaignId: string;
  /** Payload varies by type: message body, reaction kind, etc. */
  payload?: Json;
}

export interface ExecutorPort {
  /** Perform the action now. Returns the persisted Action. */
  execute(req: ActRequest): Promise<Action>;
}

// ---------------------------------------------------------------------------
// Scheduler / SafetyGate port: the gate consults this for canAct and for the
// account + campaign snapshots it needs to make an autonomy decision. This is a
// read surface over @loa/scheduler and @loa/safety; kept minimal on purpose.
// ---------------------------------------------------------------------------

export interface SafetyPort {
  /** Load the account so the gate can evaluate budget / state. */
  getAccount(accountId: string): Promise<Account>;
  /** Load the campaign so the gate can read its autonomy level. */
  getCampaign(campaignId: string): Promise<Campaign>;
  /**
   * Ask the SafetyGate whether this action may run now. Mirrors
   * SafetyGate.canAct but takes an ActRequest since the Action row does not
   * exist yet at gate time.
   */
  canAct(account: Account, req: ActRequest): Promise<Decision>;
}

// ---------------------------------------------------------------------------
// Approval port: the human-in-the-loop queue. gateAct() enqueues here when
// autonomy forbids direct execution. The approval tool family also drives it.
// ---------------------------------------------------------------------------

export interface PendingItem {
  id: string;
  req: ActRequest;
  /** Autonomy level in effect when the item was queued. */
  autonomyLevel: AutonomyLevel;
  /** Optional generated draft body awaiting sign-off. */
  draftBody?: string;
  createdAt: Date;
}

export interface ApprovalPort {
  /** Queue an action for human sign-off. Returns the pending id. */
  enqueue(req: ActRequest, autonomyLevel: AutonomyLevel, draftBody?: string): Promise<PendingItem>;
  listPending(campaignId?: string): Promise<PendingItem[]>;
  /** Approve as-is: dispatches the underlying action via the executor. */
  approve(pendingId: string, editor: string): Promise<Action>;
  /** Edit the draft body then approve and dispatch. */
  editAndApprove(pendingId: string, editor: string, body: string): Promise<Action>;
  /** Reject; nothing is dispatched. */
  reject(pendingId: string, editor: string, reason: string): Promise<void>;
  /** Record an operator decision (audit). */
  record(pendingId: string, decision: ApprovalDecision, editor: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Campaign / state port: autonomous campaign and queue management.
// ---------------------------------------------------------------------------

export interface QueueEntry {
  actionId: string;
  type: ActionType;
  scheduledAt: Date;
  targetId: string;
}

export interface Metrics {
  campaignId: string;
  invited: number;
  connected: number;
  replied: number;
  won: number;
}

/** One step in a campaign's sequence, as read back to the agent/UI. */
export interface CampaignStepView {
  id: string;
  stepOrder: number;
  stepType: CampaignStepType;
  /** Wait (seconds) before this step becomes due after the previous one. */
  delaySeconds: number;
  note: string | null;
  body: string | null;
  reaction: string | null;
  enabled: boolean;
}

/** A step spec when defining a sequence. stepOrder is implied by array order. */
export interface SequenceStepInput {
  stepType: CampaignStepType;
  delaySeconds?: number;
  note?: string | null;
  body?: string | null;
  reaction?: string | null;
  enabled?: boolean;
}

/** Outcome of enrolling targets into a campaign's sequence. */
export interface EnrollResult {
  campaignId: string;
  accountId: string;
  enrolled: number;
  progressIds: string[];
}

/** A target to add, carrying a real LinkedIn identity. This is the shape a
 * search_people result maps onto, so sourced people enroll with their real urn
 * and profile URL rather than a fabricated ref. A bare string is still accepted
 * (dev/manual) and expands to a deterministic urn. */
export interface TargetInput {
  /** Stable reference (public vanity id, or the entity urn when no vanity). */
  prospectRef: string;
  /** Real LinkedIn entity urn. */
  linkedinUrn: string;
  /** Everything else is stored as opaque external context on the target. */
  profileUrl?: string;
  name?: string;
  headline?: string;
  currentCompany?: string;
  location?: string;
  degree?: string;
}

export interface CampaignPort {
  createCampaign(input: {
    goal: string;
    autonomyLevel: AutonomyLevel;
    messageStrategy: string;
    owner: string;
  }): Promise<Campaign>;
  /** Add targets by bare ref or by structured identity (e.g. search results). */
  addTargets(campaignId: string, targets: Array<string | TargetInput>): Promise<Target[]>;
  attachExternalContext(targetId: string, context: Json): Promise<Target>;
  /** List every sender account so callers can discover the accountId the other
   * campaign/sourcing tools require. The account UUID appears nowhere in the web
   * UI, so this is the only in-MCP way to find it. */
  listAccounts(): Promise<Account[]>;
  getAccountState(accountId: string): Promise<Account>;
  getQueue(accountId: string): Promise<QueueEntry[]>;
  getMetrics(campaignId: string): Promise<Metrics>;
  /** Set the autonomy dial for a campaign (privileged approval-family tool). */
  setAutonomyLevel(campaignId: string, level: AutonomyLevel): Promise<Campaign>;
  /** Read a campaign's ordered step sequence. */
  listCampaignSteps(campaignId: string): Promise<CampaignStepView[]>;
  /** Replace a campaign's step sequence with the given ordered steps. */
  defineCampaignSteps(
    campaignId: string,
    steps: SequenceStepInput[],
  ): Promise<CampaignStepView[]>;
  /** Enroll targets into the campaign sequence under a sender account. The
   * dispatch tick then advances each enrolled target through the steps. */
  enrollTargets(
    campaignId: string,
    targetIds: string[],
    accountId: string,
  ): Promise<EnrollResult>;
}

// ---------------------------------------------------------------------------
// Lead-list port: named lists of sourced leads, independent of any campaign.
// Lead gen (people-search) populates a list; the web UI's ListsView reads the
// SAME lead_lists / lead_list_members tables these methods write, so a list made
// or filled over MCP shows up in the UI with no UI change. Runs open (no gating):
// creating/reading a list and writing sourced people is not a LinkedIn Act.
// ---------------------------------------------------------------------------

/** A lead list with its current member count (list index row). */
export interface ListSummary {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

/** One person in a lead list. Mirrors a PersonSearchResult, flattened. */
export interface ListMember {
  id: string;
  linkedinUrn: string;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  degree: string | null;
  location: string | null;
  currentCompany: string | null;
}

/** A lead list with its members (list detail). */
export interface ListDetail {
  id: string;
  name: string;
  description: string | null;
  members: ListMember[];
}

/** Outcome of writing sourced people into a list: idempotent on
 * (listId, linkedinUrn), so re-running only adds the new ones. */
export interface InsertMembersResult {
  inserted: number;
  duplicates: number;
}

export interface LeadListPort {
  /** Create a lead list. Returns its id + name. */
  createList(input: { name: string; description?: string }): Promise<{ id: string; name: string }>;
  /** All lists with per-list member counts. */
  listLists(): Promise<ListSummary[]>;
  /** One list with its members. Null when the list does not exist. */
  getList(listId: string): Promise<ListDetail | null>;
  /** Write people into a list, skipping anyone already in it (unique on
   * listId + linkedinUrn). Returns how many were newly inserted vs skipped. */
  insertMembers(listId: string, people: PersonSearchResult[]): Promise<InsertMembersResult>;
}

// ---------------------------------------------------------------------------
// Account admin port: privileged safety controls. pause_account and kill_all
// must stay callable even if the scheduler is wedged, so they live here and are
// invoked directly, never routed through the gate/scheduler path.
// ---------------------------------------------------------------------------

export interface HealthReport {
  accountId: string;
  state: AccountState;
  budget: DailyBudget;
  paused: boolean;
}

export interface AuditRecord {
  id: string;
  ts: Date;
  accountId: string;
  kind: string;
  payload: Json;
}

export interface AccountAdminPort {
  pauseAccount(accountId: string, reason: string): Promise<void>;
  resumeAccount(accountId: string): Promise<void>;
  /** Global stop: halt every account immediately. */
  killAll(reason: string): Promise<void>;
  getHealth(accountId: string): Promise<HealthReport>;
  rotateSession(accountId: string): Promise<void>;
  auditLog(accountId: string, limit: number): Promise<AuditRecord[]>;
}

// ---------------------------------------------------------------------------
// The full set of ports the server depends on, injected at construction.
// ---------------------------------------------------------------------------

export interface Ports {
  observe: ObservePort;
  executor: ExecutorPort;
  safety: SafetyPort;
  approval: ApprovalPort;
  campaign: CampaignPort;
  lists: LeadListPort;
  admin: AccountAdminPort;
}
