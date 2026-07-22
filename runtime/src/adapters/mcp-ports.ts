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

import type {
  AccountAdminPort,
  ActRequest,
  ApprovalOutcome,
  ApprovalPort,
  AuditRecord,
  CampaignPort,
  CampaignStepView,
  ConversationSummary,
  EngagerSummary,
  EnrollResult,
  ExecutorPort,
  HealthReport,
  InsertMembersResult,
  JobSummary,
  LeadListPort,
  ListDetail,
  ListSummary,
  Metrics,
  ObservePort,
  PendingItem,
  PersonSearchResult,
  PostSummary,
  ProfileSummary,
  QueueEntry,
  RemoveTargetsResult,
  SequenceStepInput,
  TargetInput,
  WithdrawStaleResult,
} from '@loa/mcp';
import type { DefaultSafetyGate } from '@loa/safety';
import { DEFAULT_CONFIG, effectiveSchedule } from '@loa/safety';
import type {
  Account,
  ApprovalDecision,
  AutonomyLevel,
  Campaign,
  Json,
  db as shared,
  Target,
} from '@loa/shared';
import {
  canonicalProfileKey,
  DEFAULT_CAPS,
  DEFAULT_SCHEDULE,
  extractCompany,
  planCampaignTargetRemoval,
  readIcpScore,
  wasTargetContacted,
} from '@loa/shared';
import {
  COMPANY_SOURCE_HEADLINE,
  COMPANY_SOURCE_PROFILE,
  type CompanyEnricher,
} from '../discovery/enrich.js';
import { advanceAfterStep } from '../dispatch/advance.js';
import { StaggerAllocator } from '../dispatch/stagger.js';
import type { StaleInvitationSweeper } from '../executor/withdraw-invitations.js';
import { rowToAccount } from '../mappers.js';
import type { RuntimeStore } from '../store/index.js';
import type { OrchestratorServices } from './orchestrator.js';
import type { PauseRegistry } from './safety-state.js';

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
    _executor: ExecutorPort,
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

  async approve(pendingId: string, editor: string): Promise<ApprovalOutcome> {
    // Approval does NOT dispatch. It marks the message 'approved'; the dispatch
    // tick sends it when the working-hours window is open and advances the
    // sequence cursor. So an approval given off-hours or on a day off goes out
    // at the next open window with no second approval, and the send is always
    // gated (caps / pacer / hours / days) at token-mint time.
    const decision = await this.services.approvals.approve(pendingId, editor);
    return { pendingId, targetId: decision.message.targetId, status: 'approved' };
  }

  async editAndApprove(pendingId: string, editor: string, body: string): Promise<ApprovalOutcome> {
    // Same deferred-send model as approve(). The edited body is persisted on the
    // message row; the tick sends THAT body (not the original draft).
    const decision = await this.services.approvals.editAndApprove(pendingId, editor, body);
    return { pendingId, targetId: decision.message.targetId, status: 'approved' };
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
    if (prog?.state !== 'awaiting_approval') return;
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
    /** Optional live enrichment. When wired (real session), a target whose
     * company is not yet profile-verified gets it verified off the real profile
     * at enroll time — so no one enters a campaign on a headline guess, even via
     * a direct enroll that skipped list scoring. Undefined in dev/smoke. */
    private readonly enricher?: CompanyEnricher,
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

  async addTargets(campaignId: string, targets: Array<string | TargetInput>): Promise<Target[]> {
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
        const { prospectRef, linkedinUrn, externalContext: passthrough, ...rest } = t;
        const externalContext: Record<string, Json> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) externalContext[k] = v as Json;
        }
        // Auto-classify company from the headline when the source didn't carry
        // one (free-tier search has no company field; it's in the headline). This
        // is a GUESS — stamp it so a "{Company}" merge won't trust it (a headline
        // like "COO @ X, ex. Tesla" mis-reads the former employer as current).
        if (!externalContext.currentCompany && typeof externalContext.headline === 'string') {
          const c = extractCompany(externalContext.headline);
          if (c) {
            externalContext.currentCompany = c;
            externalContext.companySource = COMPANY_SOURCE_HEADLINE;
          }
        }
        // A passthrough blob (e.g. an ICP score envelope, or a profile-verified
        // company) merges last, so a real company from an enriched list overrides
        // the headline guess above.
        if (passthrough && typeof passthrough === 'object' && !Array.isArray(passthrough)) {
          Object.assign(externalContext, passthrough);
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
      if (['invited', 'connected', 'in_conversation', 'replied', 'won', 'lost'].includes(t.stage))
        invited += 1;
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
      if (s.stepType === 'message' && !s.body?.trim()) {
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
    // Stagger nextStepAt across days so the stored schedule tells the truth:
    // the account's daily cap on the first step's action type means only `cap`
    // enrollments can fire per day, so everyone past that would sit "due now"
    // for days while the gate drip-fed them in arbitrary order.
    const now = new Date();
    const stagger = await this.enrollStagger(campaignId, accountId, now);
    const progressIds: string[] = [];
    let skippedRemoved = 0;
    let skippedCrossCampaign = 0;
    for (const targetId of targetIds) {
      // An operator-removed target must never re-enter the funnel; removal
      // stamps `removed` into the target's external context (see removeTargets).
      const target = await this.store.target.findById(targetId);
      const ec = (target?.externalContext ?? {}) as Record<string, unknown>;
      if (ec.removed === true) {
        skippedRemoved += 1;
        continue;
      }
      // Cross-campaign contact lock, enforced at enroll. A person already being
      // contacted (invited+) by another campaign must not be enrolled here — one
      // person belongs to one campaign at a time. The dispatch loop enforces the
      // same lock as a last resort (it refuses the second SEND), but letting the
      // cursor exist means it sits held every tick, re-logging
      // step_held_cross_campaign and reading as "stuck". Refusing up front keeps
      // the funnel honest. Keys on the canonical person urn so it matches however
      // the two campaigns sourced the same person; the skip is reported in the
      // result (mirrors skippedRemoved).
      if (target) {
        const others = await this.store.target.listByUrn(canonicalProfileKey(target.linkedinUrn));
        const contactedElsewhere = others.some(
          (t) => t.campaignId !== campaignId && wasTargetContacted(t.stage),
        );
        if (contactedElsewhere) {
          skippedCrossCampaign += 1;
          continue;
        }
      }
      // Verify the current company off the real profile before this person
      // becomes a live campaign target — unless it is already profile-verified
      // (the common enroll_from_list path carries it, so this is a cheap skip).
      // A failed read leaves the stored value; enrollment never blocks on it.
      if (this.enricher && target && ec.companySource !== COMPANY_SOURCE_PROFILE) {
        const got = await this.enricher.enrich(target.linkedinUrn, accountId);
        if (got) {
          await this.services.campaigns.attachExternalContext(targetId, {
            companySource: got.companySource,
            ...(got.currentCompany ? { currentCompany: got.currentCompany } : {}),
            ...(got.currentTitle ? { currentTitle: got.currentTitle } : {}),
          });
        }
      }
      // Day 0 keeps nextStepAt null (due now, today's budget); later days land
      // on the working-window start, skipping days off. An idempotent
      // re-enrollment still claims a slot (its existing row keeps its time);
      // that only pushes later work out — a day is never packed past the cap.
      const nextStepAt = stagger ? stagger.next() : null;
      const row = await this.store.sequence.enrollTarget(
        campaignId,
        targetId,
        accountId,
        nextStepAt,
      );
      progressIds.push(row.id);
    }
    return {
      campaignId,
      accountId,
      enrolled: progressIds.length,
      progressIds,
      skippedRemoved,
      skippedCrossCampaign,
    };
  }

  /** Slot allocator for a batch enrollment, capped by the account's daily
   * limit on the campaign's first enabled step and seeded with the first-step
   * due times already committed in this campaign — so a new batch fills the
   * earliest day with room instead of restarting at day 0 or double-booking a
   * morning. Undefined when there is nothing to stagger against: no steps
   * defined yet, a delay-typed first step (no cap applies), or a cap of 0
   * (the action is disabled; the gate blocks it). */
  private async enrollStagger(
    campaignId: string,
    accountId: string,
    now: Date,
  ): Promise<StaggerAllocator | undefined> {
    const steps = await this.store.sequence.listCampaignSteps(campaignId);
    const first = steps.find((s) => s.enabled);
    if (!first || first.stepType === 'delay') return undefined;
    const row = await this.store.account.findById(accountId);
    const limits = row ? rowToAccount(row).limits : undefined;
    const cap = limits?.caps[first.stepType] ?? DEFAULT_CAPS[first.stepType];
    if (cap <= 0) return undefined;
    const schedule = limits
      ? effectiveSchedule({ limits }, DEFAULT_CONFIG, first.stepType)
      : DEFAULT_SCHEDULE;
    const existing = await this.store.sequence.listTargetProgress(campaignId);
    const ledger = existing
      .filter((p) => p.state === 'in_progress' && p.currentStep === 0)
      .map((p) => p.nextStepAt);
    return new StaggerAllocator(now, cap, schedule, ledger);
  }

  async removeTargets(
    campaignId: string,
    selector: { targetIds?: string[]; linkedinUrns?: string[] },
    reason = 'removed by operator',
  ): Promise<RemoveTargetsResult> {
    // Resolve the selector to target ids scoped to this campaign. A URN or id
    // that doesn't belong to the campaign is reported back, not silently dropped.
    const inCampaign = await this.store.listTargetsByCampaign(campaignId);
    const byId = new Map(inCampaign.map((t) => [t.id, t] as const));
    // A urn can appear on more than one target row; map it to ALL of their ids so
    // removing by urn terminates every duplicate, not just the last one seen.
    const idsByUrn = new Map<string, string[]>();
    for (const t of inCampaign) {
      const ids = idsByUrn.get(t.linkedinUrn);
      if (ids) ids.push(t.id);
      else idsByUrn.set(t.linkedinUrn, [t.id]);
    }

    const notFound: string[] = [];
    const toRemove = new Set<string>();
    for (const id of selector.targetIds ?? []) {
      if (byId.has(id)) toRemove.add(id);
      else notFound.push(id);
    }
    for (const urn of selector.linkedinUrns ?? []) {
      const ids = idsByUrn.get(urn);
      if (ids) for (const id of ids) toRemove.add(id);
      else notFound.push(urn);
    }

    // Decide the removal (which targets go 'lost', event payloads) with the
    // shared policy, then apply it through the store ports. Stop the sequence +
    // cancel undelivered sends (terminal 'skipped', not 'replied'). A target is
    // marked 'lost' ONLY if it was already contacted: getMetrics counts 'lost'
    // in the invited bucket, so using it on a pre-contact target would inflate
    // invite metrics. The removal is still fully effective without the stage
    // change: the progress cursor lands terminal 'skipped', unsent messages are
    // cancelled, and the target_removed event records it.
    const owned = [...toRemove].map((id) => byId.get(id)!);
    const plan = planCampaignTargetRemoval(campaignId, owned, reason);
    const lost = new Set(plan.lostTargetIds);
    for (let i = 0; i < plan.decisions.length; i += 1) {
      const targetId = plan.decisions[i]!.targetId;
      const target = byId.get(targetId)!;
      await this.store.sequence.excludeTargetFromFunnel(targetId, plan.reason);
      if (lost.has(targetId)) await this.store.target.setStage(targetId, 'lost');
      // Durable removal marker. A never-enrolled target has no progress row, so
      // without this a later launch/enroll would sweep it back into the funnel;
      // both enroll paths skip targets carrying it.
      await this.store.target.setExternalContext(targetId, {
        ...((target.externalContext ?? {}) as Record<string, Json>),
        removed: true,
      });
      const ev = plan.events[i]!;
      await this.services.eventLog.recordEvent(ev.kind, ev.accountId, ev.payload as Json);
    }
    return { removed: plan.decisions.length, notFound };
  }
}

/** mcp LeadListPort over the store's lead-list surface. Maps a PersonSearchResult
 * onto a lead_list_members row the same way the source-to-list CLI does, so a
 * list filled over MCP is indistinguishable from one filled by the script and
 * shows up in the web UI's ListsView. */
export class LeadListAdapter implements LeadListPort {
  constructor(private readonly store: RuntimeStore) {}

  async createList(input: {
    name: string;
    description?: string;
  }): Promise<{ id: string; name: string }> {
    const row = await this.store.leadList.createList(input);
    return { id: row.id, name: row.name };
  }

  async updateList(
    listId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<ListSummary | null> {
    const row = await this.store.leadList.updateList(listId, patch);
    if (!row) return null;
    const members = await this.store.leadList.listMembers(listId);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      memberCount: members.length,
    };
  }

  async deleteList(listId: string): Promise<{ deleted: boolean; removedMembers: number }> {
    return this.store.leadList.deleteList(listId);
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
      members: members.map((m) => {
        const ec = (m.externalContext ?? {}) as Record<string, unknown>;
        const companySource = typeof ec.companySource === 'string' ? ec.companySource : null;
        // A profile-verified company overrides the stored column (a headline
        // guess); everything else falls back to the column.
        const currentCompany =
          companySource === COMPANY_SOURCE_PROFILE && typeof ec.currentCompany === 'string'
            ? ec.currentCompany
            : m.currentCompany;
        return {
          id: m.id,
          linkedinUrn: m.linkedinUrn,
          name: m.name,
          headline: m.headline,
          profileUrl: m.profileUrl,
          degree: m.degree,
          location: m.location,
          currentCompany,
          currentTitle: typeof ec.currentTitle === 'string' ? ec.currentTitle : null,
          companySource,
          ...readIcpScore(m.externalContext),
        };
      }),
    };
  }

  async insertMembers(listId: string, people: PersonSearchResult[]): Promise<InsertMembersResult> {
    const rows = people
      .map((p) => memberRowFromPerson(listId, p))
      .filter((r): r is shared.NewLeadListMemberRow => !!r.linkedinUrn);
    const { inserted } = await this.store.leadList.insertMembers(rows);
    // Everything we tried to write minus what was newly inserted is a dup (or a
    // person dropped for lacking a stable urn); report against the write count.
    return { inserted, duplicates: rows.length - inserted };
  }

  async removeMembers(listId: string, linkedinUrns: string[]): Promise<{ removed: number }> {
    return this.store.leadList.removeMembers(listId, linkedinUrns);
  }

  async knownUrns(urns: string[]): Promise<Set<string>> {
    // Spans targets + lead_list_members, so it lives on the store, not the
    // per-list surface. Lets source-to-list drop people already in the system.
    return this.store.knownUrns(urns);
  }
}

/** Map a search result onto a lead_list_members insert row. Mirrors the
 * source-to-list CLI's toMemberRow; linkedinUrn is the stable dedup identity. */
function memberRowFromPerson(listId: string, p: PersonSearchResult): shared.NewLeadListMemberRow {
  return {
    listId,
    // Persist the canonical bare person key, never the volatile search wrapper,
    // so the (listId, linkedinUrn) dedup index keys on the person. The search
    // normalizer already sets linkedinUrn to the bare form; entityUrn is the
    // wrapper. canonicalProfileKey unwraps either and passes a url ref through.
    linkedinUrn: canonicalProfileKey(p.linkedinUrn || p.entityUrn || p.profileUrl),
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
    /** The stale-invitation sweeper. Only wired with a real session (it reads +
     * withdraws over the live page); absent in fake mode, where the tool refuses. */
    private readonly invitations?: StaleInvitationSweeper,
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

  async withdrawStaleInvitations(
    accountId: string,
    opts: { olderThanDays: number; max: number },
  ): Promise<WithdrawStaleResult> {
    if (!this.invitations) {
      throw new Error(
        'withdraw_sent_invitations requires a real browser session (LOA_EXECUTOR=real); ' +
          'there is no live page to read or withdraw invites in fake mode',
      );
    }
    return this.invitations.withdrawStale(accountId, opts);
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
  async listSentInvitations(
    _accountId: string,
    _opts: { limit?: number; olderThanDays?: number },
  ): Promise<import('@loa/mcp').SentInvitationView[]> {
    return [];
  }
}
