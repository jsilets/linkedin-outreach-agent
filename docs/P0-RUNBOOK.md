# P0 runbook: first supervised run, one account

This is the sequenced guide to a first real run: one LinkedIn account, one app
container plus Postgres, and a driving Claude Code or Codex session that you
approve by hand. It is honest about what is unproven. Browser, live LinkedIn
traffic, and the DOM selectors are P0 items that are not exercised end to end
yet, so treat this as a careful first bring-up, not a turnkey install.

Do each step in order. Do not skip the proxy leak test or the selector check.

## 0. What you need before you start

- A disposable LinkedIn account you are willing to lose. Do not use your main
  account for the first run.
- One sticky residential or ISP-static proxy IP for that account. Not a rotating
  pool, not a datacenter IP. See `infra/PROXY.md`.
- A cookie vault key: `openssl rand -base64 32`. This encrypts the account's
  session cookies at rest (`COOKIE_VAULT_KEY`).
- A Railway account and the CLI (`npm i -g @railway/cli`, then `railway login`).

No LLM key is required if you drive with your own agent (Claude Code or Codex).
`ANTHROPIC_API_KEY` is only for autonomous mode; leave it unset for a driven run.

## 1. Provision inputs

Collect, do not commit, these secrets. They arrive at runtime only:

- `COOKIE_VAULT_KEY`: `openssl rand -base64 32`.
- `PROXY_URL`, `PROXY_USERNAME`, `PROXY_PASSWORD`: from your proxy provider, for
  the one sticky exit IP bound to this account.
- `DATABASE_URL`: provided by the Railway Postgres plugin (step 2).

Resolve the proxy exit city once and keep it, so the browser geo can match it
later (see `infra/PROXY.md`, "Geo coherence").

## 2. Deploy one app container plus Postgres to Railway

Follow `infra/RAILWAY.md` in full. In short:

1. `railway init` then `railway link`.
2. `railway add --database postgres` (the plugin provides `DATABASE_URL`).
3. Add the app service from this repo; Railway builds `infra/Dockerfile` per
   `infra/railway.json`.
4. Set variables. Reference the Postgres `DATABASE_URL`, and set
   `COOKIE_VAULT_KEY`, `MCP_PORT=8080`. Leave `ANTHROPIC_API_KEY` unset for a
   driven run. Add the `PROXY_*` vars for the one account.
5. Attach a volume at `/data/profile` so the browser profile survives restarts.
6. Migrations run automatically before each release (`preDeployCommand`).
7. `railway up`, then check `GET /healthz` returns `{"ok":true,...}` on
   `MCP_PORT`.

At this point you have a live MCP endpoint at `https://YOUR-APP.../mcp` and a
green health check. The tables `accounts`, `campaigns`, and `actions` exist.

## 3. Assisted first login to seed the cookie vault

The account needs a real logged-in session stored in the encrypted vault before
any outreach. This is a hands-on, human-in-the-loop step: log in as the account
through the proxied browser context so LinkedIn sees a normal login from the
account's sticky IP, and let the runner persist the session into the vault
(`COOKIE_VAULT_KEY`) on the `/data/profile` volume. Expect to clear a
verification email or SMS on first login. This login path is P0 and not yet
automated end to end, so do it attentively and confirm the session persisted
before moving on.

## 4. Proxy leak test

Before trusting the account, run the leak checklist from `infra/PROXY.md`
("Verify before trusting an account"). Through the same proxied browser context,
open an IP echo endpoint and a WebRTC leak test and assert all three:

1. Reported public IP equals the proxy exit IP.
2. No WebRTC candidate exposes a non-proxy IP.
3. The DNS resolver geo matches the exit city, not the host region.

Also confirm the geo-coherence values (timezone, locale, Accept-Language) match
the exit city. If any check fails, do not run outreach on this account. Fix the
proxy binding first.

## 5. Verify the LinkedIn DOM selectors against a live page

The selectors in `account-runner/src/selectors.ts` are best-effort public DOM
facts and MUST be re-verified against a live LinkedIn page before you trust them.
The file flags several as verify-live. Check these in particular, on a real
logged-in page, and update the file if the markup has shifted:

- `weeklyLimitAlert` (`[class*="ip-fuse-limit-alert__warning"]`): the weekly
  invite-cap warning. Flagged verify-live.
- `viewLimitWarning` (`[class*="profile-view-limit"]`): the profile-view
  throttle warning. Flagged verify-live.
- `challengeContainer` (`#captcha-internal, .challenge-dialog,
  [data-test-id*="challenge"]`): the security checkpoint / challenge markers.
  Flagged verify-live.
- `banBanner` (`[class*="restriction"], [class*="account-restricted"]`): the
  account-restricted banner. Flagged verify-live.

Also sanity-check the action selectors you will exercise first: `connectButton`,
`addNoteButton`, `noteTextarea`, and `sendInviteButton` for the connect flow. If
a selector no longer matches, fix it in `account-runner/src/selectors.ts`, which
is the single place selectors live.

The restriction and challenge selectors feed the detector. If they are wrong,
the runner can miss a challenge or a ban and keep acting on a flagged account, so
this step is not optional.

## 6. First supervised campaign via a driving session

Now run a real cycle, supervised, approving every send by hand.

1. Connect your driving agent (Claude Code or Codex) to the MCP endpoint. Add the
   plain HTTP MCP server for the driver, and a second one carrying
   `x-loa-privileged: true` and `x-loa-operator: YOUR_NAME` for approvals. See
   `examples/driver/README.md`.
2. Create the campaign at `supervised` autonomy and add your first targets:
   - `create_campaign(goal: <goal>, autonomyLevel: "supervised",
     messageStrategy: <strategy>, owner: "YOUR_NAME")`.
   - `add_targets(campaignId: <id>, prospectRefs: [<refs>])`.
   Under `supervised`, every send and reply queues to approval.
3. Load the driver from `examples/driver/SKILL.md`, fill in the placeholders, and
   run one cycle: `get_account_state`, `get_queue`, then per target
   `get_profile` / `get_recent_posts`, optional `attach_external_context`, draft,
   and `send_connection`. Each send comes back `queued` with a `pendingId`.
4. Approve by hand from the operator connection: `list_pending`, then read each
   draft and `approve`, `edit_and_approve`, or `reject`. Only approved items
   dispatch. Watch the first sends land on LinkedIn.
5. Watch the account. Check `get_health` and `audit_log` (operator role) and
   `get_metrics` (driver role). If anything looks wrong, `pause_account`
   immediately; `kill_all` if it is worse.

Only after this one-account supervised loop is clean should you consider raising
autonomy, adding targets in bulk, or standing up a second account.

## What is unproven

- Browser runs, live LinkedIn traffic, and the assisted-login path are P0 and not
  exercised end to end. The image is structurally ready (Xvfb plus headful
  Chromium) but the flows are new.
- The DOM selectors are best-effort and will drift with LinkedIn's markup. Step 5
  is where you catch that.
- The brain/body split across services is future work. Today the whole runtime is
  one process in one container, one account. See the scaling note in
  `infra/RAILWAY.md`.
