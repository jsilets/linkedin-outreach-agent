# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

First tagged release. The stack has run the connect, accept, and message loop
against live LinkedIn on a single supervised account with the safety gate
enforced server-side.

### Added

- Control plane exposed over MCP: campaign planning, sourcing and lead-list
  tools, sequence definition, and an approval flow for supervised autonomy.
- Per-account runner driving a real headful browser (session, safety pre-flight,
  executor, reply detector) with an append-only audit log.
- Server-side `SafetyGate`: daily caps, working hours and days, account state
  machine, operator pause, and approval-time enforcement.
- Driven mode (an external agent as the brain over MCP) and autonomous mode (an
  internal LLM loop), both gated the same way server-side.
- Campaign-visibility web dashboard: funnel, per-lead table, and in-UI approvals.
- Single-image Docker deployment (Xvfb plus headful Chromium) and a Railway
  config, with `LOA_EXECUTOR=fake` as the default for safe exploration.

[0.1.0]: https://github.com/jsilets/linkedin-outreach-agent/releases/tag/v0.1.0
