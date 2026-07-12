// Entrypoint. Reads env, composes the wired system, and starts the MCP HTTP
// server on MCP_PORT. Run with: npm run dev (from repo root) which uses
// node --env-file-if-exists=.env --import tsx.

import { startServer } from '@loa/mcp';
import { compose } from './compose.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = compose(config);
  await runtime.rehydrateSafety();

  const store = config.databaseUrl ? 'postgres' : 'in-memory';
  console.log(
    `[@loa/runtime] composed: store=${store} llm=${runtime.llmProvider} executor=${runtime.executorMode}`,
  );

  // The dispatch tick drives real outreach, so it only runs when a host opts in
  // with LOA_DISPATCH_INTERVAL_MS. Unset, the MCP surface is up but the sequence
  // engine stays idle (agent-over-MCP still works; nothing self-paces).
  if (config.dispatchIntervalMs) {
    runtime.dispatch.start(config.dispatchIntervalMs);
    console.log(`[@loa/runtime] dispatch tick started: every ${config.dispatchIntervalMs}ms`);
  } else {
    console.log('[@loa/runtime] dispatch tick idle (set LOA_DISPATCH_INTERVAL_MS to run it)');
  }

  // The reply tick watches inboxes and pulls repliers out of the funnel. Same
  // opt-in rule as dispatch, and it only exists with a real session (fake mode
  // has no inbox to read), so it starts only when both are present.
  if (config.replyPollIntervalMs && runtime.replyTick) {
    runtime.replyTick.start(config.replyPollIntervalMs);
    console.log(`[@loa/runtime] reply tick started: every ${config.replyPollIntervalMs}ms`);
  } else if (config.replyPollIntervalMs) {
    console.log('[@loa/runtime] reply tick idle (needs LOA_EXECUTOR=real for a live inbox)');
  } else {
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
