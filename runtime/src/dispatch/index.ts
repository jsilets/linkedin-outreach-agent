// Dispatch module: the campaign-sequence tick and its factory.
//
// makeDispatchTick wires the tick onto the runtime's existing gate ports
// (safety + approval + executor) and the sequence store. compose() calls this
// and starts the loop; nothing here assumes a host, so it deploys unchanged.

import type { Json } from '@loa/shared';
import type { GateDeps } from '@loa/mcp';
import type { MessageRepoPort, TargetRepoPort } from '@loa/orchestrator';
import type { SequenceStorePort } from '../store/index.js';
import {
  DispatchTick,
  type DispatchTickDeps,
  type SendTimeReplyCheck,
  type StepOutcome,
  type TickResult,
} from './tick.js';

export { DispatchTick };
export type { DispatchTickDeps, SendTimeReplyCheck, StepOutcome, TickResult };

export interface MakeDispatchTickDeps {
  sequence: SequenceStorePort;
  /** The SAME gate ports the MCP Act tools route through. */
  gate: GateDeps;
  /** Target-stage reads/writes: park at 'invited' on connect, gate messages, and
   * (listByUrn) enforce the cross-campaign contact lock. */
  targets: Pick<TargetRepoPort, 'findById' | 'setStage' | 'listByUrn'>;
  /** Messages, so the tick sends human-approved drafts when the window opens. */
  messages: MessageRepoPort;
  /** Cross-campaign suppression check (person said Stop). */
  suppression?: { isSuppressed(targetId: string): Promise<boolean> };
  /** Send-time reply probe (live inbox); omitted in fake mode. */
  replyProbe?: SendTimeReplyCheck;
  /** Fire-and-forget audit sink for cancellations and probe blocks. */
  log?: {
    recordEvent(kind: string, accountId: string | null, payload: Json): Promise<unknown>;
  };
  now?: () => Date;
  onOutcome?: (o: StepOutcome) => void;
}

/** Build a DispatchTick over the runtime gate + sequence store. */
export function makeDispatchTick(deps: MakeDispatchTickDeps): DispatchTick {
  return new DispatchTick({
    sequence: deps.sequence,
    gate: deps.gate,
    targets: deps.targets,
    messages: deps.messages,
    ...(deps.suppression ? { suppression: deps.suppression } : {}),
    ...(deps.replyProbe ? { replyProbe: deps.replyProbe } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onOutcome ? { onOutcome: deps.onOutcome } : {}),
  });
}
