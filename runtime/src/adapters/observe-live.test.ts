import { describe, it, expect } from 'vitest';
import type {
  InterceptedResponse,
  LocatorPort,
  PagePort,
} from '@loa/account-runner';
import type { PeopleQuery } from '@loa/mcp';
import {
  buildVoyagerSearchUrl,
  buildVoyagerGraphqlPath,
  normalizeSearchResponse,
  LiveObserve,
  InMemorySearchBudget,
  type SearchBudget,
} from './observe-live.js';

// ---------------------------------------------------------------------------
// A local FakePage: the account-runner FakePage is not exported past its index,
// so the runtime test carries its own minimal page that returns canned search
// bodies from the direct voyagerGet call. Each call pops the next payload.
// ---------------------------------------------------------------------------

class SearchFakePage implements PagePort {
  /** The origin-relative voyager paths requested, in order. */
  readonly calls: string[] = [];
  private readonly queue: unknown[];

  constructor(pages: unknown[]) {
    this.queue = [...pages];
  }

  async goto(): Promise<unknown> {
    return null;
  }

  async voyagerGet(pathWithQuery: string): Promise<{ status: number; body: unknown }> {
    this.calls.push(pathWithQuery);
    // The last payload is reused if the loop over-asks; the loop stops itself
    // when a page yields no new items.
    const body = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return { status: 200, body };
  }

  async waitForResponse(): Promise<InterceptedResponse> {
    throw new Error('not used');
  }
  locator(): LocatorPort {
    throw new Error('not used');
  }
  // Already on the LinkedIn origin, so searchPeople skips the ensure-nav goto.
  url(): string {
    return 'https://www.linkedin.com/feed/';
  }
  async waitForTimeout(): Promise<void> {}
}

/** Build a trimmed but realistic voyagerSearchDashClusters payload. */
function clusterPayload(
  people: Array<{ id: string; name: string; slug: string; headline: string; degree: string }>,
) {
  return {
    data: {
      searchDashClustersByAll: {
        elements: [
          {
            items: people.map((p) => ({
              item: {
                entityResult: {
                  entityUrn: `urn:li:fsd_entityResult:${p.id}`,
                  trackingUrn: `urn:li:member:${p.id}`,
                  navigationUrl: `https://www.linkedin.com/in/${p.slug}?miniProfileUrn=x`,
                  title: { text: p.name },
                  primarySubtitle: { text: p.headline },
                  secondarySubtitle: { text: 'San Francisco Bay Area' },
                  entityCustomTrackingInfo: { memberDistance: p.degree },
                },
              },
            })),
          },
        ],
      },
    },
  };
}

const alice = { id: 'a1', name: 'Alice Ng', slug: 'alice-ng', headline: 'Head of Eng at Acme', degree: 'DISTANCE_2' };
const bob = { id: 'b2', name: 'Bob Lee', slug: 'bob-lee', headline: 'Senior Manager at Acme', degree: 'DISTANCE_2' };

function observeWith(page: PagePort, budget: SearchBudget = new InMemorySearchBudget()) {
  return new LiveObserve({ pageFor: async () => page }, budget);
}

describe('buildVoyagerSearchUrl (stable parts)', () => {
  it('sets origin, path, and keywords; no page param on the first page', () => {
    const q: PeopleQuery = { keywords: 'growth marketer' };
    const url = new URL(buildVoyagerSearchUrl(q, 0));
    expect(url.origin).toBe('https://www.linkedin.com');
    expect(url.pathname).toBe('/search/results/people/');
    expect(url.searchParams.get('keywords')).toBe('growth marketer');
    // A plain keyword search (no facets) uses the vertical-switch origin.
    expect(url.searchParams.get('origin')).toBe('SWITCH_SEARCH_VERTICAL');
    expect(url.searchParams.get('page')).toBeNull();
  });

  it('advances the page param by PAGE_SIZE offsets', () => {
    const q: PeopleQuery = { keywords: 'x' };
    expect(new URL(buildVoyagerSearchUrl(q, 10)).searchParams.get('page')).toBe('2');
    expect(new URL(buildVoyagerSearchUrl(q, 30)).searchParams.get('page')).toBe('4');
  });

  // Facet encoding, verified against real captured page URLs (2026-07-06):
  // each facet is its own JSON-array param; title/company free-text fold into
  // the keyword box (no free-tier facet for those).
  it('encodes each facet as its own JSON-array param', () => {
    const q: PeopleQuery = {
      keywords: 'ev charging operations lead',
      titleKeywords: ['manager', 'director'],
      companyKeywords: ['Acme'],
      companyUrns: ['439853', '2685826'],
      geoUrn: '103644278',
      network: ['S', 'O'],
    };
    const params = new URL(buildVoyagerSearchUrl(q, 0)).searchParams;
    expect(params.get('keywords')).toBe('ev charging operations lead manager director Acme');
    expect(params.get('origin')).toBe('FACETED_SEARCH');
    expect(params.get('network')).toBe('["S","O"]');
    expect(params.get('geoUrn')).toBe('["103644278"]');
    expect(params.get('currentCompany')).toBe('["439853","2685826"]');
    // The old single `filters` param no longer exists.
    expect(params.get('filters')).toBeNull();
  });
});

describe('buildVoyagerGraphqlPath (direct API request)', () => {
  it('emits the SEARCH_SRP people-results grammar with parens left literal', () => {
    const path = buildVoyagerGraphqlPath({ keywords: 'growth marketer' }, 0, 10);
    expect(path.startsWith('/voyager/api/graphql?variables=(')).toBe(true);
    expect(path).toContain('flagshipSearchIntent:SEARCH_SRP');
    expect(path).toContain('queryParameters:List((key:resultType,value:List(PEOPLE)))');
    // keywords VALUE is escaped (space -> %20); the grammar is not.
    expect(path).toContain('keywords:growth%20marketer,');
    expect(path).toContain('count:10)');
    expect(path).toContain('&queryId=voyagerSearchDashClusters.');
  });

  it('encodes facets as queryParameters tuples and offsets by start', () => {
    const path = buildVoyagerGraphqlPath(
      { keywords: 'x', companyUrns: ['439853', '2685826'], geoUrn: '103644278', network: ['S', 'O'] },
      20,
      10,
    );
    expect(path).toContain('(key:currentCompany,value:List(439853,2685826))');
    expect(path).toContain('(key:geoUrn,value:List(103644278))');
    expect(path).toContain('(key:network,value:List(S,O))');
    expect(path).toContain('start:20,');
  });

  it('folds title/company keywords into the keyword value', () => {
    const path = buildVoyagerGraphqlPath(
      { keywords: 'ops', titleKeywords: ['manager'], companyKeywords: ['Acme'] },
      0,
      10,
    );
    expect(path).toContain('keywords:ops%20manager%20Acme,');
  });
});

describe('normalizeSearchResponse (response shapes)', () => {
  it('reads the double-nested data.data envelope', () => {
    const single = clusterPayload([alice]); // { data: { searchDashClustersByAll } }
    const doubled = { data: { data: (single as { data: unknown }).data } };
    const people = normalizeSearchResponse(doubled);
    expect(people.map((p) => p.name)).toEqual(['Alice Ng']);
  });

  it('drops non-person cards a cluster mixes in', () => {
    const payload = {
      data: {
        searchDashClustersByAll: {
          elements: [
            {
              items: [
                // a company/promo card: no fsd_profile / :member: urn
                { item: { entityResult: { entityUrn: 'urn:li:fsd_company:123', title: { text: 'Acme Inc' } } } },
                {
                  item: {
                    entityResult: {
                      entityUrn: 'urn:li:fsd_entityResult:(urn:li:fsd_profile:xyz)',
                      trackingUrn: 'urn:li:member:99',
                      navigationUrl: 'https://www.linkedin.com/in/real-person?x=1',
                      title: { text: 'Real Person' },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const people = normalizeSearchResponse(payload);
    expect(people.map((p) => p.name)).toEqual(['Real Person']);
  });
});

describe('LiveObserve.searchPeople', () => {
  it('normalizes cluster items to PersonSearchResult', async () => {
    const page = new SearchFakePage([clusterPayload([alice])]);
    const results = await observeWith(page).searchPeople('acct', { keywords: 'x' }, 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      entityUrn: 'urn:li:fsd_entityResult:a1',
      linkedinUrn: 'urn:li:fsd_entityResult:a1',
      publicId: 'alice-ng',
      name: 'Alice Ng',
      headline: 'Head of Eng at Acme',
      profileUrl: 'https://www.linkedin.com/in/alice-ng',
      degree: 'DISTANCE_2',
      location: 'San Francisco Bay Area',
    });
  });

  it('paginates and dedups across pages by entityUrn', async () => {
    // page 1: [alice, bob]; page 2: [bob, alice] (all dupes) -> loop stops.
    const page = new SearchFakePage([
      clusterPayload([alice, bob]),
      clusterPayload([bob, alice]),
    ]);
    const results = await observeWith(page).searchPeople('acct', { keywords: 'x' }, 100);
    expect(results.map((r) => r.entityUrn)).toEqual([
      'urn:li:fsd_entityResult:a1',
      'urn:li:fsd_entityResult:b2',
    ]);
    // second page was fetched (pagination happened) but added nothing new.
    expect(page.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops paginating on an empty page', async () => {
    const page = new SearchFakePage([clusterPayload([alice]), clusterPayload([])]);
    const results = await observeWith(page).searchPeople('acct', { keywords: 'x' }, 100);
    expect(results).toHaveLength(1);
  });

  it('respects the requested limit', async () => {
    const page = new SearchFakePage([clusterPayload([alice, bob])]);
    const results = await observeWith(page).searchPeople('acct', { keywords: 'x' }, 1);
    expect(results).toHaveLength(1);
  });

  it('charges the search budget and refuses when exhausted', async () => {
    const page = new SearchFakePage([clusterPayload([alice])]);
    const budget = new InMemorySearchBudget(1);
    const observe = observeWith(page, budget);
    await observe.searchPeople('acct', { keywords: 'x' }, 5);
    await expect(observe.searchPeople('acct', { keywords: 'x' }, 5)).rejects.toThrow(
      /search budget exhausted/,
    );
  });
});
