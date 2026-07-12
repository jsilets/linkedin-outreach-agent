// The autonomy chokepoint.
//
// Every mutating (Act) tool routes through gateAct(). Nothing else may call the
// executor. The autonomy dial is enforced here, server-side; the model is never
// trusted to self-limit. The result of gateAct() is one of:
//   - executed:  the action was dispatched to the executor now
//   - queued:    an approval was enqueued; a pending id is returned
//   - deferred:  the SafetyGate said "not now"; nothing ran
//   - denied:    the SafetyGate said no; nothing ran
//
// The autonomy matrix (per campaign.autonomyLevel):
//
//   level        connect            message            react/follow/etc.
//   ----------   ----------------   ----------------   ------------------
//   supervised   queue approval     queue approval     queue approval
//   semi_auto    execute (gated)    queue approval     execute (gated)
//   autonomous   execute (gated)    execute (gated)    execute (gated)
//
// "message" also covers replies (a reply is a message send). In supervised and
// semi_auto every message/reply queues; only autonomous sends them directly.
// Even when a level permits execution, SafetyGate.canAct still runs and can
// defer or deny within budget.

import type { AutonomyLevel, Decision } from '@loa/shared';
import { SafetyDeferredError } from '@loa/shared';
import type { ActRequest, ApprovalPort, ExecutorPort, PendingItem, SafetyPort } from './ports.js';

/** Outcome of routing an Act through the gate. */
export type GateOutcome =
  | { kind: 'executed'; actionId: string }
  | { kind: 'queued'; pendingId: string }
  | { kind: 'deferred'; until: Date }
  | { kind: 'denied'; reason: string };

/**
 * Action types whose sends are treated as "message-class": they only execute
 * directly under full autonomy. Everything else is "connect-class" and may
 * execute from semi_auto up. 'connect' is explicitly connect-class.
 */
const MESSAGE_CLASS: ReadonlySet<string> = new Set(['message']);

/**
 * Decide, purely from the autonomy level and action type, whether the action is
 * even eligible to execute directly (before SafetyGate is consulted). Returns
 * false when the level requires human approval for this action class.
 *
 * This function is total and side-effect free so it can be unit-tested on its
 * own and audited at a glance.
 */
export function mayExecuteDirectly(level: AutonomyLevel, actionType: string): boolean {
  switch (level) {
    case 'supervised':
      // Nothing executes directly; every send queues.
      return false;
    case 'semi_auto':
      // Connection requests (and other non-message acts) execute within budget;
      // messages and replies still queue.
      return !MESSAGE_CLASS.has(actionType);
    case 'autonomous':
      // Full loop executes; the human holds only the kill switch.
      return true;
    default: {
      // Exhaustiveness guard: a new AutonomyLevel must be handled explicitly.
      const _never: never = level;
      return _never;
    }
  }
}

export interface GateDeps {
  safety: SafetyPort;
  approval: ApprovalPort;
  executor: ExecutorPort;
}

/**
 * The single chokepoint. All Act tools call this and nothing else touches the
 * executor. Flow:
 *   1. Load account + campaign (for autonomy level and budget context).
 *   2. If the level forbids direct execution for this action class -> enqueue
 *      an approval and return its pending id. The executor is not touched.
 *   3. Otherwise ask SafetyGate.canAct:
 *        allow -> dispatch to the executor.
 *        defer -> return deferred; nothing runs.
 *        deny  -> return denied; nothing runs.
 *
 * Note: an approval that is later approved dispatches through the ApprovalPort,
 * which itself is expected to re-check safety before executing. The gate does
 * not execute on the approval path.
 */
export async function gateAct(
  deps: GateDeps,
  req: ActRequest,
  draftBody?: string,
): Promise<GateOutcome> {
  const account = await deps.safety.getAccount(req.accountId);
  const campaign = await deps.safety.getCampaign(req.campaignId);
  const level = campaign.autonomyLevel;

  if (!mayExecuteDirectly(level, req.type)) {
    const pending: PendingItem = await deps.approval.enqueue(req, level, draftBody);
    return { kind: 'queued', pendingId: pending.id };
  }

  const decision: Decision = await deps.safety.canAct(account, req);
  switch (decision.kind) {
    case 'allow': {
      try {
        const action = await deps.executor.execute(req);
        return { kind: 'executed', actionId: action.id };
      } catch (err) {
        // The executor re-checks safety at token-mint time (defense in depth).
        // If that re-check flipped to a non-allow (e.g. the anti-burst pacer
        // deferred us since the check above), that is a transient "retry later",
        // NOT an executor failure. Map it back to the same non-allow outcome the
        // gate would have returned at step 1 so the caller retries instead of
        // treating it as fatal. Any other error is a genuine failure: rethrow.
        if (err instanceof SafetyDeferredError) {
          const d = err.decision;
          return d.kind === 'defer'
            ? { kind: 'deferred', until: d.until }
            : { kind: 'denied', reason: d.reason };
        }
        throw err;
      }
    }
    case 'defer':
      return { kind: 'deferred', until: decision.until };
    case 'deny':
      return { kind: 'denied', reason: decision.reason };
    default: {
      const _never: never = decision;
      return _never;
    }
  }
}
