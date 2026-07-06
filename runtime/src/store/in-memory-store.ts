// InMemoryStore: a Postgres-free implementation of the runtime store, promoted
// from the orchestrator's test fakes into a first-class store. Dev and smoke use
// this; a live deployment swaps in the Postgres store.
//
// The orchestrator's own fakes cover campaign/target/message/approval/event but
// not accounts or actions, which the runtime needs (the safety weekly counter
// reads action rows; the executor writes them). This store adds both. The
// account/action/event-read surfaces are async to match the RuntimeStore shape.

import { db as shared } from '@loa/shared';
import type {
  ApprovalRepoPort,
  CampaignRepoPort,
  EventRepoPort,
  MessageRepoPort,
  TargetRepoPort,
} from '@loa/orchestrator';
import type {
  AccountStorePort,
  ActionStorePort,
  EventReadPort,
  LeadListStorePort,
  RuntimeStore,
  SequenceStorePort,
  TargetProgressPatch,
} from './index.js';

type AccountRow = shared.AccountRow;
type NewAccountRow = shared.NewAccountRow;
type CampaignRow = shared.CampaignRow;
type NewCampaignRow = shared.NewCampaignRow;
type TargetRow = shared.TargetRow;
type NewTargetRow = shared.NewTargetRow;
type ActionRow = shared.ActionRow;
type NewActionRow = shared.NewActionRow;
type MessageRow = shared.MessageRow;
type NewMessageRow = shared.NewMessageRow;
type ApprovalRow = shared.ApprovalRow;
type NewApprovalRow = shared.NewApprovalRow;
type EventRow = shared.EventRow;
type NewEventRow = shared.NewEventRow;
type CampaignStepRow = shared.CampaignStepRow;
type NewCampaignStepRow = shared.NewCampaignStepRow;
type TargetProgressRow = shared.TargetProgressRow;
type LeadListRow = shared.LeadListRow;
type NewLeadListMemberRow = shared.NewLeadListMemberRow;
type LeadListMemberRow = shared.LeadListMemberRow;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

class InMemAccountStore implements AccountStorePort {
  readonly rows = new Map<string, AccountRow>();
  async create(row: NewAccountRow): Promise<AccountRow> {
    const now = new Date();
    const full: AccountRow = {
      id: row.id ?? nextId('acct'),
      handle: row.handle,
      proxyBinding: row.proxyBinding,
      state: row.state ?? 'Cold',
      health: row.health,
      budget: row.budget,
      warmupDay: row.warmupDay ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<AccountRow | undefined> {
    return this.rows.get(id);
  }
  async all(): Promise<AccountRow[]> {
    return [...this.rows.values()];
  }
  async update(id: string, patch: Partial<AccountRow>): Promise<AccountRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no account: ${id}`);
    const next: AccountRow = { ...cur, ...patch, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
}

class InMemActionStore implements ActionStorePort {
  readonly rows = new Map<string, ActionRow>();
  async create(row: NewActionRow): Promise<ActionRow> {
    const now = new Date();
    const full: ActionRow = {
      id: row.id ?? nextId('act'),
      accountId: row.accountId,
      targetId: row.targetId,
      campaignId: row.campaignId,
      type: row.type,
      scheduledAt: row.scheduledAt,
      executedAt: row.executedAt ?? null,
      result: row.result ?? 'pending',
      dedupKey: row.dedupKey,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<ActionRow | undefined> {
    return this.rows.get(id);
  }
  async listByAccount(accountId: string): Promise<ActionRow[]> {
    return [...this.rows.values()].filter((r) => r.accountId === accountId);
  }
}

class InMemCampaignRepo implements CampaignRepoPort {
  readonly rows = new Map<string, CampaignRow>();
  async create(row: NewCampaignRow): Promise<CampaignRow> {
    const now = new Date();
    const full: CampaignRow = {
      id: row.id ?? nextId('camp'),
      goal: row.goal,
      autonomyLevel: row.autonomyLevel ?? 'supervised',
      messageStrategy: row.messageStrategy,
      owner: row.owner,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<CampaignRow | undefined> {
    return this.rows.get(id);
  }
  async setAutonomy(id: string, level: CampaignRow['autonomyLevel']): Promise<CampaignRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no campaign: ${id}`);
    const next = { ...cur, autonomyLevel: level, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
}

class InMemTargetRepo implements TargetRepoPort {
  readonly rows = new Map<string, TargetRow>();
  async create(row: NewTargetRow): Promise<TargetRow> {
    const now = new Date();
    const full: TargetRow = {
      id: row.id ?? nextId('tgt'),
      campaignId: row.campaignId,
      prospectRef: row.prospectRef,
      linkedinUrn: row.linkedinUrn,
      externalContext: row.externalContext ?? {},
      stage: row.stage ?? 'sourced',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async createMany(rows: NewTargetRow[]): Promise<TargetRow[]> {
    const out: TargetRow[] = [];
    for (const r of rows) out.push(await this.create(r));
    return out;
  }
  async findById(id: string): Promise<TargetRow | undefined> {
    return this.rows.get(id);
  }
  async setExternalContext(id: string, blob: NewTargetRow['externalContext']): Promise<TargetRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no target: ${id}`);
    const next = { ...cur, externalContext: blob ?? {}, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
  async setStage(id: string, stage: TargetRow['stage']): Promise<TargetRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no target: ${id}`);
    const next = { ...cur, stage, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
}

class InMemMessageRepo implements MessageRepoPort {
  readonly rows = new Map<string, MessageRow>();
  async create(row: NewMessageRow): Promise<MessageRow> {
    const now = new Date();
    const full: MessageRow = {
      id: row.id ?? nextId('msg'),
      accountId: row.accountId,
      targetId: row.targetId,
      direction: row.direction,
      body: row.body,
      threadRef: row.threadRef,
      intent: row.intent ?? null,
      status: row.status ?? 'draft',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(full.id, full);
    return full;
  }
  async findById(id: string): Promise<MessageRow | undefined> {
    return this.rows.get(id);
  }
  async setStatus(id: string, status: MessageRow['status']): Promise<MessageRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no message: ${id}`);
    const next = { ...cur, status, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
  async setBody(id: string, body: string): Promise<MessageRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no message: ${id}`);
    const next = { ...cur, body, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }
  async listByThread(threadRef: string): Promise<MessageRow[]> {
    return [...this.rows.values()].filter((r) => r.threadRef === threadRef);
  }
}

class InMemApprovalRepo implements ApprovalRepoPort {
  readonly rows: ApprovalRow[] = [];
  async create(row: NewApprovalRow): Promise<ApprovalRow> {
    const full: ApprovalRow = {
      id: row.id ?? nextId('appr'),
      pendingItemRef: row.pendingItemRef,
      decision: row.decision,
      editor: row.editor,
      timestamp: new Date(),
    };
    this.rows.push(full);
    return full;
  }
}

/** Append-only in-memory event store. Only append + reads; no update or delete,
 * so the audit spine stays immutable by construction. */
class InMemEventRepo implements EventReadPort {
  readonly rows: EventRow[] = [];
  async append(row: NewEventRow): Promise<EventRow> {
    const full: EventRow = {
      id: row.id ?? nextId('evt'),
      ts: new Date(),
      accountId: row.accountId ?? null,
      kind: row.kind,
      payload: row.payload ?? {},
    };
    this.rows.push(full);
    return full;
  }
  async listSuppression(): Promise<EventRow[]> {
    return this.rows.filter((r) => r.accountId === null && r.kind === 'target_suppressed');
  }
  async listByAccount(accountId: string): Promise<EventRow[]> {
    return this.rows
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
  }
  async listAll(): Promise<EventRow[]> {
    return [...this.rows];
  }
}

/** In-memory campaign-sequence store: the step template plus per-target
 * enrollment cursors. Reads target/action rows off the sibling stores for the
 * count/volume aggregates. */
class InMemSequenceStore implements SequenceStorePort {
  readonly steps = new Map<string, CampaignStepRow>();
  readonly progress = new Map<string, TargetProgressRow>();

  constructor(
    private readonly targets: InMemTargetRepo,
    private readonly actions: InMemActionStore,
  ) {}

  async listCampaignSteps(campaignId: string): Promise<CampaignStepRow[]> {
    return [...this.steps.values()]
      .filter((s) => s.campaignId === campaignId)
      .sort((a, b) => a.stepOrder - b.stepOrder);
  }

  async upsertCampaignStep(step: NewCampaignStepRow): Promise<CampaignStepRow> {
    const now = new Date();
    if (step.id && this.steps.has(step.id)) {
      const cur = this.steps.get(step.id)!;
      const next: CampaignStepRow = {
        ...cur,
        campaignId: step.campaignId,
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        delaySeconds: step.delaySeconds ?? cur.delaySeconds,
        note: step.note ?? null,
        body: step.body ?? null,
        reaction: step.reaction ?? null,
        enabled: step.enabled ?? cur.enabled,
        updatedAt: now,
      };
      this.steps.set(next.id, next);
      return next;
    }
    const full: CampaignStepRow = {
      id: step.id ?? nextId('step'),
      campaignId: step.campaignId,
      stepOrder: step.stepOrder,
      stepType: step.stepType,
      delaySeconds: step.delaySeconds ?? 0,
      note: step.note ?? null,
      body: step.body ?? null,
      reaction: step.reaction ?? null,
      enabled: step.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.steps.set(full.id, full);
    return full;
  }

  async deleteCampaignStep(id: string): Promise<void> {
    this.steps.delete(id);
  }

  async reorderCampaignSteps(campaignId: string, orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, i) => {
      const cur = this.steps.get(id);
      if (!cur || cur.campaignId !== campaignId) return;
      this.steps.set(id, { ...cur, stepOrder: i, updatedAt: new Date() });
    });
  }

  async enrollTarget(
    campaignId: string,
    targetId: string,
    accountId: string,
  ): Promise<TargetProgressRow> {
    // Idempotent on targetId (unique index): return the existing enrollment.
    const existing = [...this.progress.values()].find((p) => p.targetId === targetId);
    if (existing) return existing;
    const now = new Date();
    const full: TargetProgressRow = {
      id: nextId('prog'),
      campaignId,
      targetId,
      accountId,
      currentStep: 0,
      state: 'in_progress',
      nextStepAt: null,
      lastStepAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.progress.set(full.id, full);
    return full;
  }

  async listTargetProgress(campaignId: string): Promise<TargetProgressRow[]> {
    return [...this.progress.values()].filter((p) => p.campaignId === campaignId);
  }

  async getTargetProgressByTarget(targetId: string): Promise<TargetProgressRow | undefined> {
    return [...this.progress.values()].find((p) => p.targetId === targetId);
  }

  async dueTargetProgress(now: Date): Promise<TargetProgressRow[]> {
    return [...this.progress.values()].filter(
      (p) =>
        p.state === 'in_progress' &&
        (p.nextStepAt === null || p.nextStepAt.getTime() <= now.getTime()),
    );
  }

  async advanceTargetProgress(id: string, patch: TargetProgressPatch): Promise<void> {
    const cur = this.progress.get(id);
    if (!cur) throw new Error(`no target progress: ${id}`);
    const next: TargetProgressRow = {
      ...cur,
      ...(patch.currentStep !== undefined ? { currentStep: patch.currentStep } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.nextStepAt !== undefined ? { nextStepAt: patch.nextStepAt } : {}),
      ...(patch.lastStepAt !== undefined ? { lastStepAt: patch.lastStepAt } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      updatedAt: new Date(),
    };
    this.progress.set(id, next);
  }

  async pullTargetFromFunnel(targetId: string, reason: string): Promise<void> {
    for (const [id, p] of this.progress) {
      if (p.targetId !== targetId) continue;
      // Terminal, and only from an active enrollment (including one parked for
      // approval); leave completed/failed/skipped/replied as-is.
      if (p.state !== 'in_progress' && p.state !== 'pending' && p.state !== 'awaiting_approval')
        continue;
      this.progress.set(id, {
        ...p,
        state: 'replied',
        nextStepAt: null,
        errorMessage: reason,
        updatedAt: new Date(),
      });
    }
  }

  async campaignCounts(campaignId: string): Promise<{
    targets: number;
    byStage: Record<string, number>;
    byProgressState: Record<string, number>;
  }> {
    const targets = [...this.targets.rows.values()].filter((t) => t.campaignId === campaignId);
    const byStage: Record<string, number> = {};
    for (const t of targets) byStage[t.stage] = (byStage[t.stage] ?? 0) + 1;
    const byProgressState: Record<string, number> = {};
    for (const p of this.progress.values()) {
      if (p.campaignId !== campaignId) continue;
      byProgressState[p.state] = (byProgressState[p.state] ?? 0) + 1;
    }
    return { targets: targets.length, byStage, byProgressState };
  }

  async actionVolume(
    accountId: string,
    sinceDays: number,
  ): Promise<Array<{ date: string; type: string; count: number }>> {
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const counts = new Map<string, { date: string; type: string; count: number }>();
    for (const a of this.actions.rows.values()) {
      if (a.accountId !== accountId) continue;
      const at = a.executedAt ?? a.scheduledAt;
      if (at.getTime() < cutoff) continue;
      const date = at.toISOString().slice(0, 10);
      const key = `${date} ${a.type}`;
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { date, type: a.type, count: 1 });
    }
    return [...counts.values()].sort((x, y) =>
      x.date === y.date ? x.type.localeCompare(y.type) : x.date.localeCompare(y.date),
    );
  }
}

/** In-memory lead-list store: named lists plus their members. Member inserts
 * dedup on (listId, linkedinUrn), mirroring the Postgres unique index. */
class InMemLeadListStore implements LeadListStorePort {
  readonly lists = new Map<string, LeadListRow>();
  readonly members = new Map<string, LeadListMemberRow>();

  async createList(input: { name: string; description?: string }): Promise<LeadListRow> {
    const now = new Date();
    const full: LeadListRow = {
      id: nextId('list'),
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.lists.set(full.id, full);
    return full;
  }

  async listWithCounts(): Promise<Array<LeadListRow & { memberCount: number }>> {
    return [...this.lists.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((l) => ({
        ...l,
        memberCount: [...this.members.values()].filter((m) => m.listId === l.id).length,
      }));
  }

  async findById(id: string): Promise<LeadListRow | undefined> {
    return this.lists.get(id);
  }

  async listMembers(listId: string): Promise<LeadListMemberRow[]> {
    return [...this.members.values()]
      .filter((m) => m.listId === listId)
      .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
  }

  async insertMembers(rows: NewLeadListMemberRow[]): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const row of rows) {
      // Skip anyone already in the list (unique on listId + linkedinUrn).
      const dup = [...this.members.values()].some(
        (m) => m.listId === row.listId && m.linkedinUrn === row.linkedinUrn,
      );
      if (dup) continue;
      const full: LeadListMemberRow = {
        id: nextId('member'),
        listId: row.listId,
        linkedinUrn: row.linkedinUrn,
        name: row.name ?? null,
        headline: row.headline ?? null,
        profileUrl: row.profileUrl ?? null,
        degree: row.degree ?? null,
        location: row.location ?? null,
        currentCompany: row.currentCompany ?? null,
        externalContext: row.externalContext ?? {},
        addedAt: new Date(),
      };
      this.members.set(full.id, full);
      inserted += 1;
    }
    return { inserted };
  }
}

/** The full in-memory store implementing RuntimeStore. */
export class InMemoryStore implements RuntimeStore {
  readonly account: InMemAccountStore = new InMemAccountStore();
  readonly action: InMemActionStore = new InMemActionStore();
  readonly campaign: InMemCampaignRepo = new InMemCampaignRepo();
  readonly target: InMemTargetRepo = new InMemTargetRepo();
  readonly message: InMemMessageRepo = new InMemMessageRepo();
  readonly approval: InMemApprovalRepo = new InMemApprovalRepo();
  readonly event: InMemEventRepo = new InMemEventRepo();
  readonly sequence: InMemSequenceStore = new InMemSequenceStore(this.target, this.action);
  readonly leadList: InMemLeadListStore = new InMemLeadListStore();
  async listTargetsByCampaign(campaignId: string): Promise<TargetRow[]> {
    return [...this.target.rows.values()].filter((t) => t.campaignId === campaignId);
  }
  async close(): Promise<void> {
    // Nothing to release.
  }
}

export function makeInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}
