# Ops journal

A running log of the **dogfood review** — the recurring, read-only health check a
Claude Code session runs against the local self-hosted runtime (see
`.claude/skills/dogfood-review/SKILL.md`). This is a self-improvement loop for a
tool with no external error service: errors land in the Postgres `events` table
and nowhere else, so someone has to go look, on a schedule, and write down what
they found.

## Convention

- One entry per review, **newest at the bottom**. Append; never rewrite history.
- Each entry has three parts:
  - **Observed** — what `npm run ops:report` showed (numbers, error kinds, ages).
  - **Diagnosis** — the code seam and condition it traced to, with file/function
    citations, or an honest "unclear, needs a live repro".
  - **Action taken or proposed** — the fix and where it belongs. Proposed fixes
    become journal entries and, when they deserve tracked work, GitHub issues.
    They are **never** direct changes to running state: the review is read-only
    and never restarts services, approves/sends messages, or mutates campaigns.
- A healthy window still gets a short "no action — healthy" entry, so the record
  of "someone checked" is unbroken.

---

## 2026-07-12 — reply_probe_failed froze the approval pipeline (founding incident)

**Observed:** The reply probe failed silently 42+ times over several hours. Each
failure wrote a `reply_probe_failed` row to the `events` table and produced no
other signal — no UI, no line in `~/.loa/logs/runtime.log`, no aggregate. The
message-approval pipeline stopped entirely: active enrollment cursors sat overdue
in `target_progress` and no new approval drafts were created, so the pending
queue never grew. Nothing surfaced the problem until someone went looking in
Postgres by hand. This incident is why the observability seam
(`GET /api/errors`), the ops report (`npm run ops:report`), and this review loop
exist.

**Diagnosis:** In `runtime/src/dispatch/tick.ts`, the per-step reply check calls
the inbox reply probe **before** the gate/act stage. The probe threw because it
hit the deprecated `LEGACY_INBOX` Voyager endpoint in
`runtime/src/adapters/observe-live.ts` (the same class of Voyager-endpoint
deprecation that has bitten profile and search reads). The tick caught the throw,
logged `reply_probe_failed`, and returned a `held` outcome — correctly refusing
to send when it cannot confirm the person has not replied. But because the probe
ran ahead of the draft-creation (`gateAct`) step, a held outcome meant **no draft
was ever created**: the failure both blocked sends and starved the approval
queue. With the probe throwing on every tick, every gated message step held
forever, and the whole pipeline froze with zero operator-visible signal.

**Action taken or proposed:** Two-part fix on branch
`fix/inbox-probe-and-draft-first`:
1. **Endpoint migration** — move the reply probe off the deprecated
   `LEGACY_INBOX` endpoint to the current Voyager path in `observe-live.ts`, so
   the probe stops throwing.
2. **Draft-first reordering** — in `tick.ts`, create the approval draft before
   the reply probe gates the actual send. A probe failure should hold the *send*,
   not prevent the *draft* from ever existing, so the operator still sees a
   pending item (and a visible error) instead of silence.

Follow-on from this review, now shipped on `feat/ops-observability`: the
`events`-table failures are no longer invisible — `GET /api/errors` and
`npm run ops:report` both surface repeating kinds like `reply_probe_failed` with
first/last-seen and a stuck-pipeline rollup, which is exactly the signal that was
missing when this incident happened.
