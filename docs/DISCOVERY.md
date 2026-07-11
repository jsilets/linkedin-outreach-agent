# Lead discovery and scoring (feeder module)

Status: design, pre-implementation. Feature-flagged; off by default.

## What this adds

Today an operator hand-builds a lead list: they pick the search facets, run
`source_to_list`, and everything that lands is treated as equally worth
contacting. The one thing OpenOutreach does that LOA does not is turn an ICP into
a ranked list on its own: discover candidates against a described ideal customer,
score each one, and surface the best.

This module is that layer. It sits in front of the existing sourcing pipeline as
a **feeder**: it discovers candidates, qualifies them against an operator-defined
ICP, and writes a ranked, scored list into the same `lead_lists` /
`lead_list_members` tables the UI already reads. It adds no detection or
targeting logic to the campaign engine.

## Scope walls (do not cross)

These are the constraints the module is built to respect, restated so the
implementation stays honest to them.

- **No off-platform signal detection in the core.** LOA deliberately does not go
  sniff a company's funding, tech stack, or news. The `attach_external_context`
  MCP seam consumes opaque enrichment blobs from outside. This module is a
  separate feeder that *produces* such blobs; it does not teach the engine to
  detect anything.
- **Write through the existing list seams, not new engine paths.** Output goes to
  `create_list` / `source_to_list` / `lead_list_members`. The per-lead score is
  stored in the member's `external_context` jsonb (a column that already exists),
  which `createCampaignFromList` already copies onto the campaign target's
  `external_context`. So the score rides into the campaign through the same blob
  `attach_external_context` reads. No campaign-engine change.
- **License.** OpenOutreach is GPLv3. Reference only. Zero code copied. The
  scoring model below is designed from its description, not its source.

## Where it plugs in

```
                 operator-defined ICP
                          |
                          v
   +----------------------------------------------+
   |            discovery feeder (new)             |
   |                                               |
   |  1. discover    DataSourcePort.discover(icp)  |
   |     candidates  ---------------------------+  |
   |                                            |  |
   |  2. qualify     QualifierPort.score(cand,  |  |
   |     each        icp) -> {score, reasons}   |  |
   |                                            |  |
   |  3. rank + cut  sort desc, keep top N /    |  |
   |                 score >= threshold         |  |
   +--------------------------|-------------------+
                              v
        store.leadList.insertMembers(listId, scoredRows)
         (score written into member.external_context)
                              |
                              v
              web UI ListsView shows score column
                              |
                              v
        createCampaignFromList  ->  target.external_context
                              |
                              v
        campaign engine (unchanged) / attach_external_context
```

The feeder depends on two ports and one store surface. Everything else it reuses.

### Seam 1: `DataSourcePort` (candidate discovery)

Where candidates come from. The default implementation wraps the existing live
people search, so day-one discovery needs no new data provider.

```ts
export interface Candidate {
  // Superset of PersonSearchResult; a data source fills what it has.
  entityUrn: string;
  profileUrl: string;
  name?: string;
  headline?: string;
  currentCompany?: string;
  location?: string;
  degree?: string;
  publicId?: string;
  linkedinUrn?: string;
  // Opaque provider extras (e.g. an external enricher's firmographics). Passed
  // through to the qualifier and, when present, persisted in external_context.
  raw?: Json;
}

export interface DataSourcePort {
  /** Discover candidates for an ICP. May page internally up to `limit`. */
  discover(accountId: string, icp: Icp, limit: number): Promise<Candidate[]>;
}
```

- `LiveSearchDataSource` (default): translates `icp.query` into a `PeopleQuery`
  and calls `ObservePort.searchPeople`. This is the LinkedIn people-search facet
  path already in `observe-live.ts`. No new dependency.
- `ExternalProviderDataSource` (later, optional): an adapter to a paid provider
  (Apollo/Clay/etc.) behind the same port. Out of scope for the first cut, but
  the port exists so it drops in without touching the feeder.

`accountId` is threaded through because the default source runs a live search on
that account's session. An external provider ignores it.

### Seam 2: scoring

There are two ways a candidate gets a score, and both land in the same place
(the member's `external_context`). They are not competing designs; they serve
different runs.

**Path A: `QualifierPort` (in-process, autonomous, keyless).** A candidate plus
an ICP in, a score out. Used by the one-shot `discover_leads` tool so a run needs
no key and no agent in the loop.

```ts
export interface LeadScore {
  score: number;      // 0..100, higher is a better ICP fit
  reasons: string[];  // operator-readable justification (UI + blob)
  model: string;      // which scorer produced it (audit), e.g. "heuristic-v1"
}

export interface QualifierPort {
  score(candidate: Candidate, icp: Icp): Promise<LeadScore>;
}
```

The only implementation is **`HeuristicQualifier`**: a transparent, Bayesian-
flavored scorer over the fields discovery already returns (title/headline,
company, seniority keywords, geography, degree). Each ICP attribute contributes a
weighted log-likelihood; the sum is squashed to 0..100. Deterministic, fast,
free, offline-testable. This is the floor.

**Path B: the driving harness is the qualifier.** In practice LOA is driven by
Claude Code or Codex over MCP, and that harness supplies the intelligence. So the
"LLM qualification" is not an internal API call; it is the driving agent reading
the candidates and the ICP and scoring them with its own judgment, then writing
the scores back over MCP. The flow is:

1. `source_people` (existing) or `source_to_list` (existing) -> raw candidates.
2. The agent scores each against the ICP in its own reasoning.
3. `score_leads` (new) writes those scores into the list members'
   `external_context`.

This is the premium path and needs no key. There is deliberately **no internal
`LlmQualifier`** that calls Anthropic or OpenRouter: the operator does not run
one, and an in-process model call would duplicate the intelligence the harness
already provides. (An OpenRouter-backed `QualifierPort` remains possible behind
the same seam if a fully-unattended autonomous LLM run is ever wanted, but it is
not built.)

## ICP input shape

The ICP is what the operator defines once and the module runs against. It has to
feed both seams: the `query` half drives discovery facets; the `criteria` half
drives qualification.

```ts
export interface Icp {
  /** Human label, e.g. "US/CA field-operations leaders". */
  name: string;

  /** Discovery facets. Maps directly onto PeopleQuery. */
  query: {
    keywords?: string;
    titleKeywords?: string[];
    companyKeywords?: string[];
    companyUrns?: string[];
    geoUrns?: string[];
    network?: Array<'F' | 'S' | 'O'>;
  };

  /** Qualification criteria. Free-text description plus optional weighted,
   *  structured attributes the heuristic can score without an LLM. */
  description: string; // "Director+ owning field operations at target-industry firms"
  attributes?: Array<{
    /** What to look at: 'title' | 'company' | 'seniority' | 'location' | 'industry'. */
    field: IcpField;
    /** Values that count as a hit (OR-ed). */
    match: string[];
    /** Relative importance. Default 1. */
    weight?: number;
    /** true = presence is disqualifying (negative signal). Default false. */
    negative?: boolean;
  }>;

  /** Cutoffs. */
  minScore?: number; // drop below this (default 0 = keep all, ranked)
  limit?: number;    // max candidates to discover (default 25)
}
```

The ICP is not a new table in the first cut. It is passed into the tool call and
the API route, and its identity is recorded in the list description and in each
member's `external_context.icp`. Persisting ICPs as reusable named records is a
follow-up once the shape settles.

## Output: a scored, ranked list

The feeder writes to the existing list tables. The only schema-adjacent change is
that member writes must carry `external_context` (the score), which the current
`insertMembers` path drops.

Per-member `external_context` written at discovery time:

```json
{
  "score": 87,
  "scoreModel": "heuristic-v1",
  "scoreReasons": ["title matches 'director of operations'", "US-based", "2nd degree"],
  "icp": "US/CA field-operations leaders",
  "profileUrl": "https://www.linkedin.com/in/...",
  "name": "...",
  "headline": "...",
  "currentCompany": "..."
}
```

Because `createCampaignFromList` already copies `external_context` onto the
target, the score is present on the campaign target with no extra call, and
`attach_external_context` can update or augment it later. That is the constraint
"attach scores via `attach_external_context`" satisfied through the blob it owns.

Two small changes make the score real end to end:

- **Persist it.** `LeadListAdapter.insertMembers` and `memberRowFromPerson`
  currently omit `external_context`. Extend the member-row mapping to accept a
  per-person context blob so the score is written. `source_to_list` (no scoring)
  keeps writing `{}` and is unchanged in behavior.
- **Show it.** `ListsView` gets a `Score` column (sortable, default sort desc)
  read from `member.external_context.score`. `ListDetail`/`ListMember` in the
  MCP and web API grow an optional `score` field surfaced from the blob. Lists
  built without scoring show a blank score column, no regressions.

## Feature flag

Off by default. Presence-gated, matching how the runtime already treats optional
capabilities (real executor, dispatch tick, LLM keys).

- `LOA_DISCOVERY_ENABLED=true` turns the module on. When unset:
  - `compose()` leaves `ports.discovery` undefined,
  - `discover_leads` and `score_leads` reject with "discovery is disabled".
- No qualifier-selection flag: the autonomous path always uses the offline
  `HeuristicQualifier` (no key), and the harness-driven path needs no scorer at
  all. Safe to enable in dev and smoke.

## MCP + web surface

Two new MCP tools, both feature-gated behind `LOA_DISCOVERY_ENABLED` and absent
otherwise (the handler rejects with a clear error when the port is not wired).

- **`discover_leads`** (path A, autonomous): takes an ICP and a `listId` or
  `listName`, runs discover -> heuristic-score -> rank -> write, returns
  `{ listId, discovered, scored, inserted, duplicates, topScore }`. Idempotent on
  `(listId, linkedinUrn)` like `source_to_list`; re-running re-scores and inserts
  only new people.
- **`score_leads`** (path B, harness-driven): takes a `listId` and an array of
  `{ linkedinUrn, score, reasons? }` and writes each score into that member's
  `external_context`. This is the list-stage sibling of `attach_external_context`
  (which only reaches campaign targets). The driving agent calls it after
  reasoning over the candidates a `source_to_list` / `get_list` returned.

The score, once on a member, rides onto the campaign target through the
`external_context` copy in `createCampaignFromList`, unchanged.

## Implementation plan (phased, each independently landable)

1. **Types + ports.** `Icp` / `IcpAttribute` / `IcpField` + `DiscoveryPort` in
   `@loa/mcp` (they cross the tool boundary); `Candidate`, `LeadScore`,
   `DataSourcePort`, `QualifierPort` in a new `runtime/src/discovery/` module.
2. **Heuristic qualifier.** `HeuristicQualifier` + tests over canned candidates
   and ICPs (deterministic, offline). The scoring floor.
3. **Data source + feeder core.** `LiveSearchDataSource` over `observe`, and
   `discoverAndScore(deps, params)`: discover -> score -> rank -> write, ports
   injected. Writes `external_context` (the store `insertMembers` already
   persists it). Tests with a fake data source + heuristic, asserting ranking,
   cutoff, and blob contents.
4. **Member score write.** `updateMemberContext(listId, linkedinUrn, patch)` on
   the store (both backends) for the harness-driven path. Round-trip test.
5. **Wiring + flag.** `LOA_DISCOVERY_ENABLED` config; `compose()` sets
   `ports.discovery` (a `DiscoveryAdapter` over the feeder + store) only when on.
6. **MCP tools.** `discover_leads` and `score_leads`, both guarding on
   `ports.discovery`. Server/handler tests.
7. **UI.** Score column in `ListsView` detail, read from
   `member.external_context.score` (surfaced through `getList`). Lists without
   scores show a blank column, no regression.

Steps 1 to 4 are pure and offline: fully tested with no live account and no key.
Steps 5 to 7 make it operator-visible.

## Testing

- Heuristic qualifier: table-driven over (candidate, ICP) -> expected score band.
- Feeder: fake `DataSourcePort` returning fixed candidates + heuristic qualifier,
  assert order, cutoff, and that each written member carries the score blob.
- Persistence: score blob round-trips through `insertMembers` and appears on the
  target after `createCampaignFromList`.
- Flag off: tool unregistered, route 404, `compose()` builds no feeder.
- Live (manual, gated): one `discover_leads` run against the real account with a
  small `limit`, per the verification-cadence rule (one spaced call, real HTTP
  signal), confirming a scored list appears in the UI.

## Decisions

1. **The harness is the LLM qualifier; no internal model call.** LOA is driven by
   Claude Code / Codex over MCP, which already supplies the intelligence. So the
   premium scoring path is the driving agent scoring candidates itself and
   writing them back via `score_leads`. No `LlmQualifier` calling
   Anthropic/OpenRouter is built; an OpenRouter-backed `QualifierPort` stays
   possible behind the seam but is not needed.
2. **`QualifierPort` is separate from the locked `LLMProvider`.** `LLMProvider`
   (`shared/src/interfaces.ts`) needs a coordinated cross-package migration to
   change, and scoring is a different job (judge fit, not draft copy).
3. **No `icps` table yet.** ICP is a call-time input, its identity recorded in the
   list + member blob. Named, reusable ICP records are a follow-up.
4. **External data-source adapter is a seam only, not built now.** Default
   discovery reuses the live people search.
5. **Web discovery route deferred.** The autonomous and harness-driven paths both
   run over MCP (a live search needs the runtime's account session), so the
   operator triggers discovery through the harness, not a web form. The web UI's
   job is to show the resulting scored list. A `POST /api/lists/discover` that
   proxies to the runtime MCP can follow if a no-harness UI trigger is wanted.
