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
} from '@loa/account-runner';
import {
  connect as runnerConnect,
  follow as runnerFollow,
  message as runnerMessage,
  react as runnerReact,
  visitProfile as runnerVisitProfile,
  withdrawInvite as runnerWithdrawInvite,
} from '@loa/account-runner';
import type { RuntimeStore } from '../store/index.js';
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
  now?: () => Date;
}

export class AccountRunnerExecutor implements McpExecutorPort, AgentExecutorPort {
  private readonly store: RuntimeStore;
  private readonly runnerSafety: RunnerSafetyPort;
  private readonly session: SessionProvider;
  private readonly now: () => Date;

  constructor(deps: AccountRunnerExecutorDeps) {
    this.store = deps.store;
    this.runnerSafety = deps.runnerSafety;
    this.session = deps.session;
    this.now = deps.now ?? (() => new Date());
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

    // TODO(p0): obtain the live Page from a resumed session. session.pageFor
    // throws until a real browser is wired; that is the only gap to running this
    // executor for real.
    const page = await this.session.pageFor(accountId);
    const profileUrl = this.session.profileUrlFor(target);
    const ctx: ActionContext = { page, token, action, accountId };

    await this.drive(ctx, type, profileUrl, body);

    // Mark the row executed. AccountRepo/ActionRepo expose no setResult on the
    // runtime store surface yet, so we append an audit event; the executed
    // Action is returned with executedAt set for callers.
    const executedAt = this.now();
    await this.store.event.append({
      accountId,
      kind: 'action_executed',
      payload: { actionId: action.id, type, targetId, campaignId, via: 'account_runner' },
    });
    return { ...action, executedAt, result: 'success', updatedAt: executedAt };
  }

  /** Dispatch to the matching runner action function. */
  private async drive(
    ctx: ActionContext,
    type: ActionType,
    profileUrl: string,
    body?: string,
  ): Promise<void> {
    switch (type) {
      case 'connect':
        await runnerConnect(ctx, { profileUrl, note: body });
        return;
      case 'message':
        await runnerMessage(ctx, { profileUrl, body: body ?? '' });
        return;
      case 'view_profile':
        await runnerVisitProfile(ctx, profileUrl);
        return;
      case 'follow':
        await runnerFollow(ctx, profileUrl);
        return;
      case 'withdraw_invite':
        await runnerWithdrawInvite(ctx, profileUrl);
        return;
      case 'react':
        await runnerReact(ctx, profileUrl);
        return;
      default: {
        const never: never = type;
        throw new Error(`unhandled action type: ${String(never)}`);
      }
    }
  }
}
