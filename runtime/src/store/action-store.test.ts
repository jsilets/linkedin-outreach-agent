import { describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';

const ACCT = 'acct-1';
const TGT = 'tgt-1';
const CAMP = 'camp-1';

function baseAction(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCT,
    targetId: TGT,
    campaignId: CAMP,
    type: 'message' as const,
    scheduledAt: new Date(),
    result: 'pending' as const,
    // In-memory store keys rows by id, not dedupKey, so a constant is fine here.
    dedupKey: 'd',
    ...overrides,
  };
}

describe('ActionStore.countFailedSince', () => {
  it('counts only failed rows of the given type for the target since the cutoff', async () => {
    const store = new InMemoryStore();
    const since = new Date(Date.now() - 60_000);
    // 3 failed messages + 1 success + 1 failed connect + 1 failed message before the cutoff.
    await store.action.create(baseAction({ result: 'failed', executedAt: new Date() }));
    await store.action.create(baseAction({ result: 'failed', executedAt: new Date() }));
    await store.action.create(baseAction({ result: 'failed', executedAt: new Date() }));
    await store.action.create(baseAction({ result: 'success', executedAt: new Date() }));
    await store.action.create(
      baseAction({ type: 'connect', result: 'failed', executedAt: new Date() }),
    );

    expect(await store.action.countFailedSince(TGT, 'message', since)).toBe(3);
    expect(await store.action.countFailedSince(TGT, 'connect', since)).toBe(1);
    // A cutoff in the future excludes the just-created rows.
    expect(await store.action.countFailedSince(TGT, 'message', new Date(Date.now() + 60_000))).toBe(
      0,
    );
    // A different target sees none.
    expect(await store.action.countFailedSince('other', 'message', since)).toBe(0);
  });
});

describe('ActionStore.reclaimStalePending', () => {
  it('deletes only pending rows with no executed_at older than the cutoff', async () => {
    const store = new InMemoryStore();
    const stale = await store.action.create(baseAction({ result: 'pending', executedAt: null }));
    // Backdate it so it is older than the cutoff.
    const row = store.action.rows.get(stale.id)!;
    store.action.rows.set(stale.id, { ...row, createdAt: new Date(Date.now() - 5 * 60_000) });
    // A fresh pending row (in-flight, not stale) and a completed row must survive.
    const fresh = await store.action.create(baseAction({ result: 'pending', executedAt: null }));
    const done = await store.action.create(
      baseAction({ result: 'success', executedAt: new Date() }),
    );

    const reclaimed = await store.action.reclaimStalePending(new Date(Date.now() - 60_000));

    expect(reclaimed).toBe(1);
    expect(await store.action.findById(stale.id)).toBeUndefined();
    expect(await store.action.findById(fresh.id)).toBeDefined();
    expect(await store.action.findById(done.id)).toBeDefined();
  });
});
