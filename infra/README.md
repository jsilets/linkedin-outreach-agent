# @loa/infra — deployment runbook

Deployment artifacts and helper scripts for the LinkedIn outreach framework.
This package holds Docker images, Fly Machines templates, the proxy leak-guard
contract, and the database migrations. It contains no application logic.

## Shape of the deployment

Two kinds of service:

- The BRAIN (control plane): one always-on Fly app running the MCP server and
  orchestrator against Postgres. No browser. App: `loa-control-plane`.
- The BODIES (account runners): one Fly app PER LinkedIn account. Each is a
  single Machine with a volume-backed browser profile and one sticky proxy IP,
  running a headful Chromium under Xvfb. App: `loa-acct-<id>`.

Postgres is a managed database (Fly Managed Postgres or external). Its
connection string is a secret, not part of any image.

## Files

- `Dockerfile.control-plane` — brain image (MCP + orchestrator, no browser).
- `Dockerfile.account-runner` — one account body (headful Chromium under Xvfb).
- `entrypoint-account-runner.sh` — starts Xvfb, exports DISPLAY, execs runner.
- `fly.control-plane.toml` — brain Fly template.
- `fly.account-runner.toml` — per-account Fly template (copy per account).
- `PROXY.md` — sticky-IP binding + WebRTC/DNS/IPv6 leak-guard contract.
- `migrations/` — drizzle-kit output + its README (generate/migrate flow).

## Env vars

All sensitive values come from Fly secrets at runtime. Never bake them into an
image or a toml file. Cross-reference `.env.example` at the repo root.

Brain (`loa-control-plane`):

- `DATABASE_URL` — Postgres connection string.
- `ANTHROPIC_API_KEY` — LLM provider key.
- `COOKIE_VAULT_KEY` — symmetric key for the cookie vault (openssl rand -base64 32).
- `MCP_PORT` — port the MCP server listens on (default 8787).

Each account body (`loa-acct-<id>`):

- `DATABASE_URL` — same database as the brain.
- `ANTHROPIC_API_KEY` — LLM provider key.
- `COOKIE_VAULT_KEY` — same vault key as the brain (so it can open sealed cookies).
- `PROXY_URL`, `PROXY_USERNAME`, `PROXY_PASSWORD` — the account's sticky proxy.
- `LOA_ACCOUNT_ID` — which account row this body drives.
- `LOA_PROFILE_DIR` — browser profile path on the volume (defaults to
  `/data/profile`, set in the image and toml).

## Bring-up order

Bring the layers up bottom to top:

1. Postgres. Provision the managed database, capture its connection string.
2. Brain. Set the brain's secrets, deploy `loa-control-plane`. Its Fly release
   command runs `db:migrate`, so the schema is applied here, once.
3. Account bodies. For each account, provision its app, volume, proxy, and
   secrets, then deploy. Bodies need the schema already applied by step 2.

## One-account-first (P0 path)

Prove the whole loop with a single account before scaling:

1. Stand up Postgres and deploy the brain (`loa-control-plane`).
2. Confirm migrations applied (the release command succeeded; the `accounts`,
   `campaigns`, `actions` tables exist).
3. Provision ONE account body per the steps below and deploy it.
4. Boot it, let it validate the proxy (see `PROXY.md`: reported IP == exit IP,
   no WebRTC/DNS/IPv6 leak), then run a small supervised outreach window.
5. Only after that loop is clean, provision a second account.

## Provisioning an account body

Naming is a convention, not a secret: app `loa-acct-<id>`, volume
`profile_<id>`. For account `7f3a`:

    # 1. Copy the template and set the app name inside it.
    cp infra/fly.account-runner.toml infra/fly.acct-7f3a.toml
    #    edit: app = "loa-acct-7f3a", mounts.source = "profile_7f3a",
    #          primary_region = <region nearest the proxy exit city>

    # 2. Create the app and its profile volume.
    fly apps create loa-acct-7f3a
    fly volumes create profile_7f3a --size 3 --region <region> -a loa-acct-7f3a

    # 3. Set secrets (proxy is unique per account; never reuse an exit IP).
    fly secrets set -a loa-acct-7f3a \
        DATABASE_URL=... ANTHROPIC_API_KEY=... COOKIE_VAULT_KEY=... \
        PROXY_URL=... PROXY_USERNAME=... PROXY_PASSWORD=... LOA_ACCOUNT_ID=7f3a

    # 4. Deploy.
    fly deploy -a loa-acct-7f3a -c infra/fly.acct-7f3a.toml \
        --dockerfile infra/Dockerfile.account-runner

To add a SECOND account, repeat every step with a new id: new app name, new
volume, a NEW sticky proxy. Accounts never share a Machine, a profile, or an IP.

### Lifecycle

An account only needs to be awake during its daily outreach window. Drive the
Machine from the orchestrator/scheduler: `fly machine start` before the window,
`fly machine suspend` when it closes (RAM state is preserved and resumes fast,
and you stop paying for idle CPU). Keep exactly one Machine per account app.

## Cost note

Rough monthly cost per account:

- Fly performance-1x (1 vCPU, 2GB): ~$32/account/month if left running. Less if
  you suspend the Machine outside the account's outreach window.
- Sticky residential/ISP-static IP: ~$2-6/account/month depending on provider.

The brain is one small always-on `shared-cpu-1x` (512MB) app plus the Postgres
database, shared across all accounts. Cost scales with the number of account
bodies, which is why the profile, proxy, and Machine are all per-account.

## Assumptions to confirm

- Base image `node:24-bookworm-slim` and `playwright install --with-deps
  chromium` for the browser + OS deps. Swap to a patchright-provided base if the
  runner requires patchright's patched Chromium specifically.
- Xvfb display `:99` at `1920x1080x24`. Override via `DISPLAY_NUM` /
  `SCREEN_GEOMETRY` env if a different geometry is wanted.
- Fly size performance-1x / 2GB for a body; shared-cpu-1x / 512MB for the brain.
  Watch the first real run's memory and adjust if Chromium needs more headroom.
- The runner reads `LOA_PROFILE_DIR`, `LOA_ACCOUNT_ID`, and the `PROXY_*` vars as
  named here; align these with the account-runner's actual env contract.
