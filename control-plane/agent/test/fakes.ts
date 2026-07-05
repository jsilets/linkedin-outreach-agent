// Test fakes: an in-memory Anthropic seam and in-memory loop ports. No network,
// no DB. Each fake records calls so tests can assert on behavior.

import type {
  Account,
  AccountHealth,
  Action,
  Campaign,
  DailyBudget,
  Decision,
  Draft,
  Intent,
  Message,
  ProxyBinding,
  Target,
} from '@loa/shared';
import type {
  AnthropicSeam,
  SeamRequest,
  SeamResult,
} from '../src/anthropic-seam.js';
import type {
  ExecIntent,
  ExecutorPort,
  LLMPort,
  Observation,
  ObservedMessage,
  PersistencePort,
  SafetyPort,
  SchedulerPort,
} from '../src/ports.js';

/** A seam whose responses are scripted per request. */
export class FakeSeam implements AnthropicSeam {
  public requests: SeamRequest[] = [];
  constructor(private readonly responder: (req: SeamRequest) => SeamResult) {}
  async send(req: SeamRequest): Promise<SeamResult> {
    this.requests.push(req);
    return this.responder(req);
  }
}

export function textResult(text: string): SeamResult {
  return { text, refused: false, model: 'fake-model' };
}

export function toolResult(input: Record<string, unknown>): SeamResult {
  return {
    text: '',
    toolUse: { name: 'record_intent', input },
    refused: false,
    model: 'fake-model',
  };
}

export function refusalResult(): SeamResult {
  return { text: '', refused: true, model: 'fake-model' };
}

// --- domain fixtures -------------------------------------------------------

const proxy: ProxyBinding = { proxyId: 'p1', region: 'us', sticky: true };
const health: AccountHealth = {
  acceptanceRate: 0.4,
  replyRate: 0.2,
  challengesLast7d: 0,
  lastCheckedAt: new Date('2026-07-05T00:00:00Z'),
};
const budget: DailyBudget = {
  date: '2026-07-05',
  caps: { connect: 20, message: 20, view_profile: 40, follow: 10, withdraw_invite: 10, react: 20 },
  used: { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 },
};

export function fakeAccount(overrides: Partial<Account> = {}): Account {
  const now = new Date('2026-07-05T00:00:00Z');
  return {
    id: 'acct-1',
    handle: 'sender',
    proxyBinding: proxy,
    state: 'Active',
    health,
    budget,
    warmupDay: 10,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function fakeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  const now = new Date('2026-07-05T00:00:00Z');
  return {
    id: 'camp-1',
    goal: 'book intro calls',
    autonomyLevel: 'supervised',
    messageStrategy: 'warm, specific, no hard sell',
    owner: 'josh',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function fakeTarget(overrides: Partial<Target> = {}): Target {
  const now = new Date('2026-07-05T00:00:00Z');
  return {
    id: 'tgt-1',
    prospectRef: 'crm-42',
    linkedinUrn: 'urn:li:person:abc',
    externalContext: { company: 'Acme', role: 'Head of Ops' },
    stage: 'sourced',
    campaignId: 'camp-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function fakeMessage(overrides: Partial<Message> = {}): Message {
  const now = new Date('2026-07-05T00:00:00Z');
  return {
    id: 'msg-1',
    direction: 'inbound',
    body: 'hi',
    threadRef: 'thread-1',
    intent: null,
    status: 'sent',
    accountId: 'acct-1',
    targetId: 'tgt-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// --- port fakes ------------------------------------------------------------

export class FakeSafety implements SafetyPort {
  constructor(private readonly decision: Decision = { kind: 'allow' }) {}
  public calls: Action[] = [];
  canAct(_acct: Account, action: Action): Decision {
    this.calls.push(action);
    return this.decision;
  }
}

export class FakeExecutor implements ExecutorPort {
  public acted: ExecIntent[] = [];
  constructor(private readonly inbound: ObservedMessage[] = []) {}
  async observe(_acct: Account, target: Target): Promise<Observation> {
    return { target, inbound: this.inbound };
  }
  async act(_acct: Account, intent: ExecIntent): Promise<Action> {
    this.acted.push(intent);
    const now = new Date();
    return {
      id: 'act-executed',
      type: intent.type,
      scheduledAt: now,
      executedAt: now,
      result: 'success',
      dedupKey: `${intent.accountId}:${intent.targetId}:${intent.type}`,
      accountId: intent.accountId,
      targetId: intent.targetId,
      campaignId: intent.campaignId,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export class FakeScheduler implements SchedulerPort {
  public enqueued: unknown[] = [];
  async enqueueFollowUp(input: unknown): Promise<void> {
    this.enqueued.push(input);
  }
}

export interface RecordedEvent {
  kind: string;
  accountId: string;
  payload: unknown;
}

export class FakePersistence implements PersistencePort {
  public events: RecordedEvent[] = [];
  public pendingSends: unknown[] = [];
  public pendingReplies: unknown[] = [];
  public inbound: ObservedMessage[] = [];
  private suppressed = new Set<string>();
  private seq = 0;

  constructor(suppressedTargets: string[] = []) {
    for (const id of suppressedTargets) this.suppressed.add(id);
  }

  async enqueuePendingSend(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    draft: Draft;
  }): Promise<{ pendingItemRef: string }> {
    this.pendingSends.push(input);
    return { pendingItemRef: `pending-send-${this.seq++}` };
  }

  async enqueuePendingReply(input: {
    accountId: string;
    targetId: string;
    campaignId: string;
    threadRef: string;
    intent: Intent;
    draft: Draft;
  }): Promise<{ pendingItemRef: string }> {
    this.pendingReplies.push(input);
    return { pendingItemRef: `pending-reply-${this.seq++}` };
  }

  async recordInboundMessage(msg: ObservedMessage): Promise<Message> {
    this.inbound.push(msg);
    return fakeMessage({
      id: `stored-${this.seq++}`,
      body: msg.body,
      threadRef: msg.threadRef,
      accountId: msg.accountId,
      targetId: msg.targetId,
    });
  }

  async recordEvent(kind: string, accountId: string, payload: unknown): Promise<void> {
    this.events.push({ kind, accountId, payload });
  }

  async isSuppressed(targetId: string): Promise<boolean> {
    return this.suppressed.has(targetId);
  }
}

export class FakeLLM implements LLMPort {
  constructor(
    private readonly opts: {
      opener?: string;
      intent?: Intent;
      reply?: string;
    } = {},
  ) {}
  public classified: Message[] = [];
  async personalize(): Promise<Draft> {
    return { body: this.opts.opener ?? 'nice work at Acme', model: 'fake' };
  }
  async classifyReply(msg: Message): Promise<Intent> {
    this.classified.push(msg);
    return this.opts.intent ?? 'Interested';
  }
  async draftReply(): Promise<Draft> {
    return { body: this.opts.reply ?? 'happy to chat', model: 'fake' };
  }
}
