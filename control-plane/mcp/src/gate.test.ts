// Unit tests for the autonomy chokepoint and privileged tool guard.
// All ports are mocked; no HTTP server and no network to LinkedIn.

import { describe, expect, it, vi } from 'vitest';
import type { Account, Action, Campaign, Decision } from '@loa/shared';
import { gateAct, mayExecuteDirectly, type GateDeps } from './gate.js';
import type { ActRequest, ExecutorPort, ApprovalPort, SafetyPort, PendingItem } from './ports.js';
import { requirePrivileged, CapabilityError } from './capability.js';
import { AGENT_CONTEXT, operatorContext } from './context.js';
import { TOOLS_BY_NAME } from './tools.js';
import type { Ports } from './ports.js';

// --- fixtures --------------------------------------------------------------

function makeAccount(): Account {
  return {
    id: 'acct-1',
    handle: 'jdoe',
    proxyBinding: { proxyId: 'p1', region: 'us', sticky: true },
    state: 'Active',
    health: { acceptanceRate: 0.4, replyRate: 0.2, challengesLast7d: 0, lastCheckedAt: new Date() },
    budget: {
      date: '2026-07-05',
      caps: { connect: 20, message: 20, view_profile: 20, follow: 20, withdraw_invite: 20, react: 20 },
      used: { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCampaign(autonomyLevel: Campaign['autonomyLevel']): Campaign {
  return {
    id: 'camp-1',
    goal: 'test',
    autonomyLevel,
    messageStrategy: 'friendly',
    owner: 'op',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeAction(type: ActRequest['type']): Action {
  return {
    id: 'action-1',
    type,
    scheduledAt: new Date(),
    executedAt: new Date(),
    result: 'success',
    dedupKey: 'k',
    accountId: 'acct-1',
    targetId: 'tgt-1',
    campaignId: 'camp-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function connectReq(): ActRequest {
  return { type: 'connect', accountId: 'acct-1', targetId: 'tgt-1', campaignId: 'camp-1' };
}
function messageReq(): ActRequest {
  return { type: 'message', accountId: 'acct-1', targetId: 'tgt-1', campaignId: 'camp-1', payload: 'hi' };
}

// Build gate deps with a given autonomy level and canAct decision.
function makeDeps(level: Campaign['autonomyLevel'], decision: Decision = { kind: 'allow' }) {
  const execute = vi.fn(async (req: ActRequest): Promise<Action> => makeAction(req.type));
  const enqueue = vi.fn(
    async (req: ActRequest, autonomyLevel: Campaign['autonomyLevel']): Promise<PendingItem> => ({
      id: 'pending-1',
      req,
      autonomyLevel,
      createdAt: new Date(),
    }),
  );
  const canAct = vi.fn(async (): Promise<Decision> => decision);

  const executor: ExecutorPort = { execute };
  const approval = { enqueue } as unknown as ApprovalPort;
  const safety: SafetyPort = {
    getAccount: vi.fn(async () => makeAccount()),
    getCampaign: vi.fn(async () => makeCampaign(level)),
    canAct,
  };

  const deps: GateDeps = { safety, approval, executor };
  return { deps, execute, enqueue, canAct };
}

// --- mayExecuteDirectly matrix --------------------------------------------

describe('mayExecuteDirectly', () => {
  it('supervised never executes directly', () => {
    expect(mayExecuteDirectly('supervised', 'connect')).toBe(false);
    expect(mayExecuteDirectly('supervised', 'message')).toBe(false);
    expect(mayExecuteDirectly('supervised', 'react')).toBe(false);
  });

  it('semi_auto executes connect/react but gates message', () => {
    expect(mayExecuteDirectly('semi_auto', 'connect')).toBe(true);
    expect(mayExecuteDirectly('semi_auto', 'react')).toBe(true);
    expect(mayExecuteDirectly('semi_auto', 'follow')).toBe(true);
    expect(mayExecuteDirectly('semi_auto', 'message')).toBe(false);
  });

  it('autonomous executes everything directly', () => {
    expect(mayExecuteDirectly('autonomous', 'connect')).toBe(true);
    expect(mayExecuteDirectly('autonomous', 'message')).toBe(true);
  });
});

// --- gateAct routing -------------------------------------------------------

describe('gateAct', () => {
  it('supervised blocks a direct send and enqueues an approval', async () => {
    const { deps, execute, enqueue } = makeDeps('supervised');
    const out = await gateAct(deps, connectReq());
    expect(out).toEqual({ kind: 'queued', pendingId: 'pending-1' });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('supervised gates messages too', async () => {
    const { deps, execute, enqueue } = makeDeps('supervised');
    const out = await gateAct(deps, messageReq(), 'hi');
    expect(out.kind).toBe('queued');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('semi_auto lets a connect through but gates a message', async () => {
    const { deps, execute, enqueue } = makeDeps('semi_auto');
    const connectOut = await gateAct(deps, connectReq());
    expect(connectOut).toEqual({ kind: 'executed', actionId: 'action-1' });
    expect(execute).toHaveBeenCalledOnce();

    const msgOut = await gateAct(deps, messageReq(), 'hi');
    expect(msgOut.kind).toBe('queued');
    expect(enqueue).toHaveBeenCalledOnce();
    // executor still only called the one time (for the connect).
    expect(execute).toHaveBeenCalledOnce();
  });

  it('autonomous dispatches a message directly', async () => {
    const { deps, execute } = makeDeps('autonomous');
    const out = await gateAct(deps, messageReq(), 'hi');
    expect(out).toEqual({ kind: 'executed', actionId: 'action-1' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('honors a canAct deny even when the level permits execution', async () => {
    const { deps, execute } = makeDeps('autonomous', { kind: 'deny', reason: 'restricted' });
    const out = await gateAct(deps, connectReq());
    expect(out).toEqual({ kind: 'denied', reason: 'restricted' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('honors a canAct defer even when the level permits execution', async () => {
    const until = new Date('2026-07-06T00:00:00Z');
    const { deps, execute } = makeDeps('semi_auto', { kind: 'defer', until });
    const out = await gateAct(deps, connectReq());
    expect(out).toEqual({ kind: 'deferred', until });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not consult canAct when the level forces a queue', async () => {
    const { deps, canAct } = makeDeps('supervised');
    await gateAct(deps, connectReq());
    // Structurally impossible to execute: we short-circuit to the queue before
    // even asking the safety gate.
    expect(canAct).not.toHaveBeenCalled();
  });
});

// --- capability guard ------------------------------------------------------

describe('requirePrivileged', () => {
  it('throws for the agent context', () => {
    expect(() => requirePrivileged(AGENT_CONTEXT, 'kill_all')).toThrow(CapabilityError);
  });

  it('passes for an operator context', () => {
    expect(() => requirePrivileged(operatorContext('operator'), 'kill_all')).not.toThrow();
  });
});

// --- privileged tools reject without the capability ------------------------

function stubPorts(overrides: Partial<Ports> = {}): Ports {
  const notImpl = () => {
    throw new Error('port should not be called in this test');
  };
  return {
    observe: {
      getProfile: notImpl,
      getRecentPosts: notImpl,
      getPostEngagers: notImpl,
      getCompanyJobs: notImpl,
      getConversation: notImpl,
      searchPeople: notImpl,
    } as unknown as Ports['observe'],
    executor: { execute: notImpl } as unknown as Ports['executor'],
    safety: { getAccount: notImpl, getCampaign: notImpl, canAct: notImpl } as unknown as Ports['safety'],
    approval: {
      enqueue: notImpl,
      listPending: notImpl,
      approve: notImpl,
      editAndApprove: notImpl,
      reject: notImpl,
      record: notImpl,
    } as unknown as Ports['approval'],
    campaign: {
      createCampaign: notImpl,
      addTargets: notImpl,
      attachExternalContext: notImpl,
      getAccountState: notImpl,
      getQueue: notImpl,
      getMetrics: notImpl,
      setAutonomyLevel: notImpl,
    } as unknown as Ports['campaign'],
    admin: {
      pauseAccount: notImpl,
      resumeAccount: notImpl,
      killAll: notImpl,
      getHealth: notImpl,
      rotateSession: notImpl,
      auditLog: notImpl,
    } as unknown as Ports['admin'],
    ...overrides,
  };
}

describe('privileged tool handlers', () => {
  const privilegedNames = [
    'list_pending',
    'approve',
    'edit_and_approve',
    'reject',
    'set_autonomy_level',
    'pause_account',
    'resume_account',
    'kill_all',
    'get_health',
    'rotate_session',
    'audit_log',
  ];

  it('every privileged tool is flagged privileged', () => {
    for (const name of privilegedNames) {
      expect(TOOLS_BY_NAME.get(name)?.privileged, name).toBe(true);
    }
  });

  it('reject when called without the capability', async () => {
    const ports = stubPorts();
    for (const name of privilegedNames) {
      const tool = TOOLS_BY_NAME.get(name);
      expect(tool, name).toBeDefined();
      // The guard runs before the handler returns its promise, so the call may
      // throw synchronously. Promise.resolve().then normalizes both a sync
      // throw and an async rejection into a rejected promise.
      await expect(
        Promise.resolve().then(() => tool!.handler({} as never, ports, AGENT_CONTEXT)),
        name,
      ).rejects.toBeInstanceOf(CapabilityError);
    }
  });

  it('kill_all bypasses the scheduler and calls the admin port directly', async () => {
    const killAll = vi.fn(async () => undefined);
    const canAct = vi.fn();
    const ports = stubPorts({
      admin: {
        pauseAccount: vi.fn(async () => undefined),
        resumeAccount: vi.fn(),
        killAll,
        getHealth: vi.fn(),
        rotateSession: vi.fn(),
        auditLog: vi.fn(),
      } as unknown as Ports['admin'],
      safety: { getAccount: vi.fn(), getCampaign: vi.fn(), canAct } as unknown as Ports['safety'],
    });
    const tool = TOOLS_BY_NAME.get('kill_all')!;
    await tool.handler({ reason: 'panic' } as never, ports, operatorContext('operator'));
    expect(killAll).toHaveBeenCalledWith('panic');
    // Never routed through the scheduler/safety path.
    expect(canAct).not.toHaveBeenCalled();
  });

  it('pause_account bypasses the scheduler and calls the admin port directly', async () => {
    const pauseAccount = vi.fn(async () => undefined);
    const canAct = vi.fn();
    const ports = stubPorts({
      admin: {
        pauseAccount,
        resumeAccount: vi.fn(),
        killAll: vi.fn(),
        getHealth: vi.fn(),
        rotateSession: vi.fn(),
        auditLog: vi.fn(),
      } as unknown as Ports['admin'],
      safety: { getAccount: vi.fn(), getCampaign: vi.fn(), canAct } as unknown as Ports['safety'],
    });
    const tool = TOOLS_BY_NAME.get('pause_account')!;
    await tool.handler({ accountId: 'acct-1', reason: 'stop' } as never, ports, operatorContext('operator'));
    expect(pauseAccount).toHaveBeenCalledWith('acct-1', 'stop');
    expect(canAct).not.toHaveBeenCalled();
  });
});

// --- Act tools go through the gate, never the executor directly ------------

describe('Act tool handlers route through the gate', () => {
  it('send_message under supervised queues and never executes', async () => {
    const execute = vi.fn();
    const enqueue = vi.fn(async (req: ActRequest, level: Campaign['autonomyLevel']): Promise<PendingItem> => ({
      id: 'pending-x',
      req,
      autonomyLevel: level,
      createdAt: new Date(),
    }));
    const ports = stubPorts({
      executor: { execute } as unknown as Ports['executor'],
      approval: {
        enqueue,
        listPending: vi.fn(),
        approve: vi.fn(),
        editAndApprove: vi.fn(),
        reject: vi.fn(),
        record: vi.fn(),
      } as unknown as Ports['approval'],
      safety: {
        getAccount: vi.fn(async () => makeAccount()),
        getCampaign: vi.fn(async () => makeCampaign('supervised')),
        canAct: vi.fn(async () => ({ kind: 'allow' }) as Decision),
      } as unknown as Ports['safety'],
    });
    const tool = TOOLS_BY_NAME.get('send_message')!;
    const out = (await tool.handler(
      { accountId: 'acct-1', targetId: 'tgt-1', campaignId: 'camp-1', body: 'hi' } as never,
      ports,
      AGENT_CONTEXT,
    )) as { kind: string };
    expect(out.kind).toBe('queued');
    expect(execute).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('send_connection under autonomous executes via the gate', async () => {
    const execute = vi.fn(async (): Promise<Action> => makeAction('connect'));
    const ports = stubPorts({
      executor: { execute } as unknown as Ports['executor'],
      safety: {
        getAccount: vi.fn(async () => makeAccount()),
        getCampaign: vi.fn(async () => makeCampaign('autonomous')),
        canAct: vi.fn(async () => ({ kind: 'allow' }) as Decision),
      } as unknown as Ports['safety'],
    });
    const tool = TOOLS_BY_NAME.get('send_connection')!;
    const out = (await tool.handler(
      { accountId: 'acct-1', targetId: 'tgt-1', campaignId: 'camp-1' } as never,
      ports,
      AGENT_CONTEXT,
    )) as { kind: string };
    expect(out.kind).toBe('executed');
    expect(execute).toHaveBeenCalledOnce();
  });
});
