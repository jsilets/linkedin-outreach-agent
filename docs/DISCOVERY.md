# Lead sourcing, scoring, and list hygiene

Status: shipped.

This is how people get into a lead list, get an ICP fit score, and get filtered
before they reach a campaign. The design principle is that **sourcing and scoring
are separate steps**: a tool that fetches people never secretly scores them, and
scoring is its own step you can run (and re-run) independently.

```
 source_to_list ──► score_leads   (your judgment)  ──► remove_from_list ──► enroll_from_list(minScore, default 50) ──► campaign
                └─► score_list    (built-in heuristic)          ▲                        │
                                                                 └── off-ICP flagged ─────┘
                          re-run scoring any time the ICP changes (no re-fetch)
                          re-running enroll_from_list is safe: already-enrolled members are skipped, not duplicated
```

## The tools

- **`source_to_list`**: run a live people search and write the matches into a
  lead list. Fetch only, no scoring. This is the one way to get people into a
  list. Idempotent on `(listId, linkedinUrn)`.
- **`score_leads`**: the driving agent (Claude/Codex, or the GridLink sales
  harness) attaches its own fit scores: `{ linkedinUrn, score, reasons }` per
  member. This is the high-quality path: real judgment against the ICP.
- **`score_list`**: the built-in heuristic scores every member of a list against
  an ICP, offline and keyless. This is the fallback for an unattended run. It is
  a keyword/attribute matcher (a rough pre-filter), not a fit guarantee: it will
  pass a keyword match that is off-ICP. Re-run it after tightening the ICP to
  re-judge a list without re-fetching. It will not overwrite a score written by a
  different scorer (a harness score from `score_leads`) unless the call passes
  `overwrite: true`; members it skips for that reason are reported in
  `skippedOtherScorer`.
- **`remove_from_list`**: delete members from a list by URN. Physical delete; a
  list is a working set.
- **`enroll_from_list(listId, minScore, …)`**: the score-gated bridge from a
  list to a campaign, and the only one. `minScore` defaults to the ICP fit
  threshold (50), so unscored and off-ICP members are excluded unless the caller
  passes a lower `minScore` explicitly (`0` enrolls everyone). Only members
  scoring `>= minScore` become eligible; the score rides onto each target. Under
  the hood it routes through `add_targets`, which skips anyone already in the
  campaign by `linkedinUrn`, including previously removed targets (removal
  sticks); those skips are reported in `alreadyInCampaign`. Re-running it on the
  same list and campaign is safe and returns `added: 0` instead of erroring.
  Optionally enrolls under a sender account. Result shape:
  `{ campaignId, eligible, skippedBelowScore, alreadyInCampaign, added, enrolled }`.
- **`remove_from_campaign`**: eject a target already enrolled. Its sequence is
  stopped and any unsent message is cancelled. A target that was actually
  contacted (stage `invited` or beyond) is marked `lost`; a target that was never
  contacted keeps its stage, but its sequence cursor still goes to terminal
  `skipped`, so ejecting someone who was never messaged does not inflate invite
  metrics. Logical removal; the row is kept for the audit trail, and it is
  permanent with respect to re-enrollment: `enroll_from_list` will not re-add a
  removed person, and a `removed` marker on the target means `enroll_targets`
  and a campaign launch skip it too (reported as `skippedRemoved`).

There is no feature flag. Every tool above is offline except `source_to_list`
(which does a live search, same as `search_people`), and all are always wired.

## Where the score lives

The score is written into each member's `external_context` jsonb blob:

```json
{ "score": 87, "scoreModel": "heuristic-v1", "scoreReasons": ["title matches 'director'"], "icp": "US/CA field-operations leaders" }
```

`scoreModel` is `heuristic-v1` (from `score_list`) or `harness` (from
`score_leads`). Every read path parses this blob with one shared helper,
`readIcpScore` in `shared/src/icp.ts`, which also computes the `offIcp` flag
(`score < ICP_FIT_THRESHOLD`, 50, the heuristic's neutral line). The flag is
advisory: a low score on a sparse headline is a prompt to look, not an automatic
removal. This same 50 is the default `minScore` for `enroll_from_list`.

The blob rides onto the campaign target when a member is enrolled, so the score
shows on the funnel too.

## Where it shows in the UI

Both the list detail (`ListsView`) and the campaign funnel (`LeadsTable`) show a
**Fit** column, an `off-ICP` badge, tinted off-ICP rows, and a per-row **Remove**
button (list removal and campaign removal respectively). There is no
create-campaign-from-list shortcut in the web UI; `enroll_from_list` is the only
bridge from a list to a campaign, so the score gate cannot be bypassed from the
UI.

## Scoring: heuristic vs the harness

The `HeuristicQualifier` (`runtime/src/discovery/heuristic-qualifier.ts`) is a
transparent, offline, keyless scorer: a Bayesian-flavored log-odds sum over the
ICP's weighted `attributes` and free-text `description` matched against the
member's headline/company/location. It is deterministic and testable, and it is
the **floor**, not the ceiling: it is exactly what lets a keyword match ("…
reliability …") pass when the company is off-market.

The real qualifier is the **driving harness**. LOA is driven over MCP by Claude
Code / Codex (or the GridLink sales repo), which reads the candidates and the ICP
and judges fit with its own reasoning, then writes the result with `score_leads`.
There is no internal LLM scorer: the intelligence comes from the harness, not
from a key set on the framework. `score_list` exists only for keyless autonomous
runs.

## The ICP itself is not persisted

There is no `icps` table. An ICP is a call-time input (the `Icp` type in
`control-plane/mcp/src/ports.ts`: a `name`, optional discovery `query` facets, a
`description`, and weighted `attributes`). Its identity is recorded only as
`external_context.icp` on each scored member and in the list description. Named,
reusable ICP records are a follow-up. In the two-repo setup below, the ICP lives
in the driving repo (Attio + the sales toolkit), not here.

## Driving it (recurring top-of-funnel)

The framework is hands + a safety gate; the brain is an external harness. A
scheduled Claude/Codex session (or the GridLink sales repo) chains the tools:
`source_to_list` → `score_leads` (or `score_list`) → `remove_from_list` the
off-ICP ones → `enroll_from_list` above a `minScore`. See
[`SCHEDULING.md`](./SCHEDULING.md) and the driver prompt in
[`examples/driver/FEEDER.md`](../examples/driver/FEEDER.md).

## Scope walls

- **No off-platform signal detection in the core.** LOA does not sniff funding /
  tech stack / news. The `attach_external_context` seam consumes opaque enrichment
  blobs from outside; scoring produces such a blob. Neither teaches the campaign
  engine to detect anything.
- **Write through the existing list seams.** Scores go into the
  `lead_list_members.external_context` column that already exists and rides onto
  targets unchanged. No campaign-engine change.
