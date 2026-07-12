# Campaign management UI

A dashboard plus a campaign flow editor for the outreach stack. Reads go to
Postgres directly through the shared Drizzle schema (`@loa/shared`); account
linking uses the cookie-vault helpers from `@loa/account-runner`; approval
writes and the `/mcp` route proxy to the runtime's MCP server. It does not
import the runtime or control-plane code.

## What it shows

- Campaigns list: goal, owner, target count, and a stage histogram per campaign.
- Campaign detail with a flow editor: the ordered steps as vertical cards. Add a
  step, pick its type, edit inline (connect note, message body, reaction, delay),
  reorder up/down, delete, then Save. A readable funnel sits above the editor
  (for example: Connect -> Wait 2d -> Message -> Wait 3d -> React).
- Volume: successful invites and messages (and other action types) per day, as a
  grouped bar chart, filterable by account and window, plus a per-account state
  table.
- Approvals, lead lists, and accounts: approve/edit/reject pending drafts in the
  UI, manage lead lists, link an account by pasting session cookies, and edit
  per-account caps and working hours.

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
  so it runs the same locally and on any host.
- `API_PORT`, `CLIENT_PORT` - override the dev ports if 4000 or 5173 are taken.

## API

Campaigns:

- `GET /api/campaigns` - campaigns with target count and stage histogram.
- `GET /api/campaigns/:id` - one campaign, its ordered steps, and counts (targets
  total, by stage, by progress state).
- `GET /api/campaigns/:id/leads` - the per-lead table for one campaign.
- `PUT /api/campaigns/:id/steps` - replace and reorder the step list. Body is
  `{ "steps": [...] }` (order is array position). Validates step type against the
  shared `CAMPAIGN_STEP_TYPES` and that delay steps have `delaySeconds > 0`.
- `POST /api/campaigns/:id/launch` - enroll the campaign's targets in its sequence.
- `DELETE /api/campaigns/:id` - delete a campaign.

Accounts:

- `GET /api/accounts` - accounts with state and limits.
- `POST /api/accounts/link` - link an account from pasted session cookies
  (`li_at` + `JSESSIONID`); seals them into the encrypted vault.
- `PATCH /api/accounts/:id/limits` - edit per-action daily caps and the
  working-hours/days schedule.

Lead lists:

- `GET /api/lists`, `POST /api/lists`, `GET /api/lists/:id`,
  `DELETE /api/lists/:id` - manage lead lists. Turning a list into a campaign
  happens through the MCP `enroll_from_list` tool, which gates on ICP fit score.

Approvals and activity (writes proxy to the runtime's MCP server):

- `GET /api/pending` - pending message approvals, optionally per campaign.
- `POST /api/pending/approve` - bulk approve by `messageIds`.
- `POST /api/pending/:messageId/approve` - approve one draft; a non-empty `body`
  edits it first.
- `POST /api/pending/:messageId/reject` - reject with a `reason`.
- `GET /api/activity` - reverse-chron feed of real actions.

Metrics:

- `GET /api/metrics/volume?accountId=&days=` - successful actions per day per
  type over the trailing window.

The server also exposes `GET /healthz`, `GET`/`POST /login`, and forwards
`/mcp` to the runtime's internal MCP server.

## Tests

```
npm test
```

Covers the step normalize/reorder/validation logic and the volume query builder
(asserted at the SQL level, so no live DB is needed).
