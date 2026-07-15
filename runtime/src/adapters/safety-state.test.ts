// PauseRegistry: the operator pause flag the gate consults on every canAct.
// The registry itself is in-memory; these tests pin the property that matters —
// a pause persisted as events survives a "restart" (a fresh registry rehydrated
// over the same store), so pause_account / kill_all keep holding after reboot.

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import {
  PAUSE_EVENT_KIND,
  PauseRegistry,
  RESUME_EVENT_KIND,
  StoreBackedDailyUsage,
} from './safety-state.js';

const ACCT = 'acct-pause';

describe('PauseRegistry', () => {
  it('pause and resume flip the live flag', () => {
    const reg = new PauseRegistry();
    expect(reg.isPaused(ACCT)).toBe(false);
    reg.pause(ACCT);
    expect(reg.isPaused(ACCT)).toBe(true);
    reg.resume(ACCT);
    expect(reg.isPaused(ACCT)).toBe(false);
  });

  it('a persisted pause survives a restart via rehydrate', async () => {
    const store = new InMemoryStore();
    await store.event.append({ accountId: ACCT, kind: PAUSE_EVENT_KIND, payload: { reason: 'x' } });

    // "Restart": a brand-new registry over the same store.
    const fresh = new PauseRegistry();
    await fresh.rehydrate(store, [ACCT]);
    expect(fresh.isPaused(ACCT)).toBe(true);
  });

  it('a resume after the pause wins on rehydrate', async () => {
    const store = new InMemoryStore();
    await store.event.append({ accountId: ACCT, kind: PAUSE_EVENT_KIND, payload: { reason: 'x' } });
    // Ensure a strictly later timestamp even on a coarse clock.
    await new Promise((r) => setTimeout(r, 5));
    await store.event.append({ accountId: ACCT, kind: RESUME_EVENT_KIND, payload: {} });

    const fresh = new PauseRegistry();
    await fresh.rehydrate(store, [ACCT]);
    expect(fresh.isPaused(ACCT)).toBe(false);
  });

  it('an account with no pause history rehydrates unpaused', async () => {
    const store = new InMemoryStore();
    const fresh = new PauseRegistry();
    await fresh.rehydrate(store, [ACCT]);
    expect(fresh.isPaused(ACCT)).toBe(false);
  });
});

// StoreBackedDailyUsage: the counter the gate reads to enforce "N a day".
//
// The property under test is the one an operator can see: a day is the local
// CALENDAR day the Activity graph draws, not a rolling 24h window. The two
// disagree for exactly the rows these tests pin — something sent late yesterday
// is inside a rolling 24h but is not today, and counting it means the UI offers
// capacity the gate refuses.
//
// Times are written without a Z so they parse as host-local, which is the basis
// the counter (and the web read model, and the working-hours window) all use.

const USAGE_ACCT = 'acct-usage';
/** Local noon. Yesterday 13:00 is 23h earlier — inside a rolling day, not today. */
const NOON = new Date('2026-07-15T12:00:00');
const at = (iso: string) => new Date(iso);

describe('StoreBackedDailyUsage: the day is a local calendar day', () => {
  it('does not count a send from late yesterday, though it is inside a rolling 24h', () => {
    const usage = new StoreBackedDailyUsage({ now: () => NOON });
    usage.record(USAGE_ACCT, 'connect', at('2026-07-14T13:00:00')); // 23h ago
    expect(usage.usedToday(USAGE_ACCT).connect).toBe(0);
  });

  it('counts a send from earlier today', () => {
    const usage = new StoreBackedDailyUsage({ now: () => NOON });
    usage.record(USAGE_ACCT, 'connect', at('2026-07-15T07:30:00'));
    usage.record(USAGE_ACCT, 'connect', at('2026-07-15T11:30:00'));
    expect(usage.usedToday(USAGE_ACCT).connect).toBe(2);
  });

  it('counts a send stamped exactly at local midnight as today', () => {
    // Inclusive, matching the read model's gte(executedAt, midnight).
    const usage = new StoreBackedDailyUsage({ now: () => NOON });
    usage.record(USAGE_ACCT, 'connect', at('2026-07-15T00:00:00'));
    expect(usage.usedToday(USAGE_ACCT).connect).toBe(1);
  });

  it('resets at local midnight rather than dribbling slots back', () => {
    // The whole point of the change: a full day's sends, then the clock crosses
    // into tomorrow and the entire cap is available again at once.
    let now = NOON;
    const usage = new StoreBackedDailyUsage({ now: () => now });
    for (let i = 0; i < 20; i++) usage.record(USAGE_ACCT, 'connect', at('2026-07-15T12:00:00'));
    expect(usage.usedToday(USAGE_ACCT).connect).toBe(20);

    now = at('2026-07-16T07:00:00'); // next morning, < 24h after those sends
    expect(usage.usedToday(USAGE_ACCT).connect).toBe(0);
  });

  it('keeps types independent', () => {
    const usage = new StoreBackedDailyUsage({ now: () => NOON });
    usage.record(USAGE_ACCT, 'connect', at('2026-07-15T09:00:00'));
    const used = usage.usedToday(USAGE_ACCT);
    expect(used.connect).toBe(1);
    expect(used.message).toBe(0);
  });

  it('rehydrates today only, and only successes', async () => {
    const store = new InMemoryStore();
    const seed = async (executedAt: Date, result: 'success' | 'failed') =>
      store.action.create({
        accountId: USAGE_ACCT,
        targetId: 'tgt-1',
        campaignId: 'camp-1',
        type: 'connect',
        scheduledAt: executedAt,
        executedAt,
        result,
        dedupKey: `${result}-${executedAt.toISOString()}`,
      });
    await seed(at('2026-07-14T13:00:00'), 'success'); // yesterday: not today
    await seed(at('2026-07-15T08:00:00'), 'success'); // today
    await seed(at('2026-07-15T09:00:00'), 'failed'); // a failure burns no cap

    const usage = new StoreBackedDailyUsage({ now: () => NOON });
    await usage.rehydrate(store, [USAGE_ACCT]);
    expect(usage.usedToday(USAGE_ACCT).connect).toBe(1);
  });
});
