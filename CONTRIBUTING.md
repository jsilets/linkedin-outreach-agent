# Contributing

Thanks for your interest in the project. This is a small codebase with a few
firm conventions. Reading them first will save a round trip.

## Setup

Requires Node 24+ (`engines.node` is `>=24`). This is an npm workspaces monorepo;
packages are scoped `@loa/*`.

```bash
npm install        # install all workspaces
npm run typecheck  # tsc -b across every package
npm run build      # tsc -b, emits dist/ per package
npm test           # vitest run
npm run lint       # biome check (lint + format)
npm run knip       # unused files/exports/dependencies
```

`npm run format` applies Biome's formatting. CI runs typecheck, lint, test, and
knip on every PR.

Copy `.env.example` to `.env` before running anything that touches the database
or an external API. See the [README](./README.md) for the repo layout and
[`docs/DRIVING.md`](./docs/DRIVING.md) for how the agent drives the system.

## Before you open a PR

- `npm run typecheck`, `npm test`, `npm run lint`, and `npm run knip` pass
  (CI enforces all four).
- The change is scoped to one thing. No drive-by refactors, renames, or
  reformatting outside what the change needs.
- Behavior claims come with the command output that shows them.
- New dependencies, formatters, or build tooling need a reason stated in the PR.

## The two locked interfaces

`SafetyGate` and `LLMProvider` live in `@loa/shared` and are consumed across
every package. Do not change their shape without a coordinated migration and a
clear reason in the PR. They are documented in the [README](./README.md).

## Safety

This framework drives real accounts against a live platform. Changes that touch
the safety gate, the daily caps, the autonomy/approval flow, or the account
state machine get extra scrutiny. Call out any such change explicitly in the PR
description and include a test that covers the new behavior.

## Database changes

Schema lives in `shared/src/db/schema.ts` and is driven by Drizzle Kit from the
repo root. When you change it, generate and commit the migration:

```bash
npm run db:generate   # generate SQL migrations into infra/migrations
npm run db:migrate    # apply them (needs DATABASE_URL)
```

## Branches and commits

- Use descriptive branch names. No agent or vendor prefixes.
- Write commit messages and PR descriptions in plain sentences that say what
  changed and why.

## Licensing

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE), the same license as the project.
