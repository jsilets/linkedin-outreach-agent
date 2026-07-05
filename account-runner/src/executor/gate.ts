// The executor's local allow-token pre-flight. Nothing in the executor touches
// the page without a valid allow token that matches the exact action and
// account and has not expired. The REAL policy decision lives in the control
// plane; this is the runner's hard refusal-by-default guard.

import type { Action } from '@loa/shared';
import type { AllowToken, TokenRejection } from '../ports.js';

/** Thrown when the executor is asked to act without a valid allow token. */
export class NotAllowedError extends Error {
  constructor(
    public readonly rejection: TokenRejection,
    message: string,
  ) {
    super(message);
    this.name = 'NotAllowedError';
  }
}

/**
 * Verify an allow token authorizes this action right now. Returns null when the
 * token is valid, or a TokenRejection describing why it is refused.
 */
export function checkToken(
  token: AllowToken | null | undefined,
  action: Action,
  accountId: string,
  now: number = Date.now(),
): TokenRejection | null {
  if (!token) return 'missing';
  if (token.kind !== 'allow') return 'not_allow';
  if (token.actionId !== action.id) return 'wrong_action';
  if (token.accountId !== accountId) return 'wrong_account';
  if (token.expiresAt <= now) return 'expired';
  return null;
}

/** Assert a valid token or throw NotAllowedError. Every action calls this. */
export function assertAllowed(
  token: AllowToken | null | undefined,
  action: Action,
  accountId: string,
  now: number = Date.now(),
): void {
  const rejection = checkToken(token, action, accountId, now);
  if (rejection) {
    throw new NotAllowedError(
      rejection,
      `refusing to act: allow token ${rejection} for action ${action.id}`,
    );
  }
}
