# linkedin-outreach-agent

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Status: scaffold. This repo currently holds the foundation only. Domain types, the two locked interfaces, and the database schema are built out; every other package is an empty stub for later work.

A self-hosted, agent-driven framework for running LinkedIn outreach across multiple accounts. A control plane plans campaigns and enforces safety; per-account runners drive a real browser to carry out actions. An LLM personalizes messages and classifies replies. Everything an account does is written to an append-only audit log.

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
