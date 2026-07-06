# linkedin-outreach-agent

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Status: pre-first-live-run. The full stack is built and unit-tested — the campaign engine, sourcing and lead-list tools over MCP, the safety gate, account linking, the web UI, the real-browser executor, and the reply-detection loop. What has not happened yet is a single end-to-end run against live LinkedIn on a real account; the browser-driven paths (DOM selectors, the Voyager inbox parse, session resume) are wired but unproven until that run. Deploy with `LOA_EXECUTOR=fake` to explore the surface safely; see `infra/RAILWAY.md` to enable real sending for one supervised account.

A self-hosted, agent-driven framework for running LinkedIn outreach across multiple accounts. A control plane plans campaigns and enforces safety; per-account runners drive a real browser to carry out actions. An LLM personalizes messages and classifies replies. Everything an account does is written to an append-only audit log.

## How it's driven (bring your own agent)

The framework is an MCP server. It is the hands plus a server-side safety gate, not the brain. The brain can come from two places:

- **Driven mode (primary):** an external agent, Claude Code or Codex running on your own model subscription, connects to the MCP server as the client. It calls the Observe tools, writes the copy itself, and calls the gated Act tools. No LLM key and no per-token cost on the framework side.
- **Autonomous mode (fallback):** with no external agent attached, the framework runs its own loop and calls an LLM through a key. The internal LLM is optional and selected by which key is set (OpenRouter, else Anthropic, else an offline fake), and used only in this mode.

Both are safe the same way: the autonomy and approval gate is enforced server-side regardless of which brain drives. Under `supervised` autonomy every send and reply queues to human approval.

See [`docs/DRIVING.md`](./docs/DRIVING.md) for the topology and the driver playbook, and [`docs/SCHEDULING.md`](./docs/SCHEDULING.md) to run driven mode on a schedule.

## Docs

- [`docs/DRIVING.md`](./docs/DRIVING.md): driven vs autonomous mode, capability headers, the per-cycle driver playbook.
- [`docs/SCHEDULING.md`](./docs/SCHEDULING.md): running driven mode on a cron cadence with Claude Code and Codex.
- [`docs/P0-RUNBOOK.md`](./docs/P0-RUNBOOK.md): first supervised run, one account, end to end.
- [`examples/driver/`](./examples/driver/): a copy-paste driver prompt for Claude Code or Codex.
- [`infra/RAILWAY.md`](./infra/RAILWAY.md), [`infra/PROXY.md`](./infra/PROXY.md): deployment and proxy leak guard.

## Repo shape

This is an npm workspaces monorepo. Packages are scoped `@loa/*`.

```
linkedin-outreach-agent/
  control-plane/
    mcp/            @loa/mcp          MCP server exposing control-plane tools to the agent
    orchestrator/   @loa/orchestrator campaign state machine and action planning
    scheduler/      @loa/scheduler    time and budget aware action queue
    agent/          @loa/agent        LLM-driven decision loop
    safety/         @loa/safety       SafetyGate implementation and account state machine
  account-runner/   @loa/account-runner per-account browser runner (session, safety, executor, detector as folders)
  shared/           @loa/shared       domain types, enums, locked interfaces, Drizzle schema
  infra/            @loa/infra        deployment, migrations, proxy and vault wiring
```

`account-runner` is a single package. Its `session`, `safety`, `executor`, and `detector` concerns live as folders under `src/`, not as separate workspace packages, to keep the runner's internals cohesive. Note that the control-plane `SafetyGate` contract lives in `@loa/safety`; the runner's `safety` folder is only a local pre-flight mirror.

## The two locked interfaces

Every package implements or consumes these. They live in `@loa/shared` and should not change shape without a coordinated migration.

```typescript
interface SafetyGate {
  canAct(acct: Account, action: Action): Decision;   // allow | defer(until) | deny(reason)
  onSignal(acct: Account, sig: Signal): Transition;
  budget(acct: Account): DailyBudget;
}

interface LLMProvider {
  personalize(ctx: TargetContext): Promise<Draft>;
  classifyReply(msg: Message): Promise<Intent>;
  draftReply(thread: Thread, intent: Intent): Promise<Draft>;
}
```

## Development

Requires Node 24+.

```bash
npm install        # install all workspaces
npm run typecheck  # tsc -b across every package
npm run build      # tsc -b, emits dist/ per package
npm test           # vitest run
```

Database schema lives in `shared/src/db/schema.ts` and is driven by Drizzle Kit from the repo root:

```bash
npm run db:generate   # generate SQL migrations into infra/migrations
npm run db:migrate     # apply them (needs DATABASE_URL)
```

Copy `.env.example` to `.env` and fill it in before running anything that touches the database or an external API.
