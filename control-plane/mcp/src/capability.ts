// Capability guard for privileged tools (approval + safety/admin families).
//
// Privileged tools reject unless the request context carries the privileged
// capability. This is a hard gate applied before the handler body runs, so a
// non-privileged caller (the agent) can never reach the handler at all.

import type { RequestContext } from './context.js';

export class CapabilityError extends Error {
  constructor(toolName: string) {
    super(`tool "${toolName}" requires a privileged (operator) context`);
    this.name = 'CapabilityError';
  }
}

/** Throw CapabilityError if the context is not privileged. */
export function requirePrivileged(ctx: RequestContext, toolName: string): void {
  if (!ctx.privileged) {
    throw new CapabilityError(toolName);
  }
}
