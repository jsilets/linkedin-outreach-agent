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

import type {
  DailyUsageCounter,
  OutstandingInviteCounter,
  PauseState,
  RecentActionClock,
  WeeklyInviteCounter,
} from '@loa/safety';
import {
  type Account,
  type ActionType,
  type Signal,
  type SignalKind,
  startOfLocalDay,
} from '@loa/shared';
import type { RuntimeStore } from '../store/index.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function emptyDailyUsed(): Record<ActionType, number> {
  return { connect: 0, message: 0, view_profile: 0, follow: 0, withdraw_invite: 0, react: 0 };
}

/** Event kind under which the runtime records a raised safety signal. */
const SIGNAL_EVENT_KIND = 'safety_signal';

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

  /**
   * Rebuild the window for every account from persisted connect action rows.
   *
   * SUCCESSES ONLY, matching what record() counts on the live path ("the weekly
   * ceiling counts connects that actually went out") and what the daily counter
   * rehydrates. Without the filter a restart silently re-counted failed invites
   * — attempts LinkedIn never saw — and burned real ceiling with them, so an
   * account's headroom shrank every time it rebooted after a bad connect.
   */
  async rehydrate(store: RuntimeStore, accountIds: string[]): Promise<void> {
    for (const accountId of accountIds) {
      const rows = await store.action.listByAccount(accountId);
      const stamps = rows
        .filter((r) => r.type === 'connect' && r.result === 'success')
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
 * Synchronous per-type daily-usage counter, backed by a live in-memory window of
 * successfully-executed action timestamps per account, per type. The gate reads
 * usedToday synchronously inside budget()/canAct to enforce the daily caps.
 *
 * The window is the operator's LOCAL CALENDAR DAY: "20 a day" means what the
 * Activity graph says it means, and capacity resets at local midnight rather than
 * dribbling back one slot at a time on yesterday's schedule.
 *
 * This replaced a rolling 24h window, whose stated reason was that a cap keyed to
 * UTC midnight would reset partway through the operator's day. That reason is
 * answered by keying to LOCAL midnight instead (startOfLocalDay), which is also
 * exactly what the web read model already counted — so the gate and the UI now
 * agree, where before the UI would offer capacity the gate refused.
 *
 * The rolling window's other argument survives and is accepted deliberately: a
 * calendar cap allows up to ~2x the daily number across a rollover (a full
 * evening batch, then a full batch after midnight). The working-hours window is
 * what makes that tolerable — sends cannot happen at 00:01, so the two batches
 * are hours apart, not a burst — and the weekly invite ceiling still bounds the
 * total well below 7x the daily cap.
 *
 * rehydrate() fills it from persisted action rows so the cap survives a restart —
 * which is the whole point: the gate must NOT fall back to the persisted
 * acct.budget.used, which is never written with today's live count, so relying on
 * it silently disables the daily cap.
 */
export class StoreBackedDailyUsage implements DailyUsageCounter {
  private readonly stamps = new Map<string, Partial<Record<ActionType, number[]>>>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Rebuild today's counts from persisted, successfully-executed rows. */
  async rehydrate(store: RuntimeStore, accountIds: string[]): Promise<void> {
    const dayStart = startOfLocalDay(this.now()).getTime();
    for (const accountId of accountIds) {
      const rows = await store.action.listByAccount(accountId);
      const byType: Partial<Record<ActionType, number[]>> = {};
      for (const r of rows) {
        if (r.result !== 'success') continue;
        const t = (r.executedAt ?? r.scheduledAt).getTime();
        // Inclusive, matching the read model's gte(executedAt, midnight): an
        // action stamped exactly at midnight belongs to the day it starts.
        if (t < dayStart) continue;
        let stamps = byType[r.type];
        if (!stamps) {
          stamps = [];
          byType[r.type] = stamps;
        }
        stamps.push(t);
      }
      this.stamps.set(accountId, byType);
    }
  }

  /** Note that an action of `type` ran now (or at `at`) for this account. */
  record(accountId: string, type: ActionType, at: Date = this.now()): void {
    const byType = this.stamps.get(accountId) ?? {};
    let stamps = byType[type];
    if (!stamps) {
      stamps = [];
      byType[type] = stamps;
    }
    stamps.push(at.getTime());
    this.stamps.set(accountId, byType);
  }

  usedToday(accountId: string): Record<ActionType, number> {
    const dayStart = startOfLocalDay(this.now()).getTime();
    const out = emptyDailyUsed();
    const byType = this.stamps.get(accountId);
    if (!byType) return out;
    for (const k of Object.keys(byType) as ActionType[]) {
      // Drop yesterday's stamps opportunistically: this is also what resets the
      // cap at local midnight without a scheduled job.
      const fresh = (byType[k] ?? []).filter((t) => t >= dayStart);
      byType[k] = fresh;
      out[k] = fresh.length;
    }
    return out;
  }
}

/**
 * Synchronous counter of invitations sent but not yet accepted, per account.
 *
 * The pile is read from the enrollment cursors parked at 'awaiting_connection',
 * which is our own record of "invited, still waiting". That undercounts invites
 * a human sent outside a campaign; it is a backstop, and the operator's own
 * manual invites are not what a runaway automation looks like.
 *
 * rehydrate() is the accurate read at boot; record() adds a fresh invite and
 * release() removes one the acceptance tick has seen accepted. Both ends are
 * wired precisely so this number tracks the same rows the web read model counts
 * live — a gate that denies at 500 while the Settings card reads 460 is the same
 * UI-versus-gate disagreement this change set exists to remove, just inverted.
 *
 * Residual drift is upward-only and self-correcting: a cursor that leaves
 * 'awaiting_connection' by some path other than acceptance (a removed target)
 * is not released here, so the count can sit high until the next boot. Upward is
 * the safe direction for a ceiling, and boot re-derives from the rows.
 */
export class StoreBackedOutstandingInvites implements OutstandingInviteCounter {
  private readonly pending = new Map<string, number>();

  /** Count each account's parked invites from persisted enrollment cursors. */
  async rehydrate(store: RuntimeStore, accountIds: string[]): Promise<void> {
    const rows = await store.sequence.awaitingConnectionEnrollments();
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.accountId, (counts.get(r.accountId) ?? 0) + 1);
    for (const id of accountIds) this.pending.set(id, counts.get(id) ?? 0);
  }

  /** Note that an invite went out and is now pending. */
  record(accountId: string): void {
    this.pending.set(accountId, (this.pending.get(accountId) ?? 0) + 1);
  }

  /** Note that a pending invite was accepted and has left the pile. Floors at 0:
   * an acceptance for an invite sent before this process booted is already
   * absent from the rehydrated count, and must not push it negative. */
  release(accountId: string): void {
    this.pending.set(accountId, Math.max(0, (this.pending.get(accountId) ?? 0) - 1));
  }

  outstandingInvites(accountId: string): number {
    return this.pending.get(accountId) ?? 0;
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

/** Event kinds under which operator pause/resume decisions are persisted. */
export const PAUSE_EVENT_KIND = 'account_paused';
export const RESUME_EVENT_KIND = 'account_resumed';

/**
 * Synchronous operator-pause registry, read by the gate on every canAct. Pause
 * and resume are persisted as account_paused / account_resumed events (the
 * admin adapter appends them); rehydrate() replays the latest of the two per
 * account so a pause survives a restart. kill_all records one account_paused
 * event per account, so it replays through the same path.
 */
export class PauseRegistry implements PauseState {
  private readonly paused = new Set<string>();

  /** Rebuild pause state: an account is paused when its most recent
   * account_paused event is newer than its most recent account_resumed one. */
  async rehydrate(store: RuntimeStore, accountIds: string[]): Promise<void> {
    for (const accountId of accountIds) {
      const events = await store.event.listByAccount(accountId);
      const lastPaused = maxTs(events.filter((e) => e.kind === PAUSE_EVENT_KIND));
      const lastResumed = maxTs(events.filter((e) => e.kind === RESUME_EVENT_KIND));
      if (lastPaused !== undefined && (lastResumed === undefined || lastPaused > lastResumed)) {
        this.paused.add(accountId);
      } else {
        this.paused.delete(accountId);
      }
    }
  }

  pause(accountId: string): void {
    this.paused.add(accountId);
  }

  resume(accountId: string): void {
    this.paused.delete(accountId);
  }

  isPaused(accountId: string): boolean {
    return this.paused.has(accountId);
  }
}

function maxTs(events: Array<{ ts: Date }>): number | undefined {
  let max: number | undefined;
  for (const e of events) {
    const t = e.ts.getTime();
    if (max === undefined || t > max) max = t;
  }
  return max;
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
  if (!isSignalKind(p.kind)) return null;
  const observedAt = typeof p.observedAt === 'string' ? new Date(p.observedAt) : new Date();
  const sig: Signal = { kind: p.kind, observedAt };
  if (typeof p.magnitude === 'number') sig.magnitude = p.magnitude;
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
