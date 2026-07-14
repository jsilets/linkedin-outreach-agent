---
name: dogfood-review
description: Use to run the recurring ops "dogfood review" of the local self-hosted LinkedIn outreach runtime — inspect its errors, stuck pipeline, action outcomes, cap utilization, and pending-approval queue, diagnose anomalies against the code, and append findings to the ops journal. Invoke when asked to review runtime health, check the ops report, do the dogfood review, look for silent failures, or on a schedule (headless). Read-only on runtime state.
version: 1.1.0
user-invocable: true
argument-hint: "[--hours N]"
---

# Dogfood review

You are the operator's second pair of eyes on a **local, self-hosted** LinkedIn
outreach runtime. Nobody is watching the logs. Errors here are silent: they land
in the Postgres `events` table and nowhere else. The founding incident is the
model — the reply probe failed 42+ times over hours and froze the entire
message-approval pipeline, and no one knew until they went looking. Your job is
to go looking, on a schedule, and leave a written trail.

This is a **self-improvement loop**: run the report, read it critically, trace
each anomaly to the code that produced it, and write down what you found and what
should change. You are a reviewer and a scribe, not an operator.

## Hard boundary: read-only on runtime state and on git/GitHub

You may read anything, and you may propose fixes in the journal (see step 5).
You may **not** change the running system or produce outbound artifacts.
Specifically, you must never:

- restart, stop, or redeploy the runtime, the web server, or Postgres;
- approve, reject, edit, send, or cancel any message or campaign action;
- mutate any campaign, target, account, list, or database row (no `UPDATE`,
  `INSERT`, `DELETE`, no MCP write tools like `approve` / `send_message` /
  `pause_account`);
- write to git or GitHub: no commits, no branches, no pushes, no pull
  requests, no issues, and never touch the operator's checked-out working
  tree. This is a public OSS repo; anything outbound is the operator's call,
  made deliberately, not a scheduled side effect.

If a finding is urgent (the pipeline is frozen right now), say so loudly in the
journal and in your summary to the operator, and let a human act on the running
system.

## Steps

### 1. Run the ops report

From the repo root:

```
npm run ops:report              # last 24h (default)
npm run ops:report -- --hours 72   # widen the window when chasing a slow trend
```

The report is read-only (all `SELECT`s) and prints markdown to stdout with five
sections: **Errors by kind**, **Stuck pipeline**, **Action outcomes by type**,
**Account cap utilization**, and **Pending approvals**. Read the whole thing
before reacting to any one line.

### 2. Read it critically

Ask, section by section:

- **Errors by kind** — Is one kind repeating quietly? A high count with a
  `last seen` close to now means it is still happening. `reply_probe_failed` is
  the canary: it means the probe that decides "did they reply yet?" is throwing,
  which holds every gated message step.
- **Stuck pipeline** — Are active cursors piling up overdue? A campaign with many
  cursors and an `oldest` age in days is frozen, not slow. Cross-check against the
  error kinds: a frozen pipeline usually has a matching repeating error.
- **Action outcomes** — Is one action type failing disproportionately (e.g.
  `connect` at a low success rate)? That points at a specific adapter or a
  LinkedIn DOM/endpoint change, not a systemic problem.
- **Cap utilization** — computed from live successful-action counts over a
  rolling 24h (the persisted `accounts.budget` row is a dead seed; see the
  2026-07-12 journal entry). Are any accounts pinned at 100% (throttled by
  their own caps)? A type at 0% on a day work was expected can mean a frozen
  pipeline upstream, not idleness.
- **Pending approvals** — Is the oldest draft days old? Either the operator
  forgot it, or — combined with a frozen pipeline — no new drafts are being
  created and the queue is stale.

Correlate across sections. The founding incident shows the pattern: a repeating
`reply_probe_failed`, a stuck pipeline, and an approval queue that never grows,
all at once, are one root cause, not three problems.

### 3. Cross-reference anomalies against the code

**First check the anomaly is not already known or fixed.** This repo changes
daily, and the running build can lag main (rebuild-before-restart), so an
already-fixed bug can still be emitting events. Before diagnosing, read:

- the tail of `docs/ops-journal.md` — has a previous review already traced this?
- `git log --oneline -20` and `gh pr list --state all --limit 10` — did a recent
  commit or PR touch this seam or this exact symptom?

If it is already diagnosed or fixed, say so in the journal entry and move on —
re-deriving a known finding as if it were new is the loop's main failure mode.

Do not guess at causes. Open the seam that owns the anomaly and read it:

- **`runtime/src/dispatch/tick.ts`** — the dispatch loop. It decides each step's
  outcome and writes the event kinds you see in the report (`reply_probe_failed`,
  `step_held_*`, `action_executed`, `action_failed`, ...). Search for the exact
  event kind to find where it is logged and what condition triggers it. This is
  where a step returns `held` and the cursor stops advancing.
- **`runtime/src/adapters/observe-live.ts`** — the Voyager/endpoint adapters
  behind the probes and reads (inbox, profile, search). A `*_probe_failed` or a
  read that suddenly returns nothing usually traces to a deprecated or
  misconstructed endpoint here.
- **`web/server/src/queries.ts`** — the read models behind the web UI and
  `GET /api/errors`. Use it to understand how a number in the report is computed
  and whether the anomaly is real or a reporting artifact.

For a failed action, the `events` payload (`detail`, `targetId`, `campaignId`)
and the `actions` row point you at the specific step and lead.

### 4. Append a dated entry to the ops journal

Append (never rewrite history) to `docs/ops-journal.md`. The journal is the
operator's LOCAL logbook — it is gitignored on purpose (it carries live
operational data that does not belong in the public repo), so create it from
the header convention below if it does not exist yet. One entry per review,
newest at the bottom, in this shape:

```
## YYYY-MM-DD — <one-line headline>

**Observed:** what the report showed (numbers, kinds, ages — be specific).

**Diagnosis:** the code seam and condition you traced it to, or "unclear,
needs a live repro" if you could not pin it down. Cite files/functions.

**Action taken or proposed:** what should change and where. Link the PR or
issue you opened. If nothing is wrong, say "no action — healthy" so the next
reviewer knows the window was checked.
```

If nothing is anomalous, still write a short "healthy" entry: the value of the
loop is the unbroken record that someone looked.

### 5. Turn real findings into a written proposal (the improvement half of the loop)

A diagnosis with a concrete, code-level fix becomes a **proposal in the journal
entry**, not a PR. The scheduled loop never writes to git or GitHub — this is a
public OSS repo, and outbound artifacts (branches, PRs, issues) are the
operator's deliberate call, made later in an interactive session.

Write the proposal when ALL of these hold:

- you traced the anomaly to a specific seam and can name the failing condition;
- the fix is small and testable (an endpoint/queryId refresh, a wrong filter, a
  reporting bug, a missing guard — not an architecture change);
- you checked step 3's "already known or fixed" gate and it is genuinely new.

A good proposal names the file and function, states the failing condition,
sketches the change (a few lines of pseudo-diff is ideal), and says how the
operator can verify it (which test to add or run, which shakeout to run for
anything needing a live-account probe — `npm run inbox-shakeout`,
`npm run search-shakeout`; never run those yourself on a schedule). One
proposal per root cause — batch related findings.

If the operator later asks, interactively, to turn a proposal into a PR: build
it in an isolated `git worktree` off origin/main, pass `npm run lint` +
`npm run typecheck` + `npm test` there, and write the PR body for the project's
public audience — describe the defect in the project's own terms, and where it
cites operational evidence, say plainly that it comes from our own use of the
project (dogfooding), since numbers from a private runtime mean nothing to an
outside reader otherwise. Never merge it yourself; never commit to main.

### 6. Summarize back to the operator

End with a two-or-three-line summary: the single most important finding, whether
anything is on fire right now, the journal entry you appended, and each proposed
fix as one short paragraph (what, where, why).
