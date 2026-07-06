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
  /** Geography facet id (e.g. "103644278" for United States). */
  geoUrn?: string;
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

export interface CampaignPort {
  createCampaign(input: {
    goal: string;
    autonomyLevel: AutonomyLevel;
    messageStrategy: string;
    owner: string;
  }): Promise<Campaign>;
  addTargets(campaignId: string, prospectRefs: string[]): Promise<Target[]>;
  attachExternalContext(targetId: string, context: Json): Promise<Target>;
  getAccountState(accountId: string): Promise<Account>;
  getQueue(accountId: string): Promise<QueueEntry[]>;
  getMetrics(campaignId: string): Promise<Metrics>;
  /** Set the autonomy dial for a campaign (privileged approval-family tool). */
  setAutonomyLevel(campaignId: string, level: AutonomyLevel): Promise<Campaign>;
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
  admin: AccountAdminPort;
}
