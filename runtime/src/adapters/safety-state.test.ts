// PauseRegistry: the operator pause flag the gate consults on every canAct.
// The registry itself is in-memory; these tests pin the property that matters —
// a pause persisted as events survives a "restart" (a fresh registry rehydrated
// over the same store), so pause_account / kill_all keep holding after reboot.

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store.js';
import { PAUSE_EVENT_KIND, PauseRegistry, RESUME_EVENT_KIND } from './safety-state.js';

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
