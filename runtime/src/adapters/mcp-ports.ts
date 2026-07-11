// mcp port adapters: reshape the ONE orchestrator + store + executor onto the
// mcp Ports surface (approval, campaign, admin, observe). safety and executor
// ports are built elsewhere; compose() assembles the full Ports object.
//
// Approval reconciliation: the orchestrator ApprovalService speaks in
// pendingItemRef + Message rows; the mcp ApprovalPort speaks in PendingItem
// {id, req, ...} and its approve/editAndApprove DISPATCH the underlying action
// via the executor. We bridge by PERSISTING the originating ActRequest on the
// draft message row (pendingReq), so approve can (a) mark the draft sent through
// the service, which writes the approval row + event, then (b) dispatch the real
// action. Persisting rather than holding it in memory is what lets list_pending
// and approve keep working after a runtime restart.

import { extractCompany } from '@loa/shared';
import type {
  Account,
  AutonomyLevel,
  Campaign,
  Json,
  Target,
} from '@loa/shared';
import type {
  AccountAdminPort,
  ActRequest,
  ApprovalPort,
  AuditRecord,
  CampaignPort,
  CampaignStepView,
  EnrollResult,
  ExecutorPort,
  HealthReport,
  InsertMembersResult,
  LeadListPort,
  ListDetail,
  ListSummary,
  Metrics,
  ObservePort,
  PendingItem,
  ProfileSummary,
  PostSummary,
  EngagerSummary,
  JobSummary,
  ConversationSummary,
  PersonSearchResult,
  QueueEntry,
  SequenceStepInput,
  TargetInput,
} from '@loa/mcp';
import type { ApprovalDecision } from '@loa/shared';
import type { db as shared } from '@loa/shared';
import { DefaultSafetyGate } from '@loa/safety';
import type { PauseRegistry } from './safety-state.js';
import type { OrchestratorServices } from './orchestrator.js';
import type { RuntimeStore } from '../store/index.js';
import { advanceAfterStep } from '../dispatch/advance.js';
import { rowToAccount } from '../mappers.js';

/** Map a stored campaign-step row onto the port view shape. */
function toStepView(row: shared.CampaignStepRow): CampaignStepView {
  return {
    id: row.id,
    stepOrder: row.stepOrder,
    stepType: row.stepType,
    delaySeconds: row.delaySeconds,
    note: row.note,
    body: row.body,
    reaction: row.reaction,
    enabled: row.enabled,
  };
}

/** Thread ref used for pending sends that are not replies to a thread yet. */
function sendThreadRef(req: ActRequest): string {
  return `pending:${req.accountId}:${req.targetId}`;
}

/**
 * Bridges the mcp ApprovalPort onto the orchestrator ApprovalService. The
 * ActRequest for each queued draft is PERSISTED on the message row (pendingReq),
 * not held in memory, so list_pending and approve/reject keep working after a
 * runtime restart. Every read of the binding goes back to the store.
 */
export class ApprovalAdapter implements ApprovalPort {
  constructor(
    private readonly services: OrchestratorServices,
    private readonly executor: ExecutorPort,
    private readonly store: RuntimeStore,
  ) {}

  async enqueue(
    req: ActRequest,
    _autonomyLevel: AutonomyLevel,
    draftBody?: string,
  ): Promise<PendingItem> {
    const item = await this.services.approvals.enqueuePending({
      accountId: req.accountId,
      targetId: req.targetId,
      campaignId: req.campaignId,
      threadRef: sendThreadRef(req),
      draft: { body: draftBody ?? bodyFromPayload(req) },
      pendingReq: req,
    });
    return {
      id: item.pendingItemRef,
      req,
      autonomyLevel: _autonomyLevel,
      draftBody: item.message.body,
      createdAt: item.message.createdAt,
    };
  }

  async listPending(campaignId?: string): Promise<PendingItem[]> {
    // Sourced from the store, so a restart does not empty the queue. Each draft
    // carries its persisted ActRequest; skip any that predates the binding
    // column (it can no longer be dispatched) and filter by campaign.
    const items = await this.services.approvals.listAllPending();
    const out: PendingItem[] = [];
    for (const item of items) {
      const req = item.pendingReq as ActRequest | undefined;
      if (!req) continue;
      if (campaignId && req.campaignId !== campaignId) continue;
      out.push({
        id: item.pendingItemRef,
        req,
        autonomyLevel: 'supervised',
        draftBody: item.message.body,
        createdAt: item.message.createdAt,
      });
    }
    return out;
  }

  async approve(pendingId: string, editor: string) {
    // Dispatch FIRST, record the decision only on a genuinely-sent action.
    // Ordering matters twice over: (a) a mint-time safety deferral (cap hit,
    // outside hours, pacer) throws before anything is recorded, so the draft
    // stays pending and the operator's approval is not consumed by a send that
    // never happened; (b) a failed page drive leaves the draft re-approvable
    // instead of marking an unsent message 'sent'.
    const action = await this.dispatch(pendingId);
    if (action.result !== 'success') return action;
    await this.services.approvals.approve(pendingId, editor);
    await this.onApprovalResolved(action.targetId, 'approved');
    return action;
  }

  async editAndApprove(pendingId: string, editor: string, body: string) {
    // Same dispatch-first ordering as approve(). The edited body is passed
    // straight to the executor: the persisted ActRequest still carries the
    // ORIGINAL draft payload, so dispatching it unedited would send the text
    // the operator explicitly rewrote.
    const action = await this.dispatch(pendingId, body);
    if (action.result !== 'success') return action;
    await this.services.approvals.editAndApprove(pendingId, editor, body);
    await this.onApprovalResolved(action.targetId, 'approved');
    return action;
  }

  async reject(pendingId: string, editor: string, _reason: string): Promise<void> {
    const req = (await this.services.approvals.getPendingReq(pendingId)) as ActRequest | undefined;
    await this.services.approvals.reject(pendingId, editor);
    if (req) await this.onApprovalResolved(req.targetId, 'rejected');
  }

  /** Resume a sequence cursor parked in awaiting_approval once its step's
   * approval resolves. Approve advances to the next step; reject stops the
   * enrollment (terminal 'skipped') so it is not silently carried forward. A
   * no-op when the target is not sequence-driven (a direct Act-tool approval)
   * or its cursor is not parked. */
  private async onApprovalResolved(
    targetId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void> {
    const prog = await this.store.sequence.getTargetProgressByTarget(targetId);
    if (!prog || prog.state !== 'awaiting_approval') return;
    if (outcome === 'rejected') {
      await this.store.sequence.advanceTargetProgress(prog.id, {
        state: 'skipped',
        nextStepAt: null,
      });
      return;
    }
    const steps = (await this.store.sequence.listCampaignSteps(prog.campaignId)).filter(
      (s) => s.enabled,
    );
    await this.store.sequence.advanceTargetProgress(
      prog.id,
      advanceAfterStep(steps, prog.currentStep, new Date()),
    );
  }

  async record(pendingId: string, decision: ApprovalDecision, editor: string): Promise<void> {
    // record() is an audit-only decision log. Route through the matching
    // service method so an approval row + event are written.
    if (decision === 'approved') await this.services.approvals.approve(pendingId, editor);
    else if (decision === 'edited') {
      // No new body supplied on a bare record; re-approve as-is.
      await this.services.approvals.approve(pendingId, editor);
    } else await this.services.approvals.reject(pendingId, editor);
  }

  /** Dispatch the underlying action through the executor after sign-off. The
   * ActRequest is read back from the store (it was persisted at enqueue time),
   * so this works even on the first approval after a restart. An edited body
   * overrides the persisted payload so the operator's rewrite is what sends. */
  private async dispatch(pendingId: string, bodyOverride?: string) {
    const req = (await this.services.approvals.getPendingReq(pendingId)) as ActRequest | undefined;
    if (!req) {
      throw new Error(`no ActRequest bound to pending item ${pendingId}`);
    }
    return this.executor.execute(
      bodyOverride === undefined ? req : { ...req, payload: bodyOverride },
    );
  }
}

function bodyFromPayload(req: ActRequest): string {
  return typeof req.payload === 'string' ? req.payload : '';
}

/** mcp CampaignPort over the orchestrator CampaignService + store. */
export class CampaignAdapter implements CampaignPort {
  constructor(
    private readonly services: OrchestratorServices,
    private readonly store: RuntimeStore,
    private readonly gate: DefaultSafetyGate,
  ) {}

  /**
   * Attach the LIVE budget to an account for display: caps from the account's
   * limits (via the gate), used reset for today. The persisted row.budget only
   * stores yesterday's counters and a caps blob seeded to zero at creation, so
   * returning it raw shows a misleading "all caps 0". Callers see enforced caps.
   */
  private withLiveBudget(acct: Account): Account {
    return { ...acct, budget: this.gate.budget(acct) };
  }

  async createCampaign(input: {
    goal: string;
    autonomyLevel: AutonomyLevel;
    messageStrategy: string;
    owner: string;
  }): Promise<Campaign> {
    return this.services.campaigns.createCampaign(input);
  }

  async addTargets(
    campaignId: string,
    targets: Array<string | TargetInput>,
  ): Promise<Target[]> {
    // A bare string is a manual/dev ref: mint a deterministic urn. A structured
    // TargetInput (e.g. a search_people result) carries the real urn; its extra
    // fields (profileUrl, name, headline, company, location, degree) are stored
    // as opaque external context so the funnel keeps the sourced identity.
    return this.services.campaigns.addTargets(
      campaignId,
      targets.map((t) => {
        if (typeof t === 'string') {
          return { prospectRef: t, linkedinUrn: `urn:li:person:${t}` };
        }
        const { prospectRef, linkedinUrn, ...rest } = t;
        const externalContext: Record<string, string> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) externalContext[k] = v;
        }
        // Auto-classify company from the headline when the source didn't carry
        // one (free-tier search has no company field; it's in the headline).
        if (!externalContext.currentCompany && externalContext.headline) {
          const c = extractCompany(externalContext.headline);
          if (c) externalContext.currentCompany = c;
        }
        return { prospectRef, linkedinUrn, externalContext: externalContext as Json };
      }),
    );
  }

  async attachExternalContext(targetId: string, context: Json): Promise<Target> {
    return this.services.campaigns.attachExternalContext(targetId, context);
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.store.account.all();
    return rows.map((r) => this.withLiveBudget(rowToAccount(r)));
  }

  async getAccountState(accountId: string): Promise<Account> {
    const row = await this.store.account.findById(accountId);
    if (!row) throw new Error(`account not found: ${accountId}`);
    return this.withLiveBudget(rowToAccount(row));
  }

  async getQueue(accountId: string): Promise<QueueEntry[]> {
    const rows = await this.store.action.listByAccount(accountId);
    return rows
      .filter((r) => r.result === 'pending')
      .map((r) => ({
        actionId: r.id,
        type: r.type,
        scheduledAt: r.scheduledAt,
        targetId: r.targetId,
      }));
  }

  async getMetrics(campaignId: string): Promise<Metrics> {
    // Derive funnel counts from target stages for this campaign.
    const targets = await this.store.listTargetsByCampaign(campaignId);
    let invited = 0;
    let connected = 0;
    let replied = 0;
    let won = 0;
    for (const t of targets) {
      if (['invited', 'connected', 'in_conversation', 'replied', 'won', 'lost'].includes(t.stage)) invited += 1;
      if (['connected', 'in_conversation', 'replied', 'won'].includes(t.stage)) connected += 1;
      if (['replied', 'won'].includes(t.stage)) replied += 1;
      if (t.stage === 'won') won += 1;
    }
    return { campaignId, invited, connected, replied, won };
  }

  async setAutonomyLevel(campaignId: string, level: AutonomyLevel): Promise<Campaign> {
    return this.services.campaigns.setAutonomyLevel(campaignId, level);
  }

  async listCampaignSteps(campaignId: string): Promise<CampaignStepView[]> {
    const rows = await this.store.sequence.listCampaignSteps(campaignId);
    return rows.map(toStepView);
  }

  async defineCampaignSteps(
    campaignId: string,
    steps: SequenceStepInput[],
  ): Promise<CampaignStepView[]> {
    // Validate before mutating so a bad step never half-replaces a sequence.
    steps.forEach((s, i) => {
      if (s.stepType === 'delay' && !(s.delaySeconds && s.delaySeconds > 0)) {
        throw new Error(`step ${i}: a delay step needs delaySeconds > 0`);
      }
      if (s.stepType === 'message' && !(s.body && s.body.trim())) {
        throw new Error(`step ${i}: a message step needs a non-empty body`);
      }
    });
    // Replace the whole template: clear existing, then insert in the given order.
    const existing = await this.store.sequence.listCampaignSteps(campaignId);
    for (const s of existing) await this.store.sequence.deleteCampaignStep(s.id);
    let order = 0;
    for (const s of steps) {
      await this.store.sequence.upsertCampaignStep({
        campaignId,
        stepOrder: order,
        stepType: s.stepType,
        delaySeconds: s.delaySeconds ?? 0,
        note: s.note ?? null,
        body: s.body ?? null,
        reaction: s.reaction ?? null,
        enabled: s.enabled ?? true,
      });
      order += 1;
    }
    const rows = await this.store.sequence.listCampaignSteps(campaignId);
    return rows.map(toStepView);
  }

  async enrollTargets(
    campaignId: string,
    targetIds: string[],
    accountId: string,
  ): Promise<EnrollResult> {
    const progressIds: string[] = [];
    for (const targetId of targetIds) {
      const row = await this.store.sequence.enrollTarget(campaignId, targetId, accountId);
      progressIds.push(row.id);
    }
    return { campaignId, accountId, enrolled: progressIds.length, progressIds };
  }
}

/** mcp LeadListPort over the store's lead-list surface. Maps a PersonSearchResult
 * onto a lead_list_members row the same way the source-to-list CLI does, so a
 * list filled over MCP is indistinguishable from one filled by the script and
 * shows up in the web UI's ListsView. */
export class LeadListAdapter implements LeadListPort {
  constructor(private readonly store: RuntimeStore) {}

  async createList(input: { name: string; description?: string }): Promise<{ id: string; name: string }> {
    const row = await this.store.leadList.createList(input);
    return { id: row.id, name: row.name };
  }

  async listLists(): Promise<ListSummary[]> {
    const rows = await this.store.leadList.listWithCounts();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      memberCount: r.memberCount,
    }));
  }

  async getList(listId: string): Promise<ListDetail | null> {
    const list = await this.store.leadList.findById(listId);
    if (!list) return null;
    const members = await this.store.leadList.listMembers(listId);
    return {
      id: list.id,
      name: list.name,
      description: list.description,
      members: members.map((m) => ({
        id: m.id,
        linkedinUrn: m.linkedinUrn,
        name: m.name,
        headline: m.headline,
        profileUrl: m.profileUrl,
        degree: m.degree,
        location: m.location,
        currentCompany: m.currentCompany,
      })),
    };
  }

  async insertMembers(
    listId: string,
    people: PersonSearchResult[],
  ): Promise<InsertMembersResult> {
    const rows = people
      .map((p) => memberRowFromPerson(listId, p))
      .filter((r): r is shared.NewLeadListMemberRow => !!r.linkedinUrn);
    const { inserted } = await this.store.leadList.insertMembers(rows);
    // Everything we tried to write minus what was newly inserted is a dup (or a
    // person dropped for lacking a stable urn); report against the write count.
    return { inserted, duplicates: rows.length - inserted };
  }
}

/** Map a search result onto a lead_list_members insert row. Mirrors the
 * source-to-list CLI's toMemberRow; linkedinUrn is the stable dedup identity. */
function memberRowFromPerson(
  listId: string,
  p: PersonSearchResult,
): shared.NewLeadListMemberRow {
  return {
    listId,
    linkedinUrn: p.entityUrn || p.linkedinUrn || p.profileUrl,
    name: p.name ?? null,
    headline: p.headline ?? null,
    profileUrl: p.profileUrl ?? null,
    degree: p.degree ?? null,
    location: p.location ?? null,
    currentCompany: p.currentCompany ?? extractCompany(p.headline) ?? null,
  };
}

/** mcp AccountAdminPort: privileged safety controls over the store + gate. The
 * kill switch and pause/resume never route through the scheduler; they mutate
 * the shared PauseRegistry — which the gate consults on EVERY canAct, so a
 * pause genuinely halts outbound work — and record an event per account, from
 * which the registry rehydrates after a restart. */
export class AccountAdminAdapter implements AccountAdminPort {
  constructor(
    private readonly store: RuntimeStore,
    private readonly gate: DefaultSafetyGate,
    private readonly services: OrchestratorServices,
    private readonly pause: PauseRegistry,
  ) {}

  async pauseAccount(accountId: string, reason: string): Promise<void> {
    this.pause.pause(accountId);
    await this.services.eventLog.recordEvent('account_paused', accountId, { reason });
  }

  async resumeAccount(accountId: string): Promise<void> {
    this.pause.resume(accountId);
    await this.services.eventLog.recordEvent('account_resumed', accountId, {});
  }

  async killAll(reason: string): Promise<void> {
    const rows = await this.store.account.all();
    // One account_paused event per account (not just the kill_all summary), so
    // the registry's per-account rehydrate replays the kill after a restart.
    for (const r of rows) {
      this.pause.pause(r.id);
      await this.services.eventLog.recordEvent('account_paused', r.id, {
        reason: `kill_all: ${reason}`,
      });
    }
    await this.services.eventLog.recordEvent('kill_all', null, {
      reason,
      accounts: rows.length,
    });
  }

  isPaused(accountId: string): boolean {
    return this.pause.isPaused(accountId);
  }

  async getHealth(accountId: string): Promise<HealthReport> {
    const row = await this.store.account.findById(accountId);
    if (!row) throw new Error(`account not found: ${accountId}`);
    const acct = rowToAccount(row);
    return {
      accountId,
      state: acct.state,
      budget: this.gate.budget(acct),
      paused: this.pause.isPaused(accountId),
    };
  }

  async rotateSession(accountId: string): Promise<void> {
    // Session rotation drives @loa/account-runner session.refresh/bootstrap.
    // TODO(p0): call the session lifecycle once a live browser is wired.
    await this.services.eventLog.recordEvent('session_rotation_requested', accountId, {});
  }

  async auditLog(accountId: string, limit: number): Promise<AuditRecord[]> {
    const rows = await this.store.event.listByAccount(accountId);
    return rows.slice(0, limit).map((r) => ({
      id: r.id,
      ts: r.ts,
      accountId: r.accountId ?? accountId,
      kind: r.kind,
      payload: r.payload as Json,
    }));
  }
}

/** Deterministic ObservePort for dev/smoke: canned profile/post reads. A live
 * deployment swaps in an account-runner backed observe. */
export class FakeObserve implements ObservePort {
  async getProfile(_accountId: string, linkedinUrn: string): Promise<ProfileSummary> {
    return {
      linkedinUrn,
      handle: linkedinUrn.split(':').pop() ?? linkedinUrn,
      name: 'Fake Person',
      headline: 'Head of Something at Example',
      raw: {},
    };
  }
  async getRecentPosts(
    _accountId: string,
    linkedinUrn: string,
    limit: number,
  ): Promise<PostSummary[]> {
    return Array.from({ length: Math.min(limit, 2) }, (_v, i) => ({
      postUrn: `urn:li:post:${linkedinUrn}:${i}`,
      authorUrn: linkedinUrn,
      text: `A canned post ${i} about the industry.`,
      postedAt: new Date(),
    }));
  }
  async getPostEngagers(): Promise<EngagerSummary[]> {
    return [];
  }
  async getCompanyJobs(): Promise<JobSummary[]> {
    return [];
  }
  async getConversation(_accountId: string, threadRef: string): Promise<ConversationSummary> {
    return { threadRef, messages: [] };
  }
  async searchPeople(
    _accountId: string,
    _query: import('@loa/mcp').PeopleQuery,
    _limit: number,
  ): Promise<PersonSearchResult[]> {
    return [];
  }
  async listRecentConnections(
    _accountId: string,
    _limit: number,
  ): Promise<import('@loa/mcp').RecentConnection[]> {
    return [];
  }
}
