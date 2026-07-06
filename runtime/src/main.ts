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
