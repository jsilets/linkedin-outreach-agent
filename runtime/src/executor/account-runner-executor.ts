// AccountRunnerExecutor: adapts @loa/account-runner's real, human-like executor
// to the mcp/agent ExecutorPort. It persists the Action row first (so the token
// can bind to a real action id), mints an AllowToken through the runner
// SafetyPort, then drives the runner action functions with an ActionContext that
// carries that token. The executor's own gate refuses to touch the page without
// a token matching the exact action + account.
//
// This path is structurally complete and typechecks. It cannot RUN in dev/smoke:
// patchright is installed without browser binaries and no live Page/session is
// available. The one thing missing for P0 is the live session: a resolved
// { page } from @loa/account-runner's session.resume(). That injection point is
// marked with a TODO below. Everything up to and including token mint + gate
// enforcement is real.

import type { Account, Action, ActionType, Target } from '@loa/shared';
import type { ActRequest, ExecutorPort as McpExecutorPort } from '@loa/mcp';
import type {
  ExecIntent,
  ExecutorPort as AgentExecutorPort,
  Observation,
} from '@loa/agent';
import type {
  ActionContext,
  AllowToken,
  PagePort,
  SafetyPort as RunnerSafetyPort,
  Sleeper,
} from '@loa/account-runner';
import {
  connect as runnerConnect,
  follow as runnerFollow,
  message as runnerMessage,
  react as runnerReact,
  visitProfile as runnerVisitProfile,
  withdrawInvite as runnerWithdrawInvite,
  type ActionResultOut,
} from '@loa/account-runner';
import type { RuntimeStore } from '../store/index.js';
import type {
  StoreBackedActionPacer,
  StoreBackedWeeklyInviteCounter,
} from '../adapters/safety-state.js';
import { rowToAccount, rowToTarget } from '../mappers.js';

/** Resolves the live browser session for an account. In P0 this comes from
 * @loa/account-runner session.resume(); dev/smoke never construct one. */
export interface SessionProvider {
  /** Return the live Page for this account, or throw if none is available. */
  pageFor(accountId: string): Promise<PagePort>;
  /** Profile URL for a target (built from its LinkedIn URN). */
  profileUrlFor(target: Target): string;
}

export interface AccountRunnerExecutorDeps {
  store: RuntimeStore;
  runnerSafety: RunnerSafetyPort;
  session: SessionProvider;
  /** Weekly-invite counter kept warm on each successful connect (matches the
   * fake executor). Optional so a wiring test can omit it. */
  weekly?: StoreBackedWeeklyInviteCounter;
  /** Action pacer kept warm on every successful action so the gate spaces the
   * next one apart. Optional so a wiring test can omit it. */
  pacer?: StoreBackedActionPacer;
  now?: () => Date;
  /** Between-step sleeper for the human-paced actions. Real (randomized 8-20s)
   * gaps by default; a test injects a no-op to run the wiring without waiting. */
  sleep?: Sleeper;
  /** RNG the actions pace with; defaults to Math.random. Injected in tests. */
  rng?: () => number;
}

export class AccountRunnerExecutor implements McpExecutorPort, AgentExecutorPort {
  private readonly store: RuntimeStore;
  private readonly runnerSafety: RunnerSafetyPort;
  private readonly session: SessionProvider;
  private readonly weekly?: StoreBackedWeeklyInviteCounter;
  private readonly pacer?: StoreBackedActionPacer;
  private readonly now: () => Date;
  private readonly sleep?: Sleeper;
  private readonly rng?: () => number;

  constructor(deps: AccountRunnerExecutorDeps) {
    this.store = deps.store;
    this.runnerSafety = deps.runnerSafety;
    this.session = deps.session;
    this.weekly = deps.weekly;
    this.pacer = deps.pacer;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep;
    this.rng = deps.rng;
  }

  async execute(req: ActRequest): Promise<Action> {
    const bodyPayload = typeof req.payload === 'string' ? req.payload : undefined;
    return this.runOne(req.type, req.accountId, req.targetId, req.campaignId, bodyPayload);
  }

  async act(_acct: Account, intent: ExecIntent): Promise<Action> {
    return this.runOne(
      intent.type,
      intent.accountId,
      intent.targetId,
      intent.campaignId,
      intent.body,
    );
  }

  async observe(_acct: Account, target: Target): Promise<Observation> {
    // A full observe would drive readInbox/getConversation against the live page
    // and diff against stored messages. TODO(p0): read new inbound off the live
    // session and map it to ObservedMessage[]. Until a page exists there is
    // nothing new to surface, so report an empty inbound set.
    return { target, inbound: [] };
  }

  private async runOne(
    type: ActionType,
    accountId: string,
    targetId: string,
    campaignId: string,
    body?: string,
  ): Promise<Action> {
    const accountRow = await this.store.account.findById(accountId);
    if (!accountRow) throw new Error(`account not found: ${accountId}`);
    const targetRow = await this.store.target.findById(targetId);
    if (!targetRow) throw new Error(`target not found: ${targetId}`);
    const account = rowToAccount(accountRow);
    const target = rowToTarget(targetRow);

    // Persist the action row first so the token binds to a real id.
    const scheduledAt = this.now();
    const row = await this.store.action.create({
      accountId,
      targetId,
      campaignId,
      type,
      scheduledAt,
      executedAt: null,
      result: 'pending',
      dedupKey: `${accountId}:${targetId}:${type}:${scheduledAt.getTime()}`,
    });
    const action: Action = {
      id: row.id,
      type: row.type,
      scheduledAt: row.scheduledAt,
      executedAt: row.executedAt,
      result: row.result,
      dedupKey: row.dedupKey,
      accountId: row.accountId,
      targetId: row.targetId,
      campaignId: row.campaignId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };

    // Mint the allow token bound to this exact action. The runner SafetyPort
    // re-checks canAct and refuses to mint unless the decision is allow.
    const token: AllowToken = await this.runnerSafety.mintToken(account, action);

    // Obtain the live Page from the resumed session. LiveSessionProvider.pageFor
    // is wired and proven (people-search runs over this same call on a real
    // account); it resumes the vaulted browser session for accountId.
    const page = await this.session.pageFor(accountId);
    const profileUrl = this.session.profileUrlFor(target);
    const ctx: ActionContext = {
      page,
      token,
      action,
      accountId,
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(this.rng ? { rng: this.rng } : {}),
    };

    const outcome = await this.drive(ctx, type, profileUrl, body);

    const executedAt = this.now();
    // The pacer spaces any browser activity, so record it whether or not the
    // action landed (we did drive the session either way).
    this.pacer?.record(accountId, executedAt);

    // Honor the action's own ok flag: a connect that was refused, email-gated,
    // or found no Connect control returns ok:false and must be recorded as a
    // failure — never a false success. Only a genuinely-sent invite counts.
    if (!outcome.ok) {
      await this.store.event.append({
        accountId,
        kind: 'action_failed',
        payload: { actionId: action.id, type, targetId, campaignId, detail: outcome.detail },
      });
      return { ...action, executedAt, result: 'failed', updatedAt: executedAt };
    }

    // Keep the in-memory safety state warm exactly like the fake executor: the
    // weekly ceiling counts connects that actually went out.
    if (type === 'connect') this.weekly?.record(accountId, executedAt);
    await this.store.event.append({
      accountId,
      kind: 'action_executed',
      payload: { actionId: action.id, type, targetId, campaignId, via: 'account_runner' },
    });
    return { ...action, executedAt, result: 'success', updatedAt: executedAt };
  }

  /** Dispatch to the matching runner action function, returning its outcome. */
  private async drive(
    ctx: ActionContext,
    type: ActionType,
    profileUrl: string,
    body?: string,
  ): Promise<ActionResultOut> {
    switch (type) {
      case 'connect':
        return runnerConnect(ctx, { profileUrl, note: body });
      case 'message':
        return runnerMessage(ctx, { profileUrl, body: body ?? '' });
      case 'view_profile':
        return runnerVisitProfile(ctx, profileUrl);
      case 'follow':
        return runnerFollow(ctx, profileUrl);
      case 'withdraw_invite':
        return runnerWithdrawInvite(ctx, { profileUrl });
      case 'react':
        return runnerReact(ctx, profileUrl);
      default: {
        const never: never = type;
        throw new Error(`unhandled action type: ${String(never)}`);
      }
    }
  }
}
