// Per-request context. Carries the caller capability used to gate privileged
// tools (approval + safety/admin families).
//
// For now "privileged" is a single boolean derived from the request. In a real
// deployment this comes from an authenticated operator session vs. the agent's
// own token. The tool layer only ever reads the boolean, so the auth source can
// change without touching tool code.

export interface RequestContext {
  /** True for an operator/human session; false for the autonomous agent. */
  privileged: boolean;
  /** Operator identity used for approval audit records. Empty for the agent. */
  operator: string;
}

/** The agent's own context: never privileged. */
export const AGENT_CONTEXT: RequestContext = {
  privileged: false,
  operator: '',
};

/** Build an operator (human) context. */
export function operatorContext(operator: string): RequestContext {
  return { privileged: true, operator };
}
