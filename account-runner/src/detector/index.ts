// detector — reads restriction signals off the page and emits Signal objects
// (from @loa/shared). It observes and reports; it does NOT decide back-off.
// That is the SafetyGate's job in the control plane.

import type { Signal } from '@loa/shared';
import type { PagePort } from '../ports.js';
import { SELECTORS } from '../selectors.js';

/** Below this acceptance rate we raise a low_acceptance signal. */
export const LOW_ACCEPTANCE_THRESHOLD = 0.35;

/**
 * Scan the current page for restriction markers and emit any signals found.
 * Returns zero or more signals. Never throws on a missing element.
 */
export async function scanPage(page: PagePort, now: Date = new Date()): Promise<Signal[]> {
  const signals: Signal[] = [];

  // Weekly invite-cap popup -> velocity signal.
  if ((await countSafe(page, SELECTORS.weeklyLimitAlert)) > 0) {
    signals.push({
      kind: 'velocity',
      observedAt: now,
      detail: { source: 'weekly_limit_alert', url: page.url() },
    });
  }

  // "Viewing too many profiles" throttle -> velocity signal.
  if ((await countSafe(page, SELECTORS.viewLimitWarning)) > 0) {
    signals.push({
      kind: 'velocity',
      observedAt: now,
      detail: { source: 'profile_view_limit', url: page.url() },
    });
  }

  // Security checkpoint / challenge -> challenge signal.
  if ((await countSafe(page, SELECTORS.challengeContainer)) > 0) {
    signals.push({
      kind: 'challenge',
      observedAt: now,
      detail: { source: 'checkpoint', url: page.url() },
    });
  }

  // Account restriction / ban banner -> ban_banner signal.
  if ((await countSafe(page, SELECTORS.banBanner)) > 0) {
    signals.push({
      kind: 'ban_banner',
      observedAt: now,
      detail: { source: 'restriction_banner', url: page.url() },
    });
  }

  return signals;
}

/** Counts for computing an acceptance-rate signal. */
export interface AcceptanceInput {
  invitesSent: number;
  invitesAccepted: number;
}

/**
 * Compute a low_acceptance signal from connect/accept counts. Returns null when
 * there is not enough volume to judge or when acceptance is healthy.
 * Acceptance rate below LOW_ACCEPTANCE_THRESHOLD raises the signal.
 */
export function acceptanceSignal(
  input: AcceptanceInput,
  now: Date = new Date(),
  minVolume = 10,
): Signal | null {
  if (input.invitesSent < minVolume) return null;
  const rate = input.invitesAccepted / input.invitesSent;
  if (rate >= LOW_ACCEPTANCE_THRESHOLD) return null;
  return {
    kind: 'low_acceptance',
    observedAt: now,
    magnitude: rate,
    detail: {
      invitesSent: input.invitesSent,
      invitesAccepted: input.invitesAccepted,
      threshold: LOW_ACCEPTANCE_THRESHOLD,
    },
  };
}

/**
 * Geo-drift signal: raised when the observed egress region no longer matches
 * the account's bound proxy region. The runner reports; the gate reacts.
 */
export function geoDriftSignal(
  expectedRegion: string,
  observedRegion: string,
  now: Date = new Date(),
): Signal | null {
  if (expectedRegion === observedRegion) return null;
  return {
    kind: 'geo_drift',
    observedAt: now,
    detail: { expectedRegion, observedRegion },
  };
}

/** Count matches for a selector, treating any driver error as zero. */
async function countSafe(page: PagePort, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}
