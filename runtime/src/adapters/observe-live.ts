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
// The facet encoding is isolated in buildVoyagerSearchUrl() and was verified
// against real captured page URLs on 2026-07-06.

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
 * Build the flagship people-search page URL for a given page offset. We navigate
 * the real logged-in browser here; the page's own client JS then fires the
 * voyagerSearchDashClusters request we intercept.
 *
 * Encoding verified against captured page URLs (2026-07-06). Free-tier flagship
 * search exposes structured facets as SEPARATE query params, each a JSON array
 * of quoted strings:
 *   keywords=ev charging operations lead
 *   origin=FACETED_SEARCH
 *   network=["S","O"]            (connection degree: F=1st, S=2nd, O=3rd+)
 *   geoUrn=["103644278"]         (bare geo id, not the full urn)
 *   currentCompany=["439853"]    (bare company entity ids)
 * There is NO free-text title/company facet on free tier; title and company
 * keywords fold into the keyword box.
 */
export function buildVoyagerSearchUrl(query: PeopleQuery, start: number): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  const params = url.searchParams;

  // Free tier has no title/company free-text FACET; both fold into keywords.
  const keywordParts = [
    query.keywords,
    ...(query.titleKeywords ?? []),
    ...(query.companyKeywords ?? []),
  ]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  if (keywordParts.length) params.set('keywords', keywordParts.join(' '));

  const hasFacets = !!query.geoUrn || !!query.companyUrns?.length || !!query.network?.length;
  // origin is LinkedIn's own entry-tracking token: FACETED_SEARCH when filters
  // are applied, SWITCH_SEARCH_VERTICAL for a plain keyword search.
  params.set('origin', hasFacets ? 'FACETED_SEARCH' : 'SWITCH_SEARCH_VERTICAL');

  // Each facet is its own JSON-array param. URLSearchParams percent-encodes the
  // brackets/quotes; LinkedIn's client decodes them back, exactly as the browser
  // does when a human clicks the filter, so either form is accepted.
  if (query.network?.length) params.set('network', JSON.stringify(query.network));
  if (query.geoUrn) params.set('geoUrn', JSON.stringify([query.geoUrn]));
  if (query.companyUrns?.length) params.set('currentCompany', JSON.stringify(query.companyUrns));

  // People search paginates by `page` (1-based).
  const page = Math.floor(start / PAGE_SIZE) + 1;
  if (page > 1) params.set('page', String(page));

  return url.toString();
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
// STILL TO VERIFY LIVE
// ---------------------------------------------------------------------------
// The page-URL facet encoding is verified. Two things still want a live run to
// confirm, because they depend on the intercepted RESPONSE, not the request URL:
//   - The people-search page can fire more than one voyagerSearchDashClusters
//     request (e.g. a MYNETWORK_CURATION_HUB one). waitForResponse takes the
//     first; if that is the wrong cluster, filter the waiter to the SRP response
//     (the one whose elements carry entityResult people cards).
//   - The exact entityResult field names in normalizeEntityResult (title /
//     primarySubtitle / navigationUrl / memberDistance) — stable-ish but worth
//     a glance against one real payload.
