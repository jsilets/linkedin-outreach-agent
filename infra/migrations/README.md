# Migrations

The Drizzle schema is the source of truth. It lives in `@loa/shared` at
`shared/src/db/schema.ts`. This directory holds the SQL that drizzle-kit emits
from that schema, plus its `meta/` snapshot and journal. Both are committed.

`drizzle.config.ts` at the repo root points `schema` at the shared file and
`out` at this directory (`./infra/migrations`).

## Flow

Two root scripts drive it:

1. `npm run db:generate` (drizzle-kit generate)
   Diffs the current schema against the last snapshot in `meta/` and writes a
   new numbered SQL file here (e.g. `0000_careless_rafael_vega.sql`), updating
   `meta/_journal.json` and the snapshot. Run this after any change to
   `shared/src/db/schema.ts`. Review the emitted SQL, then commit it.

2. `npm run db:migrate` (drizzle-kit migrate)
   Reads `DATABASE_URL` from the environment and applies any pending files in
   this directory to that database, recording what it applied. Idempotent:
   already-applied files are skipped.

## Where migrations run

The app image ships this directory and `drizzle.config.ts`. Run migrations with
`npm run db:migrate` before the app takes traffic; docker-compose runs the same
`drizzle-kit migrate` as the one-shot `migrate` service, so the schema is current
before the app starts. `DATABASE_URL` comes from an environment secret, never
from a committed file.

Locally, apply against your dev database with:

    DATABASE_URL=postgres://user:password@localhost:5432/loa npm run db:migrate

## Do not hand-edit generated SQL

Change the schema in `@loa/shared`, regenerate, and commit the result. Editing a
generated file by hand desyncs it from the `meta/` snapshot and the next
`db:generate` will produce a wrong diff.
