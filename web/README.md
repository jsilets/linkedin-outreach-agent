# Campaign management UI

A local, read-heavy dashboard plus a campaign flow editor for the outreach
stack. It talks to Postgres directly through the shared Drizzle schema
(`@loa/shared`); it does not import the runtime, control-plane, or
account-runner code.

## What it shows

- Campaigns list: goal, owner, target count, and a stage histogram per campaign.
- Campaign detail with a flow editor: the ordered steps as vertical cards. Add a
  step, pick its type, edit inline (connect note, message body, reaction, delay),
  reorder up/down, delete, then Save. A readable funnel sits above the editor
  (for example: Connect -> Wait 2d -> Message -> Wait 3d -> React).
- Volume: successful invites and messages (and other action types) per day, as a
  grouped bar chart, filterable by account and window, plus a per-account state
  table.

## Requirements

- `DATABASE_URL` pointing at Postgres. The repo's `docker-compose.yml` has a
  `postgres` service.
- Migration `0001` must be applied for the `campaign_steps` and `target_progress`
  tables to exist. Without it the campaigns list still loads, but the flow editor
  and progress-state counts return empty or error. Apply migrations with
  `docker compose run --rm migrate` (or `npm run db:migrate` from the repo root
  against your `DATABASE_URL`).
- An empty database is fine. The views render empty states.

## Run it

From the repo root, install workspace deps once:

```
npm install
```

Bring up Postgres and apply migrations:

```
docker compose up -d postgres
docker compose run --rm migrate
```

Then, from `web/`:

```
# dev: API on :4000, Vite on :5173 with /api proxied to the API
DATABASE_URL=postgres://loa:loa@localhost:5432/loa npm run dev
```

Open http://localhost:5173.

For a production-style single process (API serves the built client):

```
npm run build
DATABASE_URL=... npm start   # serves API + client on PORT (default 4000)
```

### Config

- `DATABASE_URL` (required) - same connection string the rest of the stack uses.
- `PORT` (default 4000), `HOST` (default 0.0.0.0) - the API bind. Host-agnostic,
  so it runs the same locally and on Railway.
- `API_PORT`, `CLIENT_PORT` - override the dev ports if 4000 or 5173 are taken.

## API

- `GET /api/campaigns` - campaigns with target count and stage histogram.
- `GET /api/campaigns/:id` - one campaign, its ordered steps, and counts (targets
  total, by stage, by progress state).
- `PUT /api/campaigns/:id/steps` - replace and reorder the step list. Body is
  `{ "steps": [...] }` (order is array position). Validates step type against the
  shared `CAMPAIGN_STEP_TYPES` and that delay steps have `delaySeconds > 0`.
- `GET /api/metrics/volume?accountId=&days=` - successful actions per day per
  type over the trailing window.
- `GET /api/accounts` - accounts with state and warmup day.

## Tests

```
npm test
```

Covers the step normalize/reorder/validation logic and the volume query builder
(asserted at the SQL level, so no live DB is needed).
