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

### Seam 2: `QualifierPort` (scoring)

Turns a candidate plus an ICP into a score. This is the OpenOutreach-style
qualification step: Bayesian and/or LLM judgment against the ICP.

```ts
export interface LeadScore {
  /** 0..100. Higher is a better ICP fit. */
  score: number;
  /** Short, operator-readable justification (shown in the UI, stored in blob). */
  reasons: string[];
  /** Which qualifier produced it, for auditing (e.g. "heuristic-v1"). */
  model: string;
}

export interface QualifierPort {
  score(candidate: Candidate, icp: Icp): Promise<LeadScore>;
}
```

Two implementations, chosen the same way `chooseLlm` picks a provider:

1. **`HeuristicQualifier` (default, offline, no key).** A transparent, Bayesian-
   flavored scorer over the fields discovery already returns (title/headline,
   company, seniority keywords, geography, degree). Each ICP attribute
   contributes a weighted log-likelihood; the sum is squashed to 0..100. It is
   deterministic, fast, free, and testable with no network. It is the floor: the
   module is useful with only this.
2. **`LlmQualifier` (opt-in, when a key is present).** Sends the candidate and
   the ICP to the configured provider (reusing the `ANTHROPIC_API_KEY` /
   `OPENROUTER_API_KEY` selection already in `config.ts`) and asks for a JSON
   `{score, reasons}`. This matches OpenOutreach's LLM-qualification path and
   handles fuzzy ICPs the heuristic cannot. It is a **new, narrow port**, not an
   addition to the locked `LLMProvider` interface (see Decisions).

A `CompositeQualifier` can gate the expensive LLM pass behind the cheap
heuristic (only LLM-score candidates the heuristic ranks above a floor), which
keeps token spend proportional to the shortlist. Optional; not first-cut.

## ICP input shape

The ICP is what the operator defines once and the module runs against. It has to
feed both seams: the `query` half drives discovery facets; the `criteria` half
drives qualification.

```ts
export interface Icp {
  /** Human label, e.g. "US/CA EV charging O&M leaders". */
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
  description: string; // "Director+ owning field operations at EV charging networks"
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
  "icp": "US/CA EV charging O&M leaders",
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
  - the `discover_leads` MCP tool is not registered,
  - the `POST /api/lists/discover` route returns 404,
  - `compose()` does not build the feeder.
- Qualifier selection is automatic: `HeuristicQualifier` unless a provider key is
  present and `LOA_DISCOVERY_LLM=true`, then `LlmQualifier`. The heuristic path
  runs fully offline, so the flag is safe to enable in dev and smoke.

## MCP + web surface

One new MCP tool and one new web route, both feature-gated. Both call the same
feeder, mirroring how `source_to_list` has a CLI and an MCP tool over one core.

- **`discover_leads`** (family: campaign, open, non-privileged): takes an ICP and
  a `listId` or `listName`, runs discover -> qualify -> rank -> write, returns
  `{ listId, discovered, scored, inserted, duplicates, topScore }`. Idempotent on
  `(listId, linkedinUrn)` like `source_to_list`; re-running re-scores and inserts
  only new people.
- **`POST /api/lists/discover`**: the web equivalent, so the operator can run
  discovery from the Lists tab (an ICP form) and watch the scored list fill.

## Implementation plan (phased, each independently landable)

1. **Types + ports.** `Icp`, `Candidate`, `LeadScore`, `DataSourcePort`,
   `QualifierPort` in a new `runtime/src/discovery/` module. No behavior yet.
2. **Persist scores.** Extend `memberRowFromPerson` / `LeadListAdapter.insertMembers`
   / store `insertMembers` to carry `external_context`. Unit test that a scored
   write round-trips the blob and that `source_to_list` still writes `{}`.
3. **Heuristic qualifier.** `HeuristicQualifier` + tests over canned candidates
   and ICPs (deterministic, offline). This is the scoring floor.
4. **Feeder core.** `discoverAndScore(deps, params)`: the discover -> score ->
   rank -> write pipeline, ports injected. Tests with a fake data source + the
   heuristic qualifier, asserting ranking, cutoff, and blob contents.
5. **Wiring + flag.** `LOA_DISCOVERY_*` config, `compose()` builds the feeder when
   enabled, `LiveSearchDataSource` over the existing `observe`.
6. **MCP tool.** Register `discover_leads` behind the flag; port method on a new
   `DiscoveryPort` added to `Ports`. Server test.
7. **Web route + UI.** `POST /api/lists/discover`, ICP form in `ListsView`, score
   column.
8. **LLM qualifier (opt-in).** `LlmQualifier` behind `LOA_DISCOVERY_LLM`, reusing
   the provider selection. Composite gating optional.

Steps 1 to 4 are pure and offline: they land and are fully tested with no live
account and no key. Steps 5 to 7 make it operator-visible. Step 8 is the quality
upgrade.

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

## Decisions to confirm before building

1. **Scorer as a new port, not an extension of `LLMProvider`.** `LLMProvider` is a
   locked interface (`shared/src/interfaces.ts`) whose change needs a coordinated
   migration across packages. Scoring is a different job (judge fit, not draft
   copy), so this proposes a separate `QualifierPort`. Recommended.
2. **First cut ships heuristic-only; LLM qualifier is step 8.** Keeps the initial
   change offline-testable and free, and proves the pipeline before spending
   tokens. Recommended.
3. **No `icps` table yet.** ICP is a call-time input, its identity recorded in the
   list + member blob. Named, reusable ICP records are a follow-up. Recommended.
4. **External data-source adapter is a seam only, not built now.** Default
   discovery reuses the live people search. Recommended.
