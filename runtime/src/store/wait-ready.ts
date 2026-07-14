// Boot-time database readiness wait.
//
// A rapid restart (launchd kickstart -k) or a cold Docker Postgres can refuse
// connections for a few seconds after the process starts. Without a wait, the
// first boot query (rehydrateSafety's `select ... from accounts`) throws
// ECONNREFUSED, main() exits(1), and launchd's KeepAlive respawns ~30s later.
// Retrying the probe here turns that crash-then-respawn into a clean short wait,
// while still giving up (and letting KeepAlive take over) if the database is
// genuinely down for the whole window.

/** True if `err` looks like a transient connection failure (DB not accepting
 * connections yet) rather than a real query/logic error. Walks the cause chain
 * because postgres.js/drizzle wrap the socket error inside a DrizzleQueryError
 * whose `cause` is an AggregateError carrying the per-address ECONNREFUSED. */
export function isConnectionError(err: unknown): boolean {
  // ECONN* = socket refused/reset/timeout; 57P03 = Postgres "cannot_connect_now"
  // (the server is up but still starting). All are retryable at boot.
  const codes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENOTFOUND',
    '57P03',
  ]);
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth += 1) {
    const e = cur as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && codes.has(e.code)) return true;
    if (
      Array.isArray(e.errors) &&
      e.errors.some(
        (x) =>
          typeof (x as { code?: unknown })?.code === 'string' &&
          codes.has((x as { code: string }).code),
      )
    ) {
      return true;
    }
    cur = e.cause;
  }
  const msg = String((err as Error)?.message ?? err);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connect ECONN|terminating connection|the database system is starting up/i.test(
    msg,
  );
}

export interface WaitForStoreReadyOptions {
  /** Max probe attempts before giving up (default 12). */
  attempts?: number;
  /** First backoff delay in ms; doubles each retry up to maxDelayMs (default 500). */
  baseDelayMs?: number;
  /** Backoff ceiling in ms (default 5000). */
  maxDelayMs?: number;
  /** Injectable sleep so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress log. */
  log?: (message: string) => void;
}

/**
 * Run `probe` until it succeeds, retrying with exponential backoff ONLY on
 * connection errors. A non-connection error rethrows immediately (it is a real
 * failure, not a not-ready-yet). If every attempt is a connection error, the
 * last one rethrows so the caller can exit and let the supervisor respawn.
 */
export async function waitForStoreReady(
  probe: () => Promise<unknown>,
  opts: WaitForStoreReadyOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? 12;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 5000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i += 1) {
    try {
      await probe();
      return;
    } catch (err) {
      if (i >= attempts || !isConnectionError(err)) throw err;
      const delay = Math.min(base * 2 ** (i - 1), maxDelay);
      opts.log?.(`database not ready (attempt ${i}/${attempts}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}
