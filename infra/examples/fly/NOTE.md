# Fly example (unmaintained)

These files are an optional, unmaintained example, kept for reference. They are
NOT the supported deploy path. The supported paths are `docker compose up`
locally and Railway for hosting (see `infra/README.md` and `infra/RAILWAY.md`).

They also encode a two-image brain/body split (a small always-on control plane
plus one headful-Chromium body per account). That split is future-phase work:
the network transport between a separate brain and body is NOT implemented in
the code yet. The system today runs as a single process (`@loa/runtime`) in one
container, which is what the main `infra/Dockerfile` builds. Treat these files as
a sketch of where the deployment goes when that split lands, not as something you
can deploy as-is.

Contents:

- `Dockerfile.control-plane` — brain-only image (MCP + orchestrator, no browser).
- `Dockerfile.account-runner` — one account body (headful Chromium under Xvfb).
- `entrypoint-account-runner.sh` — Xvfb bootstrap for the body image.
- `fly.control-plane.toml` — Fly template for the brain.
- `fly.account-runner.toml` — per-account Fly template.

The internal paths in these files (for example `infra/Dockerfile.account-runner`
or `infra/entrypoint-account-runner.sh`) refer to their old location at the
`infra/` root, before they were moved here. Adjust paths if you revive them.
