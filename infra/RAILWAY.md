# Deploy on Railway

Railway is the first-class deploy target for this project: flat-rate pricing, no
idle suspend, a one-click Postgres plugin, and per-service volumes. This runbook
stands up the single app container plus Postgres and runs the P0 one-account
loop.

What you are deploying is one service: `@loa/runtime`. It composes the
control-plane brain and an in-process executor, starts the MCP HTTP server, and
serves `GET /healthz`. There is no separate "body" service yet (see the scaling
note at the end).

The Dockerfile build and the healthcheck are declared in `infra/railway.json`
(`$schema: https://railway.com/railway.schema.json`), so Railway builds
`infra/Dockerfile`, runs migrations before each release via `preDeployCommand`,
and health-gates on `/healthz`. You still create the project, the Postgres
plugin, the volume, and the secrets by hand, as below.

## Prerequisites

- A Railway account and the CLI: `npm i -g @railway/cli` (or `brew install railway`).
- `railway login`.

## 1. Create the project and link it

    railway init                 # creates a new project, prompts for a name
    railway link                 # link this repo checkout to that project

## 2. Add Postgres

Add the Postgres plugin from the dashboard (New -> Database -> PostgreSQL), or:

    railway add --database postgres

The plugin exposes a `DATABASE_URL` on the Postgres service. Reference it from
the app service rather than copying the literal string (step 4).

## 3. Add the app service from this repo

Create a service that builds from this repo's `infra/Dockerfile`. In the
dashboard: New -> GitHub Repo -> pick this repo. Railway reads
`infra/railway.json` and builds with the Dockerfile. If you keep the config file
somewhere else, point the service's "Config-as-code" path at `infra/railway.json`.

## 4. Set secrets and env

Reference the database URL from the Postgres service, and set the rest as
service variables. Generate the cookie vault key with `openssl rand -base64 32`.

    # Reference the Postgres plugin's connection string (recommended):
    #   in the dashboard, add DATABASE_URL as a reference to
    #   ${{Postgres.DATABASE_URL}} on the app service.
    # Or set it explicitly:
    railway variables --set "DATABASE_URL=postgres://..." \
                       --set "ANTHROPIC_API_KEY=sk-ant-..." \
                       --set "COOKIE_VAULT_KEY=$(openssl rand -base64 32)" \
                       --set "MCP_PORT=8080" \
                       --set "LOA_LLM_MODEL=claude-fable-5"

Proxy vars, once you run a real account (per-account, sticky IP; see
`PROXY.md`):

    railway variables --set "PROXY_URL=..." \
                       --set "PROXY_USERNAME=..." \
                       --set "PROXY_PASSWORD=..."

Env var reference and defaults live in the repo-root `.env.example` and the
matrix in `infra/README.md`.

Note on the port: the app binds `MCP_PORT` (default 8080). Set `MCP_PORT` and let
Railway route to it; the `/healthz` healthcheck hits that same port.

## 5. Attach a volume for the browser profile

The browser profile (cookies, session) must survive restarts. Attach a volume
to the app service mounted at `/data/profile` (the image's `LOA_PROFILE_DIR`).

    railway volume add --mount-path /data/profile

Volumes are not expressible in `railway.json`; create them via CLI or dashboard.
Size a few GB; one account's profile is small but Chromium's cache grows.

## 6. Migrations

Migrations run automatically before each release: `infra/railway.json` sets
`preDeployCommand` to `node node_modules/drizzle-kit/bin.cjs migrate`, which
reads `DATABASE_URL` and applies `infra/migrations`. It is idempotent.

To apply them by hand against the Railway database (for example the very first
time, or to verify):

    railway run node node_modules/drizzle-kit/bin.cjs migrate

## 7. Deploy and verify

    railway up

Then check health:

    railway open           # opens the service; hit /healthz
    # GET /healthz -> {"ok":true,"server":"..."}

## P0 note: one account first

The brain and the in-process executor run in this one service. Real browser
runs, live LinkedIn traffic, and the real LLM are P0 items that are not yet
exercised end to end. Prove the loop with a single account and a single service
before doing anything else:

1. Deploy this one service with Postgres attached and migrations applied.
2. Confirm `/healthz` is green and the `accounts` / `campaigns` / `actions`
   tables exist.
3. Add one account's sticky proxy and run a small supervised window.
4. Only after that loop is clean, consider a second account.

## Scaling to multiple accounts (future work)

The eventual model is one isolated body per LinkedIn account: its own service,
its own volume at `/data/profile`, and its own sticky proxy IP (never share an
exit IP between accounts; see `PROXY.md`). The brain/body split across separate
services talks over a network transport that is NOT implemented in the code yet.
Until it is, treat "one service per account" as a deployment convention for
isolation, not a wired distributed system: today each service still runs the
whole runtime in one process. When the transport lands, this runbook gets a
brain service plus N body services; for now it is one service, one account.
