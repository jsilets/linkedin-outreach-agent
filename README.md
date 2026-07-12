# linkedin-outreach-agent

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

A self-hosted, agent-driven framework for running LinkedIn outreach across multiple accounts. A control plane plans campaigns and enforces safety; per-account runners drive a real browser to carry out actions. An LLM personalizes messages and classifies replies. Everything an account does is written to an append-only audit log.

The default executor is `LOA_EXECUTOR=fake`, which exercises the whole surface without touching LinkedIn. See [`infra/README.md`](./infra/README.md) to switch a single supervised account to real sending.

## How it's driven (bring your own agent)

The framework is an MCP server. It is the hands plus a server-side safety gate, not the brain. The brain can come from two places:

- **Driven mode (primary):** an external agent, Claude Code or Codex running on your own model subscription, connects to the MCP server as the client. It calls the Observe tools, writes the copy itself, and calls the gated Act tools. No LLM key and no per-token cost on the framework side.
- **Autonomous mode (partial):** the framework has an internal agent loop and an optional LLM, selected by which key is set (OpenRouter, else Anthropic, else an offline fake). Nothing schedules the loop yet — only the smoke scenario runs it — so today the internal LLM's real job is classifying replies for the reply-detection tick. Driving over MCP is how outreach actually runs.

Both are safe the same way: the autonomy and approval gate is enforced server-side regardless of which brain drives. Under `supervised` autonomy every send and reply queues to human approval.

See [`docs/DRIVING.md`](./docs/DRIVING.md) for the topology and the driver playbook, and [`docs/SCHEDULING.md`](./docs/SCHEDULING.md) to run driven mode on a schedule.

## Docs

- [`docs/DRIVING.md`](./docs/DRIVING.md): driven vs autonomous mode, capability headers, the per-cycle driver playbook.
- [`docs/SCHEDULING.md`](./docs/SCHEDULING.md): running driven mode on a cron cadence with Claude Code and Codex.
- [`docs/P0-RUNBOOK.md`](./docs/P0-RUNBOOK.md): first supervised run, one account, end to end.
- [`examples/driver/`](./examples/driver/): a copy-paste driver prompt for Claude Code or Codex.
- [`infra/README.md`](./infra/README.md), [`infra/PROXY.md`](./infra/PROXY.md): deployment and proxy leak guard.

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
  runtime/          @loa/runtime      deployable composition root: wires store, gate, executor, ticks, and the MCP server
  web/              @loa/web          campaign dashboard UI + JSON API (approval writes proxy to the runtime's MCP server)
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
