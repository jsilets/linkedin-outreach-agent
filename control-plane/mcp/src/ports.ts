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

/** One position from a profile's experience section, most-recent first. Every
 * field optional because the source components are sparse and versioned. */
export interface ProfilePosition {
  /** Job title, e.g. "VP Engineering". */
  title?: string;
  /** Employer name, e.g. "Acme Corp". */
  company?: string;
  /** Raw date/duration caption, e.g. "Jan 2022 - Present · 2 yrs". */
  dateRange?: string;
  /** Location line, when present. */
  location?: string;
  /** True when the caption marks an ongoing role ("Present"). */
  current?: boolean;
}

export interface ProfileSummary {
  linkedinUrn: string;
  handle: string;
  name: string;
  headline: string;
  /** Current job title, when derivable from the experience section. */
  currentTitle?: string;
  /** Current employer, when derivable from the experience section. */
  currentCompany?: string;
  /** Recent positions, most-recent first, from the experience section. Used for
   * ICP enrichment (current role + company + history), beyond the search headline. */
  positions?: ProfilePosition[];
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

/** A recently-accepted 1st-degree connection, from the live relationships read.
 * Most-recent first. `connectedAt` is an ISO timestamp when LinkedIn carries it. */
export interface RecentConnection {
  entityUrn: string;
  profileUrl?: string;
  name?: string;
  headline?: string;
  connectedAt?: string;
}

/** One pending outgoing invitation, from the full paginated sent-invitations
 * read (both campaign-sent and manually-sent). `sentAt` is an ISO timestamp and
 * `ageDays` its whole-day age when the payload carries a sent time; both are
 * absent otherwise. */
export interface SentInvitationView {
  invitationUrn: string;
  inviteeUrn?: string;
  publicIdentifier?: string;
  profileUrl?: string;
  name?: string;
  sentAt?: string;
  ageDays?: number;
  message?: string;
}

export interface ObservePort {
  getProfile(accountId: string, linkedinUrn: string): Promise<ProfileSummary>;
  getRecentPosts(accountId: string, linkedinUrn: string, limit: number): Promise<PostSummary[]>;
  getPostEngagers(accountId: string, postUrn: string, limit: number): Promise<EngagerSummary[]>;
  getCompanyJobs(accountId: string, companyUrn: string, limit: number): Promise<JobSummary[]>;
  getConversation(accountId: string, threadRef: string): Promise<ConversationSummary>;
  searchPeople(accountId: string, query: PeopleQuery, limit: number): Promise<PersonSearchResult[]>;
  /** Recently-accepted connections from the account's own network, most-recent
   * first. Read-only; does not charge the people-search budget. */
  listRecentConnections(accountId: string, limit: number): Promise<RecentConnection[]>;
  /** All pending outgoing invitations, read in full over the paginated Voyager
   * endpoint (LinkedIn is the source of truth, so this covers manual invites the
   * runtime never sent). `olderThanDays` filters to invites at least that old;
   * invites with an unknown sent time are excluded when a filter is set. */
  listSentInvitations(
    accountId: string,
    opts: { limit?: number; olderThanDays?: number },
  ): Promise<SentInvitationView[]>;
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

/** Result of approving a pending item. The send is NOT immediate: approval marks
 * the message 'approved' and the dispatch tick sends it at the next open
 * working-hours window (so an off-hours approval needs no second approval). */
export interface ApprovalOutcome {
  pendingId: string;
  targetId: string;
  /** 'approved' — queued to send at the next open window. */
  status: 'approved';
}

export interface ApprovalPort {
  /** Queue an action for human sign-off. Returns the pending id. */
  enqueue(req: ActRequest, autonomyLevel: AutonomyLevel, draftBody?: string): Promise<PendingItem>;
  listPending(campaignId?: string): Promise<PendingItem[]>;
  /** Approve as-is: marks the message approved; the dispatch tick sends it at
   * the next open working-hours window. */
  approve(pendingId: string, editor: string): Promise<ApprovalOutcome>;
  /** Edit the draft body then approve (sent by the tick at the next window). */
  editAndApprove(pendingId: string, editor: string, body: string): Promise<ApprovalOutcome>;
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
  /** Targets skipped because an operator removed them from the campaign;
   *  removal is permanent, so enrollment never resurrects them. */
  skippedRemoved: number;
}

/** Outcome of removing targets from a campaign. */
export interface RemoveTargetsResult {
  /** How many targets were ejected (belonged to the campaign and existed). */
  removed: number;
  /** targetIds that were not found in this campaign (skipped). */
  notFound: string[];
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
  /** Extra blob merged onto the target's external context (e.g. an ICP score
   *  envelope carried from a list). Merged over the derived profile fields. */
  externalContext?: Json;
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
  defineCampaignSteps(campaignId: string, steps: SequenceStepInput[]): Promise<CampaignStepView[]>;
  /** Enroll targets into the campaign sequence under a sender account. The
   * dispatch tick then advances each enrolled target through the steps. */
  enrollTargets(campaignId: string, targetIds: string[], accountId: string): Promise<EnrollResult>;
  /** Operator removal: eject targets from a campaign, selected by target id
   * and/or LinkedIn URN (the URN is what the agent has from a list). Stops each
   * target's sequence, cancels its undelivered sends, and marks the target stage
   * 'lost'. A logical removal — target rows are kept so the audit trail and any
   * sent history stay intact. Returns how many were removed and any selectors
   * not matched in the campaign. */
  removeTargets(
    campaignId: string,
    selector: { targetIds?: string[]; linkedinUrns?: string[] },
    reason?: string,
  ): Promise<RemoveTargetsResult>;
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

/** One person in a lead list. Mirrors a PersonSearchResult, flattened, plus the
 *  ICP fit score read out of the member's external_context (null when the member
 *  has not been scored). offIcp is the advisory below-threshold flag. */
export interface ListMember {
  id: string;
  linkedinUrn: string;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  degree: string | null;
  location: string | null;
  currentCompany: string | null;
  /** Current job title, when verified off the real profile (enrichment). */
  currentTitle?: string | null;
  /** Provenance of currentCompany: 'profile' (read off the real profile) or
   *  'headline' (guessed from the search headline). Null/absent for legacy rows
   *  written before enrichment existed. Gates the "{Company}" message merge. */
  companySource?: string | null;
  /** 0..100 ICP fit score, or null when unscored. */
  score: number | null;
  /** Short justification lines for the score. */
  scoreReasons: string[] | null;
  /** The ICP label the score was computed against. */
  icp: string | null;
  /** score !== null && score < ICP_FIT_THRESHOLD. Advisory off-ICP flag. */
  offIcp: boolean;
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
  /** Edit a list's name and/or description. Only the provided fields change.
   * Returns the updated summary, or null when no list has that id. */
  updateList(
    listId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<ListSummary | null>;
  /** Delete a lead list by id. The lead_list_members FK is ON DELETE CASCADE, so
   * its members go with it. Returns whether a row was removed and how many
   * members were removed alongside it. */
  deleteList(listId: string): Promise<{ deleted: boolean; removedMembers: number }>;
  /** All lists with per-list member counts. */
  listLists(): Promise<ListSummary[]>;
  /** One list with its members. Null when the list does not exist. */
  getList(listId: string): Promise<ListDetail | null>;
  /** Write people into a list, skipping anyone already in it (unique on
   * listId + linkedinUrn). Returns how many were newly inserted vs skipped. */
  insertMembers(listId: string, people: PersonSearchResult[]): Promise<InsertMembersResult>;
  /** Of the given canonical LinkedIn URNs, which are ALREADY in the system: a
   * target in any campaign (any stage, including operator-removed) or a member of
   * any lead list. Sourcing uses this to surface only genuinely-new people.
   * Returns the subset that is already known. */
  knownUrns(urns: string[]): Promise<Set<string>>;
  /** Remove members from a list by LinkedIn URN. Returns how many were removed
   * (a urn not in the list is silently skipped). */
  removeMembers(listId: string, linkedinUrns: string[]): Promise<{ removed: number }>;
}

// ---------------------------------------------------------------------------
// Discovery port: the autonomous lead-discovery + scoring feeder. Takes an
// operator-defined ICP, discovers candidates, scores each against the ICP, and
// writes a ranked, scored list into the SAME lead_lists / lead_list_members the
// LeadListPort writes (the per-lead score lives in the member's external_context
// blob, so it rides onto the campaign target via createCampaignFromList). Runs
// open (no gating): discovery does a read-only people search, no LinkedIn Act.
// Optional on Ports: present only when the feature flag is on.
// ---------------------------------------------------------------------------

/** Which candidate field an ICP attribute is matched against. */
export type IcpField = 'title' | 'company' | 'seniority' | 'location' | 'industry';

/** One weighted qualification signal. `negative` makes a hit disqualifying. */
export interface IcpAttribute {
  field: IcpField;
  /** Values that count as a hit (OR-ed, case-insensitive substring). */
  match: string[];
  /** Relative importance. Default 1. */
  weight?: number;
  /** true = presence is a negative signal. Default false. */
  negative?: boolean;
}

/**
 * An operator-defined ideal customer profile. The `query` half drives candidate
 * discovery (maps onto PeopleQuery facets); `description` + `attributes` drive
 * qualification. Passed into a tool call; not (yet) a persisted record.
 */
export interface Icp {
  /** Human label, e.g. "US/CA field-operations leaders". */
  name: string;
  /** Discovery facets. Mirrors the PeopleQuery free-tier facet set. */
  query: {
    keywords?: string;
    titleKeywords?: string[];
    companyKeywords?: string[];
    companyUrns?: string[];
    geoUrns?: string[];
    network?: Array<'F' | 'S' | 'O'>;
  };
  /** Free-text description of the ideal customer, scored against candidate text. */
  description?: string;
  /** Structured, weighted attributes the heuristic scorer can read directly. */
  attributes?: IcpAttribute[];
}

/** One agent-computed score to attach to an existing list member. */
export interface LeadScoreInput {
  linkedinUrn: string;
  /** 0..100. */
  score: number;
  reasons?: string[];
}

/** Outcome of attaching agent scores: matched members vs urns with no member. */
export interface ScoreLeadsResult {
  updated: number;
  missed: string[];
}

/** Outcome of scoring the members of a list against an ICP. The counts describe
 *  only the members scored in this run; members left untouched because a
 *  higher-quality scorer already scored them are reported in skippedOtherScorer. */
export interface ScoreListResult {
  listId: string;
  /** How many members were scored in this run. */
  scored: number;
  /** How many of the scored members fall below the ICP fit threshold (off-ICP). */
  offIcp: number;
  /** Highest score among the members scored this run (0 when none were scored). */
  topScore: number;
  /** How many members were skipped because they carry a score from a different
   *  scorer (e.g. a harness score) and overwrite was false. */
  skippedOtherScorer: number;
  /** How many members had their current company verified off the real profile in
   *  this run (a live get_profile). Absent when no enricher is wired (offline). */
  enriched?: number;
}

/**
 * The list-scoring surface. Sourcing (source_to_list) and scoring are separate
 * steps: this scores people who are already in a list. Two scorers, same target
 * (the member's external_context): the offline heuristic (scoreList) and the
 * harness's own judgment (scoreLeads). Neither makes a live search.
 */
export interface DiscoveryPort {
  /** Harness-driven path: write scores an agent already computed into the
   *  members' external_context. */
  scoreLeads(listId: string, scores: LeadScoreInput[]): Promise<ScoreLeadsResult>;
  /** Offline path: run the built-in heuristic over the members ALREADY in a list
   *  and write the scores. The keyless fallback when no agent scores the list.
   *  A member already scored by a different scorer (e.g. a harness score) is left
   *  untouched unless overwrite is true, so a higher-quality score is not silently
   *  downgraded. */
  scoreList(listId: string, icp: Icp, overwrite?: boolean): Promise<ScoreListResult>;
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

/** Outcome of a stale-invitation sweep. `withdrawn` lists what actually went
 * out (oldest first); `releasedCursors` counts campaign targets whose parked
 * awaiting_connection cursor was released to terminal by the withdrawal. */
export interface WithdrawStaleResult {
  /** Aged invites picked up for this call (capped): == withdrawn + failed + any
   *  left unattempted when the sweep stopped early on a throttle. */
  considered: number;
  withdrawn: Array<{ publicIdentifier?: string; sentAt?: string }>;
  /** How many withdraw attempts were a permanent per-invite failure (skipped). */
  failed: number;
  releasedCursors: number;
  /** How many throttle signals (429/999/403 or a blocked fetch) were seen. */
  throttled: number;
  /** Aged invites still pending after this call (agedTotal − withdrawn). Re-run a
   *  spaced call to clear them; 0 means the aged pile is empty. */
  remaining: number;
  /** Why the sweep ended: it drained the pile ('completed'), hit the per-call cap
   *  with more still aged ('max_reached'), or backed off and stopped on a
   *  sustained throttle ('throttled'). */
  stopped: 'completed' | 'max_reached' | 'throttled';
}

export interface AccountAdminPort {
  pauseAccount(accountId: string, reason: string): Promise<void>;
  resumeAccount(accountId: string): Promise<void>;
  /** Global stop: halt every account immediately. */
  killAll(reason: string): Promise<void>;
  getHealth(accountId: string): Promise<HealthReport>;
  rotateSession(accountId: string): Promise<void>;
  auditLog(accountId: string, limit: number): Promise<AuditRecord[]>;
  /** Operator remedy: withdraw the oldest pending invitations to keep the
   * outstanding pile under LinkedIn's ~500 ceiling. Withdraws at most `max`
   * (hard-capped), oldest first, paced apart. */
  withdrawStaleInvitations(
    accountId: string,
    opts: { olderThanDays: number; max: number },
  ): Promise<WithdrawStaleResult>;
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
  /** The list-scoring surface (heuristic score_list + harness score_leads).
   *  Always wired; offline, so no feature flag. */
  discovery?: DiscoveryPort;
}
