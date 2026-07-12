// Store selection. Dev and smoke use the in-memory store; a live deployment
// uses PostgresStore when DATABASE_URL is set. Both expose the orchestrator
// repo ports plus the account/action reads the runtime adapters need.
//
// The port types live in ./types.js so the concrete stores can import them
// without depending on this barrel (which re-exports the stores).

export { InMemoryStore } from './in-memory-store.js';
export { makeInMemoryStore } from './in-memory-store.js';
export { makePostgresStore } from './postgres-store.js';

export type {
  TargetProgressPatch,
  SequenceStorePort,
  RuntimeStore,
} from './types.js';
