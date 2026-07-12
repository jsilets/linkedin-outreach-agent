// safety — LOCAL pre-flight mirror only. The authoritative SafetyGate lives in
// the control plane (@loa/safety). The runner keeps a thin, conservative mirror
// so it can refuse obviously-out-of-budget actions before opening a page, but it
// NEVER treats itself as the source of truth: the executor still demands an
// allow token minted by the real gate.

import type { Account, Action, DailyBudget } from '@loa/shared';

/** Result of a local pre-flight check. Advisory only. */
export type PreflightResult = { ok: true } | { ok: false; reason: string };

/** Map an ActionType to the DailyBudget key. They are 1:1 by design. */
function budgetKey(action: Action): keyof DailyBudget['caps'] {
  return action.type;
}

/**
 * Conservative local check: is this account in a state that plainly forbids
 * acting, and does it have remaining budget for this action type? This is a
 * fail-closed mirror; a pass here does NOT authorize the action. Only the
 * control-plane gate's allow token does.
 */
export function preflight(acct: Account, action: Action): PreflightResult {
  if (acct.state === 'Restricted' || acct.state === 'Cooldown') {
    return { ok: false, reason: `account state ${acct.state} forbids acting` };
  }
  const key = budgetKey(action);
  const cap = acct.budget.caps[key] ?? 0;
  const used = acct.budget.used[key] ?? 0;
  if (used >= cap) {
    return { ok: false, reason: `daily budget exhausted for ${key} (${used}/${cap})` };
  }
  return { ok: true };
}
