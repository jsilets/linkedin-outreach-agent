// LiveObserve.searchPeople — free-tier Voyager (Flagship) people search.
//
// Strategy (Linki-style, clean-room): drive the account's real logged-in page
// to a LinkedIn people-search URL and INTERCEPT the JSON the page already
// fetches (voyagerSearchDashClusters) rather than scraping the DOM or issuing a
// server-side API call. The page carries the auth + CSRF; we only read what it
// pulls.
//
// FREE-TIER ONLY: no Sales Navigator. So the only facets available are
// title-keyword, current-company, geography, and connection-degree. Seniority
// ("manager or above") has no facet and is approximated upstream via
// titleKeywords. A Sales Navigator backend (real seniority/function facets via
// salesApiPeopleSearch) is a separate implementation behind this same port; do
// not add it here.
//
// The exact Voyager facet grammar is the HIGH-RISK GUESS: it is isolated in
// buildVoyagerSearchUrl() and every guessed piece is marked `// GUESS: verify
// live`. See correcting-the-url-builder note at the bottom of this file.

import type {
  InterceptedResponse,
  PagePort,
} from '@loa/account-runner';
import type {
  ObservePort,
  PeopleQuery,
  PersonSearchResult,
  ProfileSummary,
  PostSummary,
  EngagerSummary,
  JobSummary,
  ConversationSummary,
} from '@loa/mcp';

/** The substring that identifies the search XHR among all page responses. */
const SEARCH_RESPONSE_MARKER = 'voyagerSearchDashClusters';

/** Flagship caps free-tier search at ~1000 results; never page past it. */
const FLAGSHIP_RESULT_CAP = 1000;

/** Results per page in the Voyager cluster response. */
const PAGE_SIZE = 10;

/** How the page is obtained for an account (a thin slice of SessionProvider). */
export interface PageProvider {
  pageFor(accountId: string): Promise<PagePort>;
}

/**
 * Per-account search budget. Reads are deliberately kept OUT of the act/executor
 * budget (ACTION_TYPES), so this is a separate counter. The default impl is an
 * in-memory daily counter; swap in a store-backed one at compose time to persist
 * across restarts. `charge` throws when the cap is hit so a search stops early.
 */
export interface SearchBudget {
  charge(accountId: string): void;
}

/** In-memory daily search counter. One search = one charge (not per page). */
export class InMemorySearchBudget implements SearchBudget {
  private day = todayIso();
  private readonly used = new Map<string, number>();
  constructor(private readonly dailyCap = 60) {}

  charge(accountId: string): void {
    const today = todayIso();
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
    const n = this.used.get(accountId) ?? 0;
    if (n >= this.dailyCap) {
      throw new Error(
        `daily search budget exhausted for account ${accountId} (${n}/${this.dailyCap})`,
      );
    }
    this.used.set(accountId, n + 1);
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// URL builder — the ONE place that encodes the Voyager facet grammar.
// ---------------------------------------------------------------------------

/**
 * Build the flagship people-search URL for a given page offset.
 *
 * Stable, low-risk parts (LinkedIn facts, not Linki's to license):
 *   - origin + path: https://www.linkedin.com/search/results/people/
 *   - keywords: standard URL query param
 *   - the page renders results by fetching voyagerSearchDashClusters, which is
 *     what we intercept; the human-visible URL just drives that fetch.
 *
 * HIGH-RISK GUESS: the `filters` grammar. Flagship encodes facets as a single
 * `filters` query param whose value is a comma-separated list of
 * `key->List(v1|v2)` entries. The exact key names and value formats below are
 * best-effort and MUST be verified against one real captured request.
 */
export function buildVoyagerSearchUrl(query: PeopleQuery, start: number): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  const params = url.searchParams;

  if (query.keywords && query.keywords.trim()) {
    params.set('keywords', query.keywords.trim());
  }

  // Flagship people search paginates by `page` (1-based), not a raw start
  // offset, on the human URL. // GUESS: verify live — some flows use `start`.
  const page = Math.floor(start / PAGE_SIZE) + 1;
  if (page > 1) params.set('page', String(page));

  // origin=FACETED_SEARCH tells LinkedIn the filters below were applied
  // deliberately (vs a typed query). // GUESS: verify live.
  params.set('origin', 'FACETED_SEARCH');

  const filters: string[] = [];

  // title keyword facet. // GUESS: verify live — key may be `title` or
  // `titleFreeText`; free-tier likely wants a free-text title, so values are
  // raw strings joined by `|`.
  if (query.titleKeywords?.length) {
    filters.push(`title->${listValue(query.titleKeywords)}`);
  }

  // current-company facet by NAME (free-text). // GUESS: verify live — key may
  // be `currentCompany` (expects company ids) vs a free-text variant.
  if (query.companyKeywords?.length) {
    filters.push(`company->${listValue(query.companyKeywords)}`);
  }

  // current-company facet by company entity id. // GUESS: verify live — the
  // canonical key is `currentCompany` and values are bare numeric ids.
  if (query.companyUrns?.length) {
    filters.push(`currentCompany->${listValue(query.companyUrns)}`);
  }

  // geography facet. // GUESS: verify live — key `geoUrn`, value is the bare
  // geo id (e.g. 103644278), NOT the full urn:li:geo:... string.
  if (query.geoUrn) {
    filters.push(`geoUrn->${listValue([query.geoUrn])}`);
  }

  // connection-degree facet. F/S/O are LinkedIn's own network-distance codes
  // and are stable; the `network` key name is the // GUESS: verify live part.
  if (query.network?.length) {
    filters.push(`network->${listValue(query.network)}`);
  }

  if (filters.length) {
    // The filters param uses `->` between key and its List, and `,` between
    // facets; the List uses `|` between values. LinkedIn leaves `(`, `)`, `,`
    // unencoded and encodes only `:` inside urns. URL/searchParams will encode
    // for us here; a live capture will show whether raw punctuation is needed.
    // GUESS: verify live — the exact separator set.
    params.set('filters', filters.join(','));
  }

  return url.toString();
}

/** Encode one facet's values as LinkedIn's `List(a|b|c)` grammar. */
function listValue(values: readonly string[]): string {
  // GUESS: verify live — the `List(...)` wrapper and `|` joiner.
  return `List(${values.join('|')})`;
}

// ---------------------------------------------------------------------------
// LiveObserve
// ---------------------------------------------------------------------------

export class LiveObserve implements ObservePort {
  constructor(
    private readonly pages: PageProvider,
    private readonly budget: SearchBudget,
  ) {}

  async searchPeople(
    accountId: string,
    query: PeopleQuery,
    limit: number,
  ): Promise<PersonSearchResult[]> {
    this.budget.charge(accountId);

    const page = await this.pages.pageFor(accountId);
    const target = Math.min(query.limit ?? limit, limit, FLAGSHIP_RESULT_CAP);

    const seen = new Set<string>();
    const results: PersonSearchResult[] = [];

    for (let start = 0; start < target; start += PAGE_SIZE) {
      const url = buildVoyagerSearchUrl(query, start);

      // Arm the interceptor BEFORE navigating so we catch the search XHR the
      // page fires on load. Race the waiter against the navigation.
      const waitForSearch = page.waitForResponse(SEARCH_RESPONSE_MARKER, {
        timeoutMs: 20_000,
      });
      const [res] = await Promise.all([
        waitForSearch,
        page.goto(url, { waitUntil: 'domcontentloaded' }),
      ]);

      const items = await parseClusters(res);
      if (items.length === 0) break; // no more results; stop paginating.

      let added = 0;
      for (const item of items) {
        if (seen.has(item.entityUrn)) continue; // dedup across pages.
        seen.add(item.entityUrn);
        results.push(item);
        added += 1;
        if (results.length >= target) break;
      }
      if (results.length >= target) break;
      if (added === 0) break; // a full page of dupes means we have looped.

      // Human settle between pages.
      await page.waitForTimeout(1500);
    }

    return results.slice(0, target);
  }

  // -------------------------------------------------------------------------
  // The other Observe reads are not implemented by this live backend yet; they
  // stay on FakeObserve at compose time. Provide throwing stubs so the class
  // still satisfies ObservePort without silently returning fake data.
  // -------------------------------------------------------------------------

  getProfile(): Promise<ProfileSummary> {
    return notLive('getProfile');
  }
  getRecentPosts(): Promise<PostSummary[]> {
    return notLive('getRecentPosts');
  }
  getPostEngagers(): Promise<EngagerSummary[]> {
    return notLive('getPostEngagers');
  }
  getCompanyJobs(): Promise<JobSummary[]> {
    return notLive('getCompanyJobs');
  }
  getConversation(): Promise<ConversationSummary> {
    return notLive('getConversation');
  }
}

function notLive(method: string): Promise<never> {
  return Promise.reject(
    new Error(`LiveObserve.${method} is not implemented; use FakeObserve for it`),
  );
}

// ---------------------------------------------------------------------------
// Response normalization — voyagerSearchDashClusters -> PersonSearchResult[].
// ---------------------------------------------------------------------------

/**
 * The cluster response nests result cards under
 * data.searchDashClustersByAll.elements[].items[].item.entityResult.
 * Each entityResult carries the person's urn, name, headline, degree and the
 * navigation URL to the profile. Field names below match the flagship shape;
 * they are stable-ish but // GUESS: verify live where noted.
 */
async function parseClusters(res: InterceptedResponse): Promise<PersonSearchResult[]> {
  if (res.status !== 200) return [];
  const body = (await res.json()) as VoyagerSearchResponse | undefined;
  const clusters = body?.data?.searchDashClustersByAll?.elements ?? [];

  const out: PersonSearchResult[] = [];
  for (const cluster of clusters) {
    for (const wrapper of cluster.items ?? []) {
      const er = wrapper.item?.entityResult;
      if (!er) continue; // non-person cards (people-also-viewed, etc.)
      const normalized = normalizeEntityResult(er);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

function normalizeEntityResult(er: EntityResult): PersonSearchResult | null {
  const entityUrn = er.entityUrn ?? er.trackingUrn;
  if (!entityUrn) return null;

  const navUrl = er.navigationUrl ?? '';
  const publicId = publicIdFromUrl(navUrl);
  const profileUrl = navUrl
    ? (navUrl.split('?')[0] ?? navUrl)
    : publicId
      ? `https://www.linkedin.com/in/${publicId}/`
      : '';

  return {
    entityUrn,
    linkedinUrn: entityUrn,
    ...(publicId ? { publicId } : {}),
    name: textOf(er.title),
    headline: textOf(er.primarySubtitle),
    profileUrl,
    degree: er.entityCustomTrackingInfo?.memberDistance ?? er.badgeText?.text,
    location: textOf(er.secondarySubtitle),
    // free-tier entityResult does not reliably split out current company; it is
    // usually embedded in the headline. // GUESS: verify live.
    currentCompany: undefined,
  };
}

/** Voyager text nodes are { text: string } (sometimes with attributes). */
function textOf(node: TextNode | undefined): string | undefined {
  return node?.text?.trim() || undefined;
}

/** Pull the /in/{publicId} slug out of a navigation URL. */
function publicIdFromUrl(url: string): string | undefined {
  const m = url.match(/\/in\/([^/?]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Minimal structural types for the slice of the response we read. Everything is
// optional because the payload is large and versioned; we defensively read.
// ---------------------------------------------------------------------------

interface VoyagerSearchResponse {
  data?: {
    searchDashClustersByAll?: {
      elements?: SearchCluster[];
    };
  };
}

interface SearchCluster {
  items?: Array<{ item?: { entityResult?: EntityResult } }>;
}

interface TextNode {
  text?: string;
}

interface EntityResult {
  entityUrn?: string;
  trackingUrn?: string;
  navigationUrl?: string;
  title?: TextNode;
  primarySubtitle?: TextNode;
  secondarySubtitle?: TextNode;
  badgeText?: TextNode;
  entityCustomTrackingInfo?: { memberDistance?: string };
}

// ---------------------------------------------------------------------------
// CORRECTING THE URL BUILDER FROM ONE CAPTURED REQUEST
// ---------------------------------------------------------------------------
// 1. Log into the account, open DevTools -> Network, filter for
//    "voyagerSearchDashClusters".
// 2. Apply title + company + geo + connection-degree filters in the UI.
// 3. Copy the request URL. Read off:
//    - the exact `filters` param value (key names, `->` vs `:`, `List(...)`,
//      the value/joiner punctuation, and which chars are URL-encoded),
//    - whether pagination uses `page` or a raw `start`/`count`,
//    - the real geo value format (bare id vs urn).
// 4. Fix listValue() + the filter keys + the pagination line in
//    buildVoyagerSearchUrl(); leave everything else untouched. The intercept,
//    pagination loop, and normalization do not depend on the guessed encoding.
