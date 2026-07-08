// Store-backed safety state: the rolling weekly-invite counter and the
// soft-signal streak. These resolve the two integration TODOs the safety
// package flagged (WeeklyInviteCounter and the soft-signal streak were
// in-memory-only and did not survive a restart).
//
// The locked SafetyGate reads WeeklyInviteCounter.invitesLast7d synchronously
// inside canAct, so the counter cannot itself be async. We keep a synchronous
// in-memory window that is (a) rehydrated from persisted action rows at startup
// and (b) kept warm as the runtime executor records connect actions. The window
// therefore survives a restart: on boot we replay the trailing 7 days of connect
// actions out of the store.
//
// The gate owns its soft-streak internally and privately, so we cannot inject
// it. Instead the runtime records every safety signal as an append-only event
// and, at startup, replays the recent signal events back through gate.onSignal
// so the in-memory streak and account state are reconstructed from the log.

import type { Account, Signal, SignalKind } from '@loa/shared';
import type { RecentActionClock, WeeklyInviteCounter } from '@loa/safety';
import type { RuntimeStore } from '../store/index.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Event kind under which the runtime records a raised safety signal. */
export const SIGNAL_EVENT_KIND = 'safety_signal';

/**
 * Synchronous weekly-invite counter backed by a live in-memory window of connect
 * timestamps per account. rehydrate() fills it from persisted action rows so the
 * ceiling survives a restart; record() keeps it warm as connects are executed.
 */
export class StoreBackedWeeklyInviteCounter implements WeeklyInviteCounter {
  private readonly connects = new Map<string, number[]>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Rebuild the window for every account from persisted connect action rows. */
  async rehydrate(store: RuntimeStore, accountIds: string[]): Promise<void> {
    for (const accountId of accountIds) {
      const rows = await store.action.listByAccount(accountId);
      const stamps = rows
        .filter((r) => r.type === 'connect')
        .map((r) => (r.executedAt ?? r.scheduledAt).getTime());
      this.connects.set(accountId, stamps);
    }
  }

  /** Note that a connect ran now (or at `at`) for this account. */
  record(accountId: string, at: Date = this.now()): void {
    const list = this.connects.get(accountId) ?? [];
    list.push(at.getTime());
    this.connects.set(accountId, list);
  }

  invitesLast7d(accountId: string): number {
    const cutoff = this.now().getTime() - SEVEN_DAYS_MS;
    const list = this.connects.get(accountId);
    if (!list) return 0;
    // Prune old stamps opportunistically so the window stays bounded.
    const fresh = list.filter((t) => t > cutoff);
    if (fresh.length !== list.length) this.connects.set(accountId, fresh);
    return fresh.length;
  }
}

/**
 * Synchronous action pacer backed by the single most-recent executed-action
 * timestamp per account, across ALL action types. The gate reads lastActionAt
 * to space actions apart. rehydrate() fills it from the most recent persisted
 * action row per account so the spacing survives a restart; record() keeps it
 * warm as actions execute (both executors call it).
 */
export class StoreBackedActionPacer implements RecentActionClock {
  private readonly last = new Map<string, number>();

  /** Rebuild each account's most-recent action time from persisted rows. */
  async rehydrate(store: RuntimeStore, accountIds: string[]): Promise<void> {
    for (const accountId of accountIds) {
      const rows = await store.action.listByAccount(accountId);
      let max = -Infinity;
      for (const r of rows) {
        const t = (r.executedAt ?? r.scheduledAt).getTime();
        if (t > max) max = t;
      }
      if (max > -Infinity) this.last.set(accountId, max);
    }
  }

  /** Note that an action ran at `executedAt` for this account; keep the max. */
  record(accountId: string, executedAt: Date): void {
    const t = executedAt.getTime();
    const prev = this.last.get(accountId);
    if (prev === undefined || t > prev) this.last.set(accountId, t);
  }

  lastActionAt(accountId: string): Date | undefined {
    const t = this.last.get(accountId);
    return t === undefined ? undefined : new Date(t);
  }
}

const SIGNAL_KINDS_SET: ReadonlySet<string> = new Set<SignalKind>([
  'velocity',
  'low_acceptance',
  'challenge',
  'ban_banner',
  'geo_drift',
]);

function isSignalKind(v: unknown): v is SignalKind {
  return typeof v === 'string' && SIGNAL_KINDS_SET.has(v);
}

/** Reconstruct a Signal from a persisted safety_signal event payload. */
function signalFromPayload(payload: unknown): Signal | null {
  if (payload == null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!isSignalKind(p['kind'])) return null;
  const observedAt = typeof p['observedAt'] === 'string' ? new Date(p['observedAt']) : new Date();
  const sig: Signal = { kind: p['kind'], observedAt };
  if (typeof p['magnitude'] === 'number') sig.magnitude = p['magnitude'];
  return sig;
}

/**
 * Replay persisted safety-signal events back through the gate so its private
 * soft-signal streak and any state escalation are reconstructed after a restart.
 * For each known account we load its safety_signal events oldest-first and feed
 * them through gate.onSignal; the gate mutates its own internal streak as it
 * processes each one. Returns the number of signals replayed.
 */
export async function replaySignals(
  store: RuntimeStore,
  gate: { onSignal(acct: Account, sig: Signal): unknown },
  loadAccount: (accountId: string) => Promise<Account | undefined>,
  accountIds: string[],
): Promise<number> {
  let replayed = 0;
  for (const accountId of accountIds) {
    const acct = await loadAccount(accountId);
    if (!acct) continue;
    const events = (await store.event.listByAccount(accountId))
      .filter((e) => e.kind === SIGNAL_EVENT_KIND)
      // listByAccount returns newest-first; replay oldest-first.
      .sort((a, b) => a.ts.getTime() - b.ts.getTime());
    for (const e of events) {
      const sig = signalFromPayload(e.payload);
      if (!sig) continue;
      gate.onSignal(acct, sig);
      replayed += 1;
    }
  }
  return replayed;
}
