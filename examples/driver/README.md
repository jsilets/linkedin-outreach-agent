# Example driver

A runnable driver you can load into a Claude Code or Codex session (or a
scheduled routine / task) to act as the outreach brain against your own
`@loa/mcp` endpoint. The driver reads the account state, drafts copy with its own
model, and calls the gated Act tools. The server-side gate decides what actually
sends.

Read `docs/DRIVING.md` for the topology and `docs/SCHEDULING.md` for running this
on a schedule.

## Files

- `SKILL.md`: the driver prompt itself. Load this as the session's system prompt
  or skill / routine instructions. It encodes the playbook and the safety
  posture.

## Setup

1. Deploy the framework (see `infra/RAILWAY.md`) and note the MCP URL, which ends
   in `/mcp`.
2. Connect your harness to the MCP server. In Claude Code, add an HTTP MCP server
   for the driver (the non-privileged agent token), and a second one with the
   operator token for approvals:

   ```json
   {
     "mcpServers": {
       "loa": {
         "type": "http",
         "url": "https://YOUR-APP.up.railway.app/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_LOA_MCP_TOKEN"
         }
       },
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

   The bearer token decides the role: `LOA_MCP_TOKEN` is the non-privileged
   driver, `LOA_OPERATOR_TOKEN` unlocks approvals and safety. `x-loa-operator` is
   just an audit label.

   In Codex, add the same two HTTP MCP servers in Codex's own config.
3. Create a campaign and add targets once (either by hand through the tools or in
   a first driver session), and note the `campaignId` and `accountId`.
4. Load `SKILL.md` into the session and replace the placeholders:
   - `MCP_URL`: your `/mcp` endpoint.
   - `CAMPAIGN_ID`: the campaign to work.
   - `ACCOUNT_ID`: the account to run.
   - `OPERATOR_NAME`: your operator name, used only for the approval step.

## Running it

- One-off: paste `SKILL.md` (with placeholders filled) into a Claude Code or
  Codex session and tell it to run one cycle.
- Scheduled: use it as the prompt for a Claude Code scheduled routine or a Codex
  scheduled task on the cadence in `docs/SCHEDULING.md`
  (`0 9,12,15 * * 1-5`). Each wake runs one bounded cycle and stops.

## Safety posture

The driver is written to respect the gate. It never tries to exceed budget, it
treats `deferred` and `denied` results as final, and it surfaces challenges or
restrictions to the human instead of working around them. Approvals are a
separate, privileged step; under `supervised` autonomy nothing sends without a
human `approve` or `edit_and_approve`.
