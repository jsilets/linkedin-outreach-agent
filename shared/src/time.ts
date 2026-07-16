// Time boundaries shared by everything that counts actions against a cap.

/**
 * The local midnight that starts the calendar day `at` falls in.
 *
 * HOST-local, deliberately, and the single definition of it. Three consumers
 * count against this boundary and MUST agree to the millisecond:
 *
 *   - the gate      (StoreBackedDailyUsage in runtime/src/adapters/safety-state.ts)
 *   - the web UI    (loadGateInputs in web/server/src/queries.ts)
 *   - the ops report(scripts/ops-report.ts)
 *
 * A cap the gate and the UI disagree about is worse than either boundary being
 * wrong: the UI offers capacity the gate refuses, or the report calls an account
 * throttled when it has a full day's headroom. They had drifted apart twice
 * before this helper existed, which is why the definition is here and not
 * copied per consumer.
 *
 * Host-local rather than a fixed zone: if the host moves, all three move
 * together, which is the property that matters. It is also the same basis the
 * working-hours window already uses.
 */
export function startOfLocalDay(at: Date): Date {
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}
