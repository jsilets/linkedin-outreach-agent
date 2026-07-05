// Seed helpers: build a valid account row with sensible defaults so dev and
// smoke can create an account without hand-rolling the jsonb blobs. Not used in
// production, where accounts are created through the bootstrap/admin flow.

import { db as shared } from '@loa/shared';
import type { AccountState, ActionType } from '@loa/shared';
import type { RuntimeStore } from './store/index.js';

function emptyUsed(): Record<ActionType, number> {
  return {
    connect: 0,
    message: 0,
    view_profile: 0,
    follow: 0,
    withdraw_invite: 0,
    react: 0,
  };
}

export interface SeedAccountInput {
  handle: string;
  state?: AccountState;
  warmupDay?: number;
  region?: string;
}

/** Create an account row with healthy defaults. Active or Warming as requested. */
export async function seedAccount(
  store: RuntimeStore,
  input: SeedAccountInput,
): Promise<shared.AccountRow> {
  const today = new Date().toISOString().slice(0, 10);
  return store.account.create({
    handle: input.handle,
    state: input.state ?? 'Active',
    warmupDay: input.warmupDay ?? 28,
    proxyBinding: {
      proxyId: `proxy-${input.handle}`,
      region: input.region ?? 'us-east',
      sticky: true,
    },
    health: {
      acceptanceRate: 0.6,
      replyRate: 0.3,
      challengesLast7d: 0,
      lastCheckedAt: new Date(),
    },
    budget: {
      date: today,
      caps: emptyUsed(),
      used: emptyUsed(),
    },
  });
}
