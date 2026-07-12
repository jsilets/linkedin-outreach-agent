// One shared Drizzle client for the web server. Reads the same DATABASE_URL the
// rest of the stack uses, and binds against the schema exported by @loa/shared
// so we never redefine tables here.

import { db as schema } from '@loa/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Point it at the postgres from docker-compose.');
}

const client = postgres(url);

export const db = drizzle(client, { schema });
export { schema };
export type Db = typeof db;
