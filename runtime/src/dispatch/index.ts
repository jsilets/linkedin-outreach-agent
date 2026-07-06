// Dispatch module: the campaign-sequence tick and its factory.
//
// makeDispatchTick wires the tick onto the runtime's existing gate ports
// (safety + approval + executor) and the sequence store. compose() calls this
// and starts the loop; nothing here assumes a host, so it deploys unchanged.

import type { GateDeps } from '@loa/mcp';
import type { SequenceStorePort } from '../store/index.js';
import { DispatchTick, type DispatchTickDeps, type StepOutcome, type TickResult } from './tick.js';

export { DispatchTick };
export type { DispatchTickDeps, StepOutcome, TickResult };

export interface MakeDispatchTickDeps {
  sequence: SequenceStorePort;
  /** The SAME gate ports the MCP Act tools route through. */
  gate: GateDeps;
  now?: () => Date;
  onOutcome?: (o: StepOutcome) => void;
}

/** Build a DispatchTick over the runtime gate + sequence store. */
export function makeDispatchTick(deps: MakeDispatchTickDeps): DispatchTick {
  return new DispatchTick({
    sequence: deps.sequence,
    gate: deps.gate,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onOutcome ? { onOutcome: deps.onOutcome } : {}),
  });
}
