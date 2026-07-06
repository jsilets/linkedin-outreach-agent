// mcp port adapters: reshape the ONE orchestrator + store + executor onto the
// mcp Ports surface (approval, campaign, admin, observe). safety and executor
// ports are built elsewhere; compose() assembles the full Ports object.
//
// Approval reconciliation: the orchestrator ApprovalService speaks in
// pendingItemRef + Message rows; the mcp ApprovalPort speaks in PendingItem
// {id, req, ...} and its approve/editAndApprove DISPATCH the underlying action
// via the executor. We bridge by keeping the originating ActRequest keyed by the
// draft message id, so approve can (a) mark the draft sent through the service,
// which writes the approval row + event, then (b) dispatch the real action.

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
} from '@loa/mcp';
import type { ApprovalDecision } from '@loa/shared';
import type { db as shared } from '@loa/shared';
import { DefaultSafetyGate } from '@loa/safety';
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
 * Bridges the mcp ApprovalPort onto the orchestrator ApprovalService. Keeps the
 * ActRequest for each queued draft so approve() can dispatch it.
 */
export class ApprovalAdapter implements ApprovalPort {
  private readonly reqByRef = new Map<string, ActRequest>();

  constructor(
    private readonly services: OrchestratorServices,
    private readonly executor: ExecutorPort,
    private readonly store: RuntimeStore,
  ) {}

  /** Register a ref -> ActRequest binding (used by the loop persistence path
   * too, so an approved loop-drafted send can also dispatch). */
  bind(pendingItemRef: string, req: ActRequest): void {
    this.reqByRef.set(pendingItemRef, req);
  }

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
    });
    this.reqByRef.set(item.pendingItemRef, req);
    return {
      id: item.pendingItemRef,
      req,
      autonomyLevel: _autonomyLevel,
      draftBody: item.message.body,
      createdAt: item.message.createdAt,
    };
  }

  async listPending(campaignId?: string): Promise<PendingItem[]> {
    // Drafts are looked up by thread ref; we hold the req map, so enumerate it.
    const out: PendingItem[] = [];
    for (const [ref, req] of this.reqByRef) {
      if (campaignId && req.campaignId !== campaignId) continue;
      const items = await this.services.approvals.listPending(sendThreadRef(req));
      const match = items.find((i) => i.pendingItemRef === ref);
      if (!match) continue; // already decided
      out.push({
        id: ref,
        req,
        autonomyLevel: 'supervised',
        draftBody: match.message.body,
        createdAt: match.message.createdAt,
      });
    }
    return out;
  }

  async approve(pendingId: string, editor: string) {
    await this.services.approvals.approve(pendingId, editor);
    const action = await this.dispatch(pendingId);
    await this.onApprovalResolved(action.targetId, 'approved');
    return action;
  }

  async editAndApprove(pendingId: string, editor: string, body: string) {
    await this.services.approvals.editAndApprove(pendingId, editor, body);
    const action = await this.dispatch(pendingId);
    await this.onApprovalResolved(action.targetId, 'approved');
    return action;
  }

  async reject(pendingId: string, editor: string, _reason: string): Promise<void> {
    const req = this.reqByRef.get(pendingId);
    await this.services.approvals.reject(pendingId, editor);
    this.reqByRef.delete(pendingId);
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

  /** Dispatch the underlying action through the executor after sign-off. */
  private async dispatch(pendingId: string) {
    const req = this.reqByRef.get(pendingId);
    if (!req) {
      throw new Error(`no ActRequest bound to pending item ${pendingId}`);
    }
    this.reqByRef.delete(pendingId);
    return this.executor.execute(req);
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
  ) {}

  async createCampaign(input: {
    goal: string;
    autonomyLevel: AutonomyLevel;
    messageStrategy: string;
    owner: string;
  }): Promise<Campaign> {
    return this.services.campaigns.createCampaign(input);
  }

  async addTargets(campaignId: string, prospectRefs: string[]): Promise<Target[]> {
    // The mcp port passes bare prospect refs; the service wants prospectRef +
    // linkedinUrn. Mint a deterministic urn from the ref for dev/smoke. A live
    // sourcing layer supplies real urns via attachExternalContext / addTargets.
    return this.services.campaigns.addTargets(
      campaignId,
      prospectRefs.map((prospectRef) => ({
        prospectRef,
        linkedinUrn: `urn:li:person:${prospectRef}`,
      })),
    );
  }

  async attachExternalContext(targetId: string, context: Json): Promise<Target> {
    return this.services.campaigns.attachExternalContext(targetId, context);
  }

  async getAccountState(accountId: string): Promise<Account> {
    const row = await this.store.account.findById(accountId);
    if (!row) throw new Error(`account not found: ${accountId}`);
    return rowToAccount(row);
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

/** mcp AccountAdminPort: privileged safety controls over the store + gate. The
 * kill switch and pause/resume never route through the scheduler; they mutate
 * account state directly and record an event, so they stay reachable. */
export class AccountAdminAdapter implements AccountAdminPort {
  private readonly paused = new Set<string>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly gate: DefaultSafetyGate,
    private readonly services: OrchestratorServices,
  ) {}

  async pauseAccount(accountId: string, reason: string): Promise<void> {
    this.paused.add(accountId);
    await this.services.eventLog.recordEvent('account_paused', accountId, { reason });
  }

  async resumeAccount(accountId: string): Promise<void> {
    this.paused.delete(accountId);
    await this.services.eventLog.recordEvent('account_resumed', accountId, {});
  }

  async killAll(reason: string): Promise<void> {
    const rows = await this.store.account.all();
    for (const r of rows) this.paused.add(r.id);
    await this.services.eventLog.recordEvent('kill_all', null, {
      reason,
      accounts: rows.length,
    });
  }

  isPaused(accountId: string): boolean {
    return this.paused.has(accountId);
  }

  async getHealth(accountId: string): Promise<HealthReport> {
    const row = await this.store.account.findById(accountId);
    if (!row) throw new Error(`account not found: ${accountId}`);
    const acct = rowToAccount(row);
    return {
      accountId,
      state: acct.state,
      budget: this.gate.budget(acct),
      paused: this.paused.has(accountId),
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
}
