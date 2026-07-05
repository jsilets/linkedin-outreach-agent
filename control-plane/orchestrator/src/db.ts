// The Db seam. Repositories depend on this interface, not on a live postgres
// connection, so tests can pass a fake and run with no Postgres. The real seam
// wraps the postgres-js Drizzle driver over the shared schema.

import process from 'node:process';
import { db as shared } from '@loa/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// The Drizzle database handle typed over the shared schema.
export type Schema = typeof shared.schema;
export type Database = ReturnType<typeof drizzle<Schema>>;

/**
 * Db is the seam the repositories use. It exposes the Drizzle handle. Tests
 * implement this with an in-memory fake; production uses PostgresDb.
 */
export interface Db {
  readonly handle: Database;
}

/** Real seam: postgres-js driver, connection string from DATABASE_URL. */
export class PostgresDb implements Db {
  readonly handle: Database;
  private readonly sql: ReturnType<typeof postgres>;

  constructor(opts: { url?: string } = {}) {
    const url = opts.url ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    this.sql = postgres(url);
    this.handle = drizzle(this.sql, { schema: shared.schema });
  }

  /** Close the underlying connection pool. */
  async close(): Promise<void> {
    await this.sql.end();
  }
}
