// The agent-facing tool surface: 30 tools across 5 families.
//
// Each tool is declared with a zod input shape (raw shape, as the MCP SDK
// expects), a family, a privileged flag, and a handler that receives the parsed
// args, the injected ports, and the request context.
//
// Autonomy is enforced structurally: every Act tool's handler routes through
// gateAct() and never calls the executor. Privileged tools call
// requirePrivileged() first. Observe / campaign / metrics tools run open.

import { z } from 'zod';
import { AUTONOMY_LEVELS, CAMPAIGN_STEP_TYPES } from '@loa/shared';
import type { RequestContext } from './context.js';
import { requirePrivileged } from './capability.js';
import { gateAct, type GateOutcome } from './gate.js';
import type { ActRequest, PeopleQuery, Ports, TargetInput } from './ports.js';

export type ToolFamily = 'observe' | 'act' | 'campaign' | 'approval' | 'safety';

/** A JSON-serializable tool result. Handlers return plain data; the server
 *  wraps it in the MCP content envelope. */
export type ToolOutput = unknown;

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  family: ToolFamily;
  description: string;
  /** Privileged tools reject without an operator capability. */
  privileged: boolean;
  inputShape: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ports: Ports, ctx: RequestContext) => Promise<ToolOutput>;
}

// Helper to build an ActRequest and route it through the single chokepoint.
async function act(
  ports: Ports,
  req: ActRequest,
  draftBody?: string,
): Promise<GateOutcome> {
  return gateAct(
    { safety: ports.safety, approval: ports.approval, executor: ports.executor },
    req,
    draftBody,
  );
}

const autonomyEnum = z.enum(AUTONOMY_LEVELS);

// The free-tier people-search facets, shared by search_people, source_people,
// and source_to_list. Kept as a raw shape so it can be spread into each tool's
// inputShape. Seniority/role has no free-tier facet, so it is approximated via
// titleKeywords (manager/senior/director/head/lead) rather than a Sales Nav
// seniority/function filter.
const peopleFacetShape = {
  titleKeywords: z.array(z.string()).optional(),
  companyKeywords: z.array(z.string()).optional(),
  companyUrns: z.array(z.string()).optional(),
  geoUrn: z.string().optional(),
  geoUrns: z.array(z.string()).optional(),
  network: z.array(z.enum(['F', 'S', 'O'])).optional(),
};

/** Assemble a PeopleQuery from the shared facet args + an optional keyword box.
 * Typed loosely because ToolDef erases each tool's parsed-arg shape to a raw
 * zod shape, so handlers see their args as an index signature. */
function toPeopleQuery(a: {
  query?: string;
  titleKeywords?: string[];
  companyKeywords?: string[];
  companyUrns?: string[];
  geoUrn?: string;
  geoUrns?: string[];
  network?: Array<'F' | 'S' | 'O'>;
  limit?: number;
}): PeopleQuery {
  return {
    keywords: a.query,
    titleKeywords: a.titleKeywords,
    companyKeywords: a.companyKeywords,
    companyUrns: a.companyUrns,
    geoUrn: a.geoUrn,
    geoUrns: a.geoUrns,
    network: a.network,
    limit: a.limit,
  };
}

// ---------------------------------------------------------------------------
// Observe (autonomous, open): read-only.
// ---------------------------------------------------------------------------

const observeTools: ToolDef[] = [
  {
    name: 'get_profile',
    family: 'observe',
    description: 'Fetch a LinkedIn profile summary.',
    privileged: false,
    inputShape: { accountId: z.string(), linkedinUrn: z.string() },
    handler: (a, p) => p.observe.getProfile(a.accountId, a.linkedinUrn),
  },
  {
    name: 'get_recent_posts',
    family: 'observe',
    description: 'Fetch recent posts for a profile.',
    privileged: false,
    inputShape: { accountId: z.string(), linkedinUrn: z.string(), limit: z.number().int().positive().max(100).default(10) },
    handler: (a, p) => p.observe.getRecentPosts(a.accountId, a.linkedinUrn, a.limit),
  },
  {
    name: 'get_post_engagers',
    family: 'observe',
    description: 'List people who engaged with a post.',
    privileged: false,
    inputShape: { accountId: z.string(), postUrn: z.string(), limit: z.number().int().positive().max(200).default(50) },
    handler: (a, p) => p.observe.getPostEngagers(a.accountId, a.postUrn, a.limit),
  },
  {
    name: 'get_company_jobs',
    family: 'observe',
    description: 'List open jobs at a company.',
    privileged: false,
    inputShape: { accountId: z.string(), companyUrn: z.string(), limit: z.number().int().positive().max(100).default(25) },
    handler: (a, p) => p.observe.getCompanyJobs(a.accountId, a.companyUrn, a.limit),
  },
  {
    name: 'get_conversation',
    family: 'observe',
    description: 'Fetch a conversation thread by reference.',
    privileged: false,
    inputShape: { accountId: z.string(), threadRef: z.string() },
    handler: (a, p) => p.observe.getConversation(a.accountId, a.threadRef),
  },
  {
    name: 'search_people',
    family: 'observe',
    description:
      'Search LinkedIn people (free-tier Voyager). Pass a bare `query` string for ' +
      'a keyword search, or the structured facets (titleKeywords, companyKeywords, ' +
      'companyUrns, geoUrns, network) for an ICP search. geoUrns takes multiple ' +
      'geography ids (e.g. ["103644278","101174742"] for US + Canada) in one pass. ' +
      'Seniority is approximated via titleKeywords (manager/senior/director/head/lead).',
    privileged: false,
    inputShape: {
      accountId: z.string(),
      // Backward-compatible: a bare string is normalized to { keywords }.
      query: z.string().optional(),
      titleKeywords: z.array(z.string()).optional(),
      companyKeywords: z.array(z.string()).optional(),
      companyUrns: z.array(z.string()).optional(),
      geoUrn: z.string().optional(),
      geoUrns: z.array(z.string()).optional(),
      network: z.array(z.enum(['F', 'S', 'O'])).optional(),
      limit: z.number().int().positive().max(1000).default(25),
    },
    handler: (a, p) =>
      p.observe.searchPeople(a.accountId, toPeopleQuery(a), a.limit),
  },
  {
    name: 'source_people',
    family: 'observe',
    description:
      'Run a live LinkedIn people search and return the raw PersonSearchResult[] ' +
      '(no list write). Facets are free-tier Voyager: titleKeywords, ' +
      'companyKeywords, companyUrns, geoUrns (multiple geographies in one pass), ' +
      'network (F=1st/S=2nd/O=3rd+). There ' +
      'is no Sales Navigator seniority/function facet, so a role like "manager or ' +
      'above" is approximated via titleKeywords (manager/senior/director/head/' +
      'lead). Use source_to_list to search AND persist into a lead list in one call.',
    privileged: false,
    inputShape: {
      accountId: z.string(),
      query: z.string().optional(),
      ...peopleFacetShape,
      limit: z.number().int().positive().max(1000).default(25),
    },
    handler: (a, p) => p.observe.searchPeople(a.accountId, toPeopleQuery(a), a.limit),
  },
];

// ---------------------------------------------------------------------------
// Act (human gate by default): every one routes through gateAct().
// ---------------------------------------------------------------------------

const actTools: ToolDef[] = [
  {
    name: 'send_connection',
    family: 'act',
    description: 'Send a connection request. Gated by autonomy level.',
    privileged: false,
    inputShape: {
      accountId: z.string(),
      targetId: z.string(),
      campaignId: z.string(),
      note: z.string().max(300).optional(),
    },
    handler: (a, p) =>
      act(p, { type: 'connect', accountId: a.accountId, targetId: a.targetId, campaignId: a.campaignId, payload: a.note ?? null }, a.note),
  },
  {
    name: 'send_message',
    family: 'act',
    description: 'Send a direct message. Gated by autonomy level.',
    privileged: false,
    inputShape: {
      accountId: z.string(),
      targetId: z.string(),
      campaignId: z.string(),
      body: z.string().min(1),
    },
    handler: (a, p) =>
      act(p, { type: 'message', accountId: a.accountId, targetId: a.targetId, campaignId: a.campaignId, payload: a.body }, a.body),
  },
  {
    name: 'view_profile',
    family: 'act',
    description: 'Register a profile view (a tracked mutating act). Gated by autonomy level.',
    privileged: false,
    inputShape: { accountId: z.string(), targetId: z.string(), campaignId: z.string() },
    handler: (a, p) =>
      act(p, { type: 'view_profile', accountId: a.accountId, targetId: a.targetId, campaignId: a.campaignId }),
  },
  {
    name: 'follow',
    family: 'act',
    description: 'Follow a target. Gated by autonomy level.',
    privileged: false,
    inputShape: { accountId: z.string(), targetId: z.string(), campaignId: z.string() },
    handler: (a, p) =>
      act(p, { type: 'follow', accountId: a.accountId, targetId: a.targetId, campaignId: a.campaignId }),
  },
  {
    name: 'withdraw_invite',
    family: 'act',
    description: 'Withdraw a pending connection invite. Gated by autonomy level.',
    privileged: false,
    inputShape: { accountId: z.string(), targetId: z.string(), campaignId: z.string() },
    handler: (a, p) =>
      act(p, { type: 'withdraw_invite', accountId: a.accountId, targetId: a.targetId, campaignId: a.campaignId }),
  },
  {
    name: 'react_to_post',
    family: 'act',
    description: 'React to a post. Gated by autonomy level.',
    privileged: false,
    inputShape: {
      accountId: z.string(),
      targetId: z.string(),
      campaignId: z.string(),
      postUrn: z.string(),
      reaction: z.string().default('like'),
    },
    handler: (a, p) =>
      act(p, {
        type: 'react',
        accountId: a.accountId,
        targetId: a.targetId,
        campaignId: a.campaignId,
        payload: { postUrn: a.postUrn, reaction: a.reaction },
      }),
  },
];

// ---------------------------------------------------------------------------
// Campaign & state (autonomous, open). set_autonomy_level is privileged and
// lives in the approval family below.
// ---------------------------------------------------------------------------

const campaignTools: ToolDef[] = [
  {
    name: 'create_campaign',
    family: 'campaign',
    description: 'Create a campaign.',
    privileged: false,
    inputShape: {
      goal: z.string().min(1),
      autonomyLevel: autonomyEnum,
      messageStrategy: z.string(),
      owner: z.string(),
    },
    handler: (a, p) =>
      p.campaign.createCampaign({
        goal: a.goal,
        autonomyLevel: a.autonomyLevel,
        messageStrategy: a.messageStrategy,
        owner: a.owner,
      }),
  },
  {
    name: 'add_targets',
    family: 'campaign',
    description:
      'Add targets to a campaign. Pass prospectRefs (bare strings) and/or people ' +
      '(search_people results, which carry the real entityUrn + profileUrl so the ' +
      'target enrolls with its true identity). At least one must be non-empty.',
    privileged: false,
    inputShape: {
      campaignId: z.string(),
      prospectRefs: z.array(z.string()).optional(),
      people: z
        .array(
          z.object({
            entityUrn: z.string(),
            profileUrl: z.string().optional(),
            publicId: z.string().optional(),
            name: z.string().optional(),
            headline: z.string().optional(),
            currentCompany: z.string().optional(),
            location: z.string().optional(),
            degree: z.string().optional(),
          }),
        )
        .optional(),
    },
    handler: (a, p) => {
      type PersonArg = {
        entityUrn: string;
        profileUrl?: string;
        publicId?: string;
        name?: string;
        headline?: string;
        currentCompany?: string;
        location?: string;
        degree?: string;
      };
      const people: PersonArg[] = a.people ?? [];
      const fromPeople: TargetInput[] = people.map((person) => ({
        prospectRef: person.publicId ?? person.entityUrn,
        linkedinUrn: person.entityUrn,
        ...(person.profileUrl ? { profileUrl: person.profileUrl } : {}),
        ...(person.name ? { name: person.name } : {}),
        ...(person.headline ? { headline: person.headline } : {}),
        ...(person.currentCompany ? { currentCompany: person.currentCompany } : {}),
        ...(person.location ? { location: person.location } : {}),
        ...(person.degree ? { degree: person.degree } : {}),
      }));
      const targets: Array<string | TargetInput> = [...(a.prospectRefs ?? []), ...fromPeople];
      if (targets.length === 0) {
        throw new Error('add_targets: provide at least one prospectRef or person');
      }
      return p.campaign.addTargets(a.campaignId, targets);
    },
  },
  {
    name: 'attach_external_context',
    family: 'campaign',
    description: 'Attach an enrichment blob to a target.',
    privileged: false,
    inputShape: { targetId: z.string(), context: z.unknown() },
    handler: (a, p) => p.campaign.attachExternalContext(a.targetId, a.context as never),
  },
  {
    name: 'list_accounts',
    family: 'campaign',
    description:
      'List every sender account with its id, handle, and state. Call this ' +
      'first to discover the accountId that source_to_list, enroll_targets, and ' +
      'the other account tools require: the UUID is not shown in the web UI, so ' +
      'this is the only way to find it. Takes no arguments.',
    privileged: false,
    inputShape: {},
    handler: (_a, p) => p.campaign.listAccounts(),
  },
  {
    name: 'get_account_state',
    family: 'campaign',
    description: 'Read an account state snapshot.',
    privileged: false,
    inputShape: { accountId: z.string() },
    handler: (a, p) => p.campaign.getAccountState(a.accountId),
  },
  {
    name: 'get_queue',
    family: 'campaign',
    description: 'Read the pending action queue for an account.',
    privileged: false,
    inputShape: { accountId: z.string() },
    handler: (a, p) => p.campaign.getQueue(a.accountId),
  },
  {
    name: 'get_metrics',
    family: 'campaign',
    description: 'Read funnel metrics for a campaign.',
    privileged: false,
    inputShape: { campaignId: z.string() },
    handler: (a, p) => p.campaign.getMetrics(a.campaignId),
  },
  {
    name: 'define_sequence',
    family: 'campaign',
    description:
      'Define (replace) a campaign sequence: an ordered list of steps the ' +
      'dispatch tick walks per enrolled target. Step types: view_profile, ' +
      'connect, message, follow, react, delay. delaySeconds on a step is the ' +
      'wait before that step runs. connect uses note, message uses body, react ' +
      'uses reaction (defaults to like). A delay step needs delaySeconds > 0.',
    privileged: false,
    inputShape: {
      campaignId: z.string(),
      steps: z
        .array(
          z.object({
            stepType: z.enum(CAMPAIGN_STEP_TYPES),
            delaySeconds: z.number().int().nonnegative().default(0),
            note: z.string().max(300).optional(),
            body: z.string().optional(),
            reaction: z.string().optional(),
            enabled: z.boolean().default(true),
          }),
        )
        .min(1),
    },
    handler: (a, p) => p.campaign.defineCampaignSteps(a.campaignId, a.steps),
  },
  {
    name: 'get_sequence',
    family: 'campaign',
    description: 'Read a campaign ordered step sequence.',
    privileged: false,
    inputShape: { campaignId: z.string() },
    handler: (a, p) => p.campaign.listCampaignSteps(a.campaignId),
  },
  {
    name: 'enroll_targets',
    family: 'campaign',
    description:
      'Enroll targets into a campaign sequence under a sender account. ' +
      'Idempotent per target. The dispatch tick then advances each enrolled ' +
      'target through the steps.',
    privileged: false,
    inputShape: {
      campaignId: z.string(),
      targetIds: z.array(z.string()).min(1),
      accountId: z.string(),
    },
    handler: (a, p) => p.campaign.enrollTargets(a.campaignId, a.targetIds, a.accountId),
  },
  // --- lead lists (lead gen, visible in the web UI's ListsView) -------------
  {
    name: 'create_list',
    family: 'campaign',
    description:
      'Create a lead list (a named set of sourced people, independent of any ' +
      'campaign). Returns the new list id. The web UI ListsView reads the same ' +
      'lead_lists table, so it appears there immediately.',
    privileged: false,
    inputShape: { name: z.string().min(1), description: z.string().optional() },
    handler: (a, p) =>
      p.lists.createList(a.description ? { name: a.name, description: a.description } : { name: a.name }),
  },
  {
    name: 'list_lists',
    family: 'campaign',
    description: 'List all lead lists with their member counts.',
    privileged: false,
    inputShape: {},
    handler: (_a, p) => p.lists.listLists(),
  },
  {
    name: 'get_list',
    family: 'campaign',
    description: 'Read one lead list with its members.',
    privileged: false,
    inputShape: { listId: z.string() },
    handler: (a, p) => p.lists.getList(a.listId),
  },
  {
    name: 'source_to_list',
    family: 'campaign',
    description:
      'Run a live people search and write the matches into a lead list in one ' +
      'call. Target an existing list with listId, or create one by passing ' +
      'listName. Facets are free-tier Voyager (see source_people); seniority is ' +
      'approximated via titleKeywords. Idempotent: a person already in the list ' +
      '(unique on listId + linkedinUrn) is skipped, so re-running is safe. ' +
      'Returns { listId, found, inserted, duplicates }. Results land in the same ' +
      'lead_list_members table the web UI reads.',
    privileged: false,
    inputShape: {
      accountId: z.string(),
      query: z.string().optional(),
      ...peopleFacetShape,
      limit: z.number().int().positive().max(1000).default(25),
      listId: z.string().optional(),
      listName: z.string().optional(),
    },
    handler: async (a, p) => {
      if (!a.listId && !a.listName) {
        throw new Error('source_to_list: provide either listId or listName');
      }
      // Resolve the target list up front (create it when only a name was given).
      const listId = a.listId ?? (await p.lists.createList({ name: a.listName! })).id;
      const people = await p.observe.searchPeople(a.accountId, toPeopleQuery(a), a.limit);
      const { inserted, duplicates } = await p.lists.insertMembers(listId, people);
      return { listId, found: people.length, inserted, duplicates };
    },
  },
];

// ---------------------------------------------------------------------------
// Approval (human only, privileged).
// ---------------------------------------------------------------------------

const approvalTools: ToolDef[] = [
  {
    name: 'list_pending',
    family: 'approval',
    description: 'List items awaiting approval.',
    privileged: true,
    inputShape: { campaignId: z.string().optional() },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'list_pending');
      return p.approval.listPending(a.campaignId);
    },
  },
  {
    name: 'approve',
    family: 'approval',
    description: 'Approve a pending item as-is and dispatch it.',
    privileged: true,
    inputShape: { pendingId: z.string() },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'approve');
      return p.approval.approve(a.pendingId, ctx.operator);
    },
  },
  {
    name: 'edit_and_approve',
    family: 'approval',
    description: 'Edit a pending item body then approve and dispatch.',
    privileged: true,
    inputShape: { pendingId: z.string(), body: z.string().min(1) },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'edit_and_approve');
      return p.approval.editAndApprove(a.pendingId, ctx.operator, a.body);
    },
  },
  {
    name: 'reject',
    family: 'approval',
    description: 'Reject a pending item; nothing is dispatched.',
    privileged: true,
    inputShape: { pendingId: z.string(), reason: z.string() },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'reject');
      return p.approval.reject(a.pendingId, ctx.operator, a.reason);
    },
  },
  {
    name: 'set_autonomy_level',
    family: 'approval',
    description: 'Set the autonomy dial for a campaign.',
    privileged: true,
    inputShape: { campaignId: z.string(), level: autonomyEnum },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'set_autonomy_level');
      return p.campaign.setAutonomyLevel(a.campaignId, a.level);
    },
  },
];

// ---------------------------------------------------------------------------
// Safety & admin (privileged). pause_account and kill_all bypass the scheduler
// entirely (they call the admin port directly), so they stay callable even if
// other subsystems are wedged.
// ---------------------------------------------------------------------------

const safetyTools: ToolDef[] = [
  {
    name: 'pause_account',
    family: 'safety',
    description: 'Pause an account immediately. Bypasses the scheduler.',
    privileged: true,
    inputShape: { accountId: z.string(), reason: z.string().default('operator pause') },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'pause_account');
      return p.admin.pauseAccount(a.accountId, a.reason);
    },
  },
  {
    name: 'resume_account',
    family: 'safety',
    description: 'Resume a paused account.',
    privileged: true,
    inputShape: { accountId: z.string() },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'resume_account');
      return p.admin.resumeAccount(a.accountId);
    },
  },
  {
    name: 'kill_all',
    family: 'safety',
    description: 'Global kill switch: halt every account immediately. Bypasses the scheduler.',
    privileged: true,
    inputShape: { reason: z.string().default('operator kill_all') },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'kill_all');
      return p.admin.killAll(a.reason);
    },
  },
  {
    name: 'get_health',
    family: 'safety',
    description: 'Read an account health report.',
    privileged: true,
    inputShape: { accountId: z.string() },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'get_health');
      return p.admin.getHealth(a.accountId);
    },
  },
  {
    name: 'rotate_session',
    family: 'safety',
    description: 'Rotate the browser session / credentials for an account.',
    privileged: true,
    inputShape: { accountId: z.string() },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'rotate_session');
      return p.admin.rotateSession(a.accountId);
    },
  },
  {
    name: 'audit_log',
    family: 'safety',
    description: 'Read the append-only audit log for an account.',
    privileged: true,
    inputShape: { accountId: z.string(), limit: z.number().int().positive().max(500).default(100) },
    handler: (a, p, ctx) => {
      requirePrivileged(ctx, 'audit_log');
      return p.admin.auditLog(a.accountId, a.limit);
    },
  },
];

/** All tools, in family order. */
export const ALL_TOOLS: ToolDef[] = [
  ...observeTools,
  ...actTools,
  ...campaignTools,
  ...approvalTools,
  ...safetyTools,
];

/** Lookup by name. */
export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
