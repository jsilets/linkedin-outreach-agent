# Scheduling driven mode

Driven mode does not need a session sitting open all day. You wake a driving
agent a few times per working day, it runs one bounded cycle of the playbook
against the deployed MCP URL, and it goes back to sleep. This document shows how
to do that with Claude Code scheduled routines and with Codex scheduled tasks.

Read `docs/DRIVING.md` first. The per-wake work is the driver playbook from that
doc.

## Cadence: respect the safety model

Daily caps are small, on the order of ~20 actions per account per day, and the
account has warm-up and cooldown states. Do not run a tight loop. A few wakes per
working day is the right shape: each wake does a little work, then stops.

A reasonable cron cadence is four wakes on weekday mornings and early afternoon,
spread out, in your account's timezone. Example (three wakes, Mon-Fri):

```
0 9,12,15 * * 1-5
```

That is 9am, noon, and 3pm on weekdays. Keep the spacing wide. If you want more
throughput, add accounts, not more frequent wakes. The gate will `defer` or
queue anything that would exceed budget regardless, so a too-frequent schedule
just produces empty cycles, not more sends.

## What one scheduled wake does

One wake runs exactly one pass of the driver playbook, bounded by the account
budget:

1. `get_account_state`: if the account is not runnable (Restricted, Cooldown,
   Throttled) or the budget is spent, exit the wake immediately.
2. `get_queue`: see what is already pending.
3. For a small number of targets within remaining budget: `get_profile` and
   `get_recent_posts`, optional web research to `attach_external_context`, draft
   with the agent's own model, then `send_connection` or `send_message`. Under
   `supervised` these enqueue.
4. Optionally, in the operator role, `list_pending` then `approve` /
   `edit_and_approve` / `reject`.
5. `get_metrics` for a one-line summary, then stop.

A wake should send at most a handful of actions and never try to drain the whole
day's budget at once.

## Claude Code (scheduled routine / cron)

Use a Claude Code scheduled routine (the `/schedule` skill, or the cloud
scheduled routines UI) to run the driver on the cron cadence above. The routine
prompt is the example driver from `examples/driver/`, with your MCP URL and
campaign id filled in.

Connect Claude Code to the remote MCP server. In `.mcp.json` (or via
`claude mcp add`):

```json
{
  "mcpServers": {
    "loa": {
      "type": "http",
      "url": "https://YOUR-APP.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_LOA_MCP_TOKEN"
      }
    }
  }
}
```

The agent token gives the non-privileged driver context. For the approval step,
add a second entry that carries the operator token:

```json
{
  "mcpServers": {
    "loa-operator": {
      "type": "http",
      "url": "https://YOUR-APP.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_LOA_OPERATOR_TOKEN",
        "x-loa-operator": "YOUR_NAME"
      }
    }
  }
}
```

Schedule the routine, for example:

```
/schedule "0 9,12,15 * * 1-5" run the loa outreach driver for campaign CAMPAIGN_ID, one bounded cycle, then stop
```

The routine loads the driver prompt, runs one cycle, and exits. It does not loop.

## Codex (scheduled task)

Codex can run the same driver on a schedule as a scheduled task. Point Codex at
the same remote MCP URL (Codex reads MCP servers from its own config;
add an HTTP MCP server entry with the agent bearer token, and a second entry
carrying the operator bearer token). The scheduled task prompt is again the
example driver from `examples/driver/` with the URL and campaign id filled in.

Use the same cron cadence, `0 9,12,15 * * 1-5`, so both harnesses respect the
same wake spacing. Whichever harness you pick, one scheduled task equals one
bounded cycle.

## Stopping a run

The kill switch is server-side and independent of the schedule, so pausing the
account or killing everything works even if a wake is mid-flight.

- Pause one account (operator role): call `pause_account(accountId, reason)`. The
  next wake sees a non-runnable state from `get_account_state` and exits without
  sending. Resume later with `resume_account(accountId)`.
- Stop everything now (operator role): call `kill_all(reason)`. It bypasses the
  scheduler and halts every account immediately.
- Stop the schedule itself: disable or delete the Claude Code routine or the
  Codex scheduled task. That stops new wakes; it does not undo work already done.

Pausing the account is the safe default when something looks wrong: it is
reversible and it leaves the audit log intact.
