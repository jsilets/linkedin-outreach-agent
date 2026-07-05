# @loa/infra — deployment

Deployment artifacts for the LinkedIn outreach framework: one portable Docker
image, a local docker-compose stack, a Railway config, and the database
migrations. No application logic lives here.

## The deployable unit

The system runs as ONE process. `@loa/runtime` composes the control-plane brain
and an in-process account executor, starts the MCP HTTP server on `MCP_PORT`,
and serves `GET /healthz` -> `{"ok":true,...}`. So the whole deployment today is:

- one app container (this runtime), plus
- one Postgres database.

That is it. A future phase splits the brain and the per-account bodies across
separate machines, but the network transport for that split is not wired in the
code yet. Do not deploy a separate always-running "body" service; there is
nothing for it to talk to. See `examples/fly/NOTE.md` for the archived sketch of
that future split.

Real browser runs, live LinkedIn traffic, and the real LLM are P0 items: the
image is built to be correct for them (Xvfb plus a headful Chromium are present,
the entrypoint starts the virtual display), but nothing exercises the browser
end to end yet. With no `ANTHROPIC_API_KEY` the runtime uses a fake LLM; with no
`DATABASE_URL` it uses an in-memory store.

## Files

- `Dockerfile` — the single app image (builder runs `npm run build`; runtime
  stage installs Xvfb + a headful Chromium and runs `node runtime/dist/main.js`).
- `entrypoint.sh` — starts Xvfb, exports `DISPLAY`, execs the runtime.
- `railway.json` — Railway config-as-code (Dockerfile build, `/healthz` check,
  pre-deploy migrate, restart policy).
- `RAILWAY.md` — the Railway deploy runbook.
- `migrations/` — drizzle-kit SQL output + its README (generate/migrate flow).
- `PROXY.md` — sticky-IP binding + WebRTC/DNS/IPv6 leak-guard contract.
- `examples/fly/` — an unmaintained Fly example (see its `NOTE.md`).

The root `docker-compose.yml` and `.dockerignore` complete the set.

## Try it end to end (local)

Requires Docker with Compose.

    cp .env.example .env
    # fill in ANTHROPIC_API_KEY and COOKIE_VAULT_KEY (openssl rand -base64 32);
    # DATABASE_URL is set for you by compose to point at the compose Postgres.

    docker compose run --rm migrate    # apply the schema once
    docker compose up app              # start the app

Then hit health on `MCP_PORT` (default 8080):

    curl localhost:8080/healthz        # -> {"ok":true,...}

Compose brings up Postgres (named volume `postgres_data`), a named volume for
the browser profile (`browser_profile` at `/data/profile`), and the app. The
`migrate` service is one-shot: it runs `drizzle-kit migrate` against the compose
database and exits.

## Deploy to Railway

Railway is the documented hosting target: flat-rate, no idle suspend, one-click
Postgres, per-service volumes. Full runbook in `RAILWAY.md`. In short:

1. `railway init` + `railway link`.
2. Add the Postgres plugin (provides `DATABASE_URL`).
3. Add the app service from this repo; Railway builds `infra/Dockerfile` per
   `railway.json`.
4. Set secrets (`ANTHROPIC_API_KEY`, `COOKIE_VAULT_KEY`, `MCP_PORT`,
   `LOA_LLM_MODEL`, and later `PROXY_*`).
5. Attach a volume at `/data/profile`.
6. Migrations run automatically before each release (`preDeployCommand`).
7. `railway up`, then check `/healthz`.

## Environment variables

All secrets arrive at runtime; never bake them into an image or a config file.
Cross-reference the repo-root `.env.example`.

| Var                | Required        | Purpose |
|--------------------|-----------------|---------|
| `DATABASE_URL`     | for Postgres    | Postgres connection string. Unset -> in-memory store (dev only). |
| `ANTHROPIC_API_KEY`| for real LLM    | LLM provider key. Unset -> fake LLM. |
| `LOA_LLM_MODEL`    | no              | LLM model id (default `claude-fable-5`). |
| `COOKIE_VAULT_KEY` | for real runs   | Symmetric key for the cookie vault. `openssl rand -base64 32`. |
| `MCP_PORT`         | no              | Port the MCP server binds (default 8080). |
| `PROXY_URL`        | for real runs   | Sticky egress proxy URL. See `PROXY.md`. |
| `PROXY_USERNAME`   | for real runs   | Proxy auth. |
| `PROXY_PASSWORD`   | for real runs   | Proxy auth. |
| `LOA_PROFILE_DIR`  | no              | Browser profile path (image sets `/data/profile`). |

## Migrations

The Drizzle schema in `@loa/shared` is the source of truth; `infra/migrations/`
holds the generated SQL (committed). Two root scripts:

- `npm run db:generate` — diff the schema and emit a new SQL file. Run after any
  change to `shared/src/db/schema.ts`, review, commit.
- `npm run db:migrate` — apply pending files to `DATABASE_URL`. Idempotent.

In containers the migrate step runs `drizzle-kit` directly
(`node node_modules/drizzle-kit/bin.cjs migrate`): compose runs it as the
one-shot `migrate` service, Railway runs it as `preDeployCommand`. Details in
`migrations/README.md`.

## Cost note (Railway)

Railway bills flat-rate for what runs, with no idle suspend: a small always-on
service plus a Postgres plugin is roughly a low-tens-of-dollars-per-month
baseline, and it does not sleep between outreach windows. Budget ~2GB of memory
per service once real browser runs land (one headful Chromium). A sticky
residential or ISP-static proxy IP adds ~$2-6/account/month from the proxy
provider (see `PROXY.md`); that cost is per account and is not Railway's.

## Caveats

- Browser, LinkedIn, and real-LLM paths are P0 and not exercised end to end yet.
  The image is structurally ready (Xvfb + headful Chromium), but prove the loop
  with one account before scaling.
- The brain/body split is future work; the callback transport does not exist in
  the code. Today it is one process in one container.
