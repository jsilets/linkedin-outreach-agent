# P0 runbook: first supervised run, one account

This is the sequenced guide to your first real run: one LinkedIn account, one app
container plus Postgres, and a driving Claude Code or Codex session that you
approve by hand. The browser and DOM paths depend on LinkedIn's live markup,
which drifts, so treat this as a careful first bring-up, not a turnkey install.

Do each step in order. Do not skip the proxy leak test or the selector check.

## 0. What you need before you start

- A disposable LinkedIn account you are willing to lose. Do not use your main
  account for the first run.
- One sticky residential or ISP-static proxy IP for that account. Not a rotating
  pool, not a datacenter IP. See `infra/PROXY.md`.
- A cookie vault key: `openssl rand -base64 32`. This encrypts the account's
  session cookies at rest (`COOKIE_VAULT_KEY`).
- A host that runs Docker (your own machine or any server) with Docker Compose,
  or Node plus a local Postgres if you run the runtime directly.

No LLM key is required if you drive with your own agent (Claude Code or Codex).
`ANTHROPIC_API_KEY` is only for autonomous mode; leave it unset for a driven run.

## 1. Provision inputs

Collect, do not commit, these secrets. They arrive at runtime only:

- `COOKIE_VAULT_KEY`: `openssl rand -base64 32`.
- `PROXY_URL`, `PROXY_USERNAME`, `PROXY_PASSWORD`: from your proxy provider, for
  the one sticky exit IP bound to this account.
- `DATABASE_URL`: points at your Postgres. Docker Compose sets it for you to
  reach the compose Postgres (step 2).

Resolve the proxy exit city once and keep it, so the browser geo can match it
later (see `infra/PROXY.md`, "Geo coherence").

## 2. Bring up one app container plus Postgres locally

Use the root `docker-compose.yml` (see `infra/README.md`). In short:

1. `cp .env.example .env`, then fill in `COOKIE_VAULT_KEY`. Leave the ports at the
   image defaults (web on `PORT=8080`, MCP internal on `MCP_PORT=8090`). Leave
   `ANTHROPIC_API_KEY` unset for a driven run. Add the `PROXY_*` vars for the one
   account. Compose sets `DATABASE_URL` for you to reach the compose Postgres.
2. `docker compose run --rm migrate` to apply the schema once (or `npm run
   db:migrate` if you run against your own Postgres). This creates the tables.
3. `docker compose up app` to start the app. The named volume `browser_profile`
   at `/data/profile` keeps the browser profile across restarts.
4. `curl localhost:8080/healthz` returns `{"ok":true,...}`.

Prefer no container? `npm run db:migrate` then `npm run dev` runs the runtime
directly against a local Postgres.

At this point you have a live MCP endpoint at `http://localhost:8090/mcp` and a
green health check. The tables `accounts`, `campaigns`, and `actions` exist.

## 3. Assisted first login to seed the cookie vault

The account needs a real logged-in session stored in the encrypted vault before
any outreach. Log in as the account in a browser behind the account's sticky
proxy IP (expect to clear a verification email or SMS on first login), then
seal the session cookies into the vault either way:

- Web UI: Accounts tab, paste the `li_at` and `JSESSIONID` cookie values.
- CLI: `npm run link-account` from the repo root.

Both write `${LOA_VAULT_DIR}/{accountId}.vault.json` encrypted with
`COOKIE_VAULT_KEY`. Confirm the vault file exists before moving on.

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

1. Connect your driving agent (Claude Code or Codex) to the MCP endpoint. Add an
   HTTP MCP server carrying `Authorization: Bearer LOA_MCP_TOKEN` for the driver,
   and a second one carrying `Authorization: Bearer LOA_OPERATOR_TOKEN` (plus an
   optional `x-loa-operator: YOUR_NAME` audit label) for approvals. See
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
   Note on real executor mode: `get_profile`, `get_conversation`,
   `search_people`, and `list_recent_connections` read live;
   `get_recent_posts`, `get_post_engagers`, and `get_company_jobs` have no live
   backend yet and return an error, so do not personalize from them.
4. Approve by hand from the operator connection: `list_pending`, then read each
   draft and `approve`, `edit_and_approve`, or `reject`. Only approved items
   dispatch. Watch the first sends land on LinkedIn.
5. Watch the account. Check `get_health` and `audit_log` (operator role) and
   `get_metrics` (driver role). If anything looks wrong, `pause_account`
   immediately; `kill_all` if it is worse.

Only after this one-account supervised loop is clean should you consider raising
autonomy, adding targets in bulk, or standing up a second account.

## Reply detector: verify before relying on it

The Inbox only shows replies that the local reply detector has successfully
observed and persisted. A zero reply count is not proof that LinkedIn has no
replies.

1. Keep the account paused while verifying. Pause blocks outbound work but still
   permits the detector's read-only inbox checks.
2. On runtime startup, confirm the log includes `reply detector initial scan
   complete`. It must scan once before its periodic interval begins.
3. In the Inbox, read the status immediately under the conversation count:
   - `Reply detection checked …` means the most recent scan completed.
   - `could not check LinkedIn` means no safety conclusion can be drawn. The
     status includes the failing phase: enrollment query, thread list, thread
     history, inbox list, or routing.
   - `stale`, `not running`, or `has not completed a scan` means investigate
     before resuming an account.
4. A healthy scan also reports how many recent conversation rows did not map to
   active enrollments. This is a coverage signal, not an error: personal or
   completed conversations are expected to be unmatched.
5. For a live change to LinkedIn's messaging endpoint or parser, run the
   read-only `npm run inbox-shakeout -- <accountId>` while the runtime is
   stopped so it can exclusively open the account profile. It verifies the
   conversation-list response only. The per-thread history endpoint still
   requires an explicit read-only live check before we can claim that full
   history detection is verified. Do not resume or send as part of either check.

### Current live verification status (2026-07-14)

The current mailbox-list query was verified against the paused account. Its
20-row response uses `conversationParticipants` and wraps each profile identity
inside `urn:li:msg_messagingParticipant:…`; the parser has a regression test for
that shape. The existing guessed per-thread `/events` URL returned HTTP 400 in a
read-only scan. We then captured the real `messengerMessages` GraphQL request
from an existing conversation page and added its parser test. The final
read-only detector scan must complete successfully before treating reply
detection as ready to protect a resumed account.

The append-only event log records `reply_detector_started`, `reply_scan_succeeded`,
and `reply_scan_failed`. A scan failure is visible in the Inbox and stderr; it
is never treated as an empty inbox. At send time, a reply-probe failure holds
the send rather than sending through uncertainty.

## What to watch

- The DOM selectors are best-effort and will drift with LinkedIn's markup. Step 5
  is where you catch that on your own account.
- Every account, proxy IP, and cookie vault is fresh on a new deployment. Prove
  the loop on one supervised account before you raise autonomy or add a second.
- The brain/body split across services is future work. Today the whole runtime is
  one process in one container, one account. See the scaling note in
  `infra/README.md`.
