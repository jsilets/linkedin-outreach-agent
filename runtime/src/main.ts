// Entrypoint. Reads env, composes the wired system, and starts the MCP HTTP
// server on MCP_PORT. Run with: npm run dev (from repo root) which uses
// node --env-file-if-exists=.env --import tsx.

import { startServer } from '@loa/mcp';
import { compose } from './compose.js';
import { loadConfig } from './config.js';
import { waitForStoreReady } from './store/wait-ready.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = compose(config);
  // Wait for the database to accept connections before the first query. A rapid
  // restart or a cold Postgres can refuse for a few seconds; without this the
  // rehydrate below throws ECONNREFUSED, the process exits, and the supervisor
  // respawns ~30s later. Retrying here makes a restart a clean short wait. Only
  // meaningful with a real database — the in-memory probe succeeds immediately.
  if (config.databaseUrl) {
    await waitForStoreReady(() => runtime.store.account.all(), {
      log: (m) => console.log(`[@loa/runtime] ${m}`),
    });
  }
  await runtime.rehydrateSafety();

  const store = config.databaseUrl ? 'postgres' : 'in-memory';
  console.log(
    `[@loa/runtime] composed: store=${store} llm=${runtime.llmProvider} executor=${runtime.executorMode}`,
  );

  // The dispatch tick drives real outreach, so it only runs when a host opts in
  // with LOA_DISPATCH_INTERVAL_MS. Unset, the MCP surface is up but the sequence
  // engine stays idle (agent-over-MCP still works; nothing self-paces).
  if (config.dispatchIntervalMs) {
    // Reclaim actions stranded 'pending' by a prior crash/restart (killed
    // mid-execute, so the executor never wrote a result). Nothing is genuinely in
    // flight at boot, so any pending row older than a minute is a leftover; delete
    // it to free the dedup key and let the owning step be re-created and retried.
    const reclaimed = await runtime.store.action.reclaimStalePending(new Date(Date.now() - 60_000));
    if (reclaimed > 0) {
      console.log(
        `[@loa/runtime] reclaimed ${reclaimed} stale pending action(s) orphaned by a prior restart`,
      );
    }
    runtime.dispatch.start(config.dispatchIntervalMs);
    console.log(`[@loa/runtime] dispatch tick started: every ${config.dispatchIntervalMs}ms`);
  } else {
    console.log('[@loa/runtime] dispatch tick idle (set LOA_DISPATCH_INTERVAL_MS to run it)');
  }

  // The reply tick watches inboxes and pulls repliers out of the funnel. Same
  // opt-in rule as dispatch, and it only exists with a real session (fake mode
  // has no inbox to read), so it starts only when both are present.
  if (config.replyPollIntervalMs && runtime.replyTick) {
    await runtime.orchestrator.eventLog.recordEvent('reply_detector_started', null, {
      intervalMs: config.replyPollIntervalMs,
    });
    // Scan before waiting for the first interval. A restart must not create a
    // 30-minute blind spot while a reply is already sitting in the inbox.
    try {
      const initial = await runtime.replyTick.runTick();
      console.log(
        `[@loa/runtime] reply detector initial scan complete: ${initial.accounts} account(s), ${initial.outcomes.length} outcome(s)`,
      );
    } catch (error) {
      // runTick has recorded reply_scan_failed. Keep the paused/read-only host
      // alive so the next interval can recover after a transient session error.
      console.error('[@loa/runtime] reply detector initial scan failed:', error);
    }
    runtime.replyTick.start(config.replyPollIntervalMs);
    console.log(`[@loa/runtime] reply tick started: every ${config.replyPollIntervalMs}ms`);
  } else if (config.replyPollIntervalMs) {
    await runtime.orchestrator.eventLog.recordEvent('reply_detector_idle', null, {
      reason: 'needs_real_executor',
    });
    console.log('[@loa/runtime] reply tick idle (needs LOA_EXECUTOR=real for a live inbox)');
  } else {
    await runtime.orchestrator.eventLog.recordEvent('reply_detector_idle', null, {
      reason: 'poll_interval_unset',
    });
    console.log('[@loa/runtime] reply tick idle (set LOA_REPLY_POLL_INTERVAL_MS to run it)');
  }

  // The acceptance tick watches the connections list and releases cursors parked
  // after a connect step once the invite is accepted. Same opt-in rule as the
  // reply tick, and it only exists with a real session (fake mode has no
  // connections list), so it starts only when both are present.
  if (config.acceptancePollIntervalMs && runtime.acceptanceTick) {
    runtime.acceptanceTick.start(config.acceptancePollIntervalMs);
    console.log(
      `[@loa/runtime] acceptance tick started: every ${config.acceptancePollIntervalMs}ms`,
    );
  } else if (config.acceptancePollIntervalMs) {
    console.log(
      '[@loa/runtime] acceptance tick idle (needs LOA_EXECUTOR=real for a live connections list)',
    );
  } else {
    console.log(
      '[@loa/runtime] acceptance tick idle (set LOA_ACCEPTANCE_POLL_INTERVAL_MS to run it)',
    );
  }

  const server = startServer(runtime.ports);

  const shutdown = (signal: string): void => {
    console.log(`[@loa/runtime] ${signal} received; shutting down`);
    server.close(() => {
      void runtime.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[@loa/runtime] fatal:', err);
  process.exit(1);
});
