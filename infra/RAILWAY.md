# Deploy on Railway

Railway is the first-class deploy target for this project: flat-rate pricing, no
idle suspend, a one-click Postgres plugin, and per-service volumes. This runbook
stands up the single app container plus Postgres and runs the P0 one-account
loop.

What you are deploying is one container that runs two processes: `@loa/runtime`
(the control-plane brain, the in-process executor, and the MCP HTTP server) and
the web UI/API. The image ships Xvfb plus a patchright Chromium, so the same
container can drive a real headful browser once you enable it — there is no
separate "body" service yet (see the scaling note at the end). Both the MCP
endpoint and the web UI require auth; set the tokens in step 4 before you expose
anything to a real account.

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
                       --set "LOA_LLM_MODEL=claude-fable-5"

Auth is required in production and the endpoints fail closed without it. Generate
each token with `openssl rand -base64 32`:

    railway variables --set "NODE_ENV=production" \
                       --set "LOA_MCP_TOKEN=..." \
                       --set "LOA_OPERATOR_TOKEN=..." \
                       --set "LOA_WEB_USER=you" \
                       --set "LOA_WEB_PASSWORD=..."

`LOA_MCP_TOKEN` is the driver's bearer; `LOA_OPERATOR_TOKEN` unlocks the
privileged Safety/Approval tools; `LOA_WEB_USER`/`LOA_WEB_PASSWORD` gate the web
UI over HTTP Basic. See `docs/DRIVING.md` for how the MCP client sends them.

Proxy vars, once you run a real account (per-account, sticky IP; see
`PROXY.md`):

    railway variables --set "PROXY_URL=..." \
                       --set "PROXY_USERNAME=..." \
                       --set "PROXY_PASSWORD=..."

Env var reference and defaults live in the repo-root `.env.example` and the
matrix in `infra/README.md`.

Note on the ports: the container runs two servers. The web UI/API is the public
face on `PORT` (the image sets 8080); Railway routes the domain there and the
`/healthz` healthcheck hits it. The runtime's MCP server binds `MCP_PORT`
internally (the image sets 8090) and is reached through the web server's `/mcp`
proxy on the public port. Leave both at the image defaults; in particular do not
set `MCP_PORT=8080`, which collides with the web server.

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

## Enable real sending

By default `LOA_EXECUTOR` is `fake`: the runtime is up, the MCP surface and web
UI work, but nothing touches LinkedIn. The real executor has run the connect,
accept, and message loop against live LinkedIn on a single supervised account
(see the 0.1.0 entry in `CHANGELOG.md`), but LinkedIn's markup drifts, so still
supervise the first run on a new account. To turn it on for one account:

    railway variables --set "LOA_EXECUTOR=real" \
                       --set "LOA_DISPATCH_INTERVAL_MS=30000" \
                       --set "LOA_REPLY_POLL_INTERVAL_MS=120000" \
                       --set "LOA_ACCEPTANCE_POLL_INTERVAL_MS=300000"

Preconditions before those flags do anything:

- A linked account: use the web UI (Accounts -> paste `li_at` + `JSESSIONID`),
  which seals the session to `${LOA_VAULT_DIR}/{accountId}.vault.json`.
- `COOKIE_VAULT_KEY` set to the key that sealed the vault, and `LOA_PROFILE_DIR`
  (default `/data/profile`) + the vault dir on a persistent volume (step 5).
- A per-account sticky proxy (`PROXY_URL` etc.). Without one the browser refuses
  to launch unless `LOA_ALLOW_NO_PROXY=true`, which is for neutral-page checks
  only, never a real account.

`LOA_DISPATCH_INTERVAL_MS` starts the campaign dispatch tick (paced sends);
`LOA_REPLY_POLL_INTERVAL_MS` starts the reply-detection tick (reads the inbox,
classifies, pulls repliers out of the funnel); `LOA_ACCEPTANCE_POLL_INTERVAL_MS`
starts the acceptance tick (reads the connections list and releases cursors
parked after a connect step). All three stay idle when unset. Do not skip the
acceptance tick: without it targets park at `awaiting_connection` forever and
follow-up message steps never fire.

## Prove one account first

1. Deploy with Postgres attached and migrations applied; confirm `/healthz` is
   green and the `accounts` / `campaigns` / `actions` tables exist.
2. Link one account in the UI and run a small supervised window (autonomy
   `supervised`, so every send queues for your approval).
3. Watch the logs for selector drift and the reply/inbox parse; LinkedIn's
   markup and Voyager payloads drift over time.
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
