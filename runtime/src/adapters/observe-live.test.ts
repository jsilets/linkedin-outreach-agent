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
  collectGeoUrns,
  DEFAULT_GEO_URNS,
  normalizeSearchResponse,
  normalizeInboxResponse,
  normalizeConnectionsResponse,
  profileUrnFromEntityUrn,
  ensureOnLinkedIn,
  LiveInboxReader,
  LiveConnectionsReader,
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
    // No geo is specified, so the default US+Canada geo facet applies, which
    // counts as a faceted search.
    expect(url.searchParams.get('origin')).toBe('FACETED_SEARCH');
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

  it('serializes multiple geoUrns into one geoUrn facet param', () => {
    const q: PeopleQuery = { keywords: 'ops', geoUrns: ['103644278', '101174742'] };
    const params = new URL(buildVoyagerSearchUrl(q, 0)).searchParams;
    // US + Canada in a single pass, mirroring currentCompany's JSON array.
    expect(params.get('geoUrn')).toBe('["103644278","101174742"]');
    expect(params.get('origin')).toBe('FACETED_SEARCH');
  });

  it('merges the legacy single geoUrn with geoUrns (deduped)', () => {
    const q: PeopleQuery = { keywords: 'ops', geoUrn: '103644278', geoUrns: ['103644278', '101174742'] };
    const params = new URL(buildVoyagerSearchUrl(q, 0)).searchParams;
    expect(params.get('geoUrn')).toBe('["103644278","101174742"]');
  });
});

describe('collectGeoUrns (default geography)', () => {
  it('defaults to US + Canada when no geo is specified', () => {
    expect(collectGeoUrns({ keywords: 'ops' })).toEqual(['103644278', '101174742']);
    expect(collectGeoUrns({ keywords: 'ops' })).toEqual([...DEFAULT_GEO_URNS]);
  });

  it('also defaults when geoUrns is present but empty', () => {
    expect(collectGeoUrns({ keywords: 'ops', geoUrns: [] })).toEqual([...DEFAULT_GEO_URNS]);
  });

  it('passes an explicit single geoUrn through unchanged (no default)', () => {
    expect(collectGeoUrns({ keywords: 'ops', geoUrn: '90000084' })).toEqual(['90000084']);
  });

  it('passes explicit geoUrns through unchanged (no default)', () => {
    expect(collectGeoUrns({ keywords: 'ops', geoUrns: ['90000084', '102890719'] })).toEqual([
      '90000084',
      '102890719',
    ]);
  });
});

describe('default geography flows into the built requests', () => {
  it('graphql path carries the US+Canada geo tuple when no geo is given', () => {
    const path = buildVoyagerGraphqlPath({ keywords: 'growth marketer' }, 0, 10);
    expect(path).toContain('(key:geoUrn,value:List(103644278,101174742))');
  });

  it('search url carries the US+Canada geo facet when no geo is given', () => {
    const params = new URL(buildVoyagerSearchUrl({ keywords: 'growth marketer' }, 0)).searchParams;
    expect(params.get('geoUrn')).toBe('["103644278","101174742"]');
  });

  it('an explicit geo is not overridden by the default', () => {
    const path = buildVoyagerGraphqlPath({ keywords: 'x', geoUrn: '90000084' }, 0, 10);
    expect(path).toContain('(key:geoUrn,value:List(90000084))');
    expect(path).not.toContain('103644278');
    expect(path).not.toContain('101174742');
  });
});

describe('buildVoyagerGraphqlPath (direct API request)', () => {
  it('emits the SEARCH_SRP people-results grammar with parens left literal', () => {
    const path = buildVoyagerGraphqlPath({ keywords: 'growth marketer' }, 0, 10);
    expect(path.startsWith('/voyager/api/graphql?variables=(')).toBe(true);
    expect(path).toContain('flagshipSearchIntent:SEARCH_SRP');
    expect(path).toContain('(key:resultType,value:List(PEOPLE))');
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

  it('joins multiple geoUrns into one geoUrn queryParameters tuple', () => {
    const path = buildVoyagerGraphqlPath(
      { keywords: 'ops', geoUrns: ['103644278', '101174742'] },
      0,
      10,
    );
    // One tuple, comma-joined like currentCompany, so a single search spans
    // US + Canada.
    expect(path).toContain('(key:geoUrn,value:List(103644278,101174742))');
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

  it('sets linkedinUrn to the stable inner profile urn, not the search wrapper', () => {
    // Shape seen live: entityUrn wraps the profile urn + search context.
    const wrapped = 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAF123,SEARCH_SRP,DEFAULT)';
    const payload = {
      data: {
        searchDashClustersByAll: {
          elements: [
            {
              items: [
                {
                  item: {
                    entityResult: {
                      entityUrn: wrapped,
                      navigationUrl: 'https://www.linkedin.com/in/jc-ev',
                      title: { text: 'John Collier' },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const [person] = normalizeSearchResponse(payload);
    expect(person?.linkedinUrn).toBe('urn:li:fsd_profile:ACoAAF123');
    expect(person?.entityUrn).toBe(wrapped);
  });
});

describe('ensureOnLinkedIn (origin navigation resilience)', () => {
  // Minimal page fake: goto throws for the first `failures` calls, then succeeds.
  // waitForTimeout is a no-op so the backoff does not slow the test.
  function fakePage(failures: number, err = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE') {
    let gotos = 0;
    let onLinkedIn = false;
    return {
      gotos: () => gotos,
      url: () => (onLinkedIn ? 'https://www.linkedin.com/feed/' : 'about:blank'),
      goto: async () => {
        gotos += 1;
        if (gotos <= failures) throw new Error(err);
        onLinkedIn = true;
        return undefined;
      },
      waitForTimeout: async () => {},
    } as unknown as PagePort & { gotos: () => number };
  }

  it('skips navigation when already on the LinkedIn origin', async () => {
    const page = { url: () => 'https://www.linkedin.com/feed/' } as unknown as PagePort;
    await expect(ensureOnLinkedIn(page)).resolves.toBeUndefined();
  });

  it('recovers when a transient failure clears on retry', async () => {
    const page = fakePage(2) as PagePort & { gotos: () => number };
    await expect(ensureOnLinkedIn(page)).resolves.toBeUndefined();
    expect(page.gotos()).toBe(3); // two throws, third succeeds
  });

  it('throws an actionable error (not the raw driver error) after persistent failure', async () => {
    const page = fakePage(99) as PagePort & { gotos: () => number };
    await expect(ensureOnLinkedIn(page, 3)).rejects.toThrow(/rate-limited or challenged/i);
    expect(page.gotos()).toBe(3);
  });
});

describe('profileUrnFromEntityUrn', () => {
  it('extracts the profile urn from a wrapped entityUrn', () => {
    expect(
      profileUrnFromEntityUrn('urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAF123,SEARCH_SRP,DEFAULT)'),
    ).toBe('urn:li:fsd_profile:ACoAAF123');
  });

  it('returns undefined when no profile urn is present', () => {
    expect(profileUrnFromEntityUrn('urn:li:fsd_company:123')).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Inbox reader — messaging conversations -> InboundMessage[].
// ---------------------------------------------------------------------------

/** A trimmed but realistic messaging conversations payload. */
function inboxPayload(
  events: Array<{
    thread: string;
    sender: string;
    publicId?: string;
    text: string;
    at: number;
    outbound?: boolean;
  }>,
) {
  return {
    elements: events.map((e) => ({
      entityUrn: `urn:li:msg_conversation:${e.thread}`,
      events: [
        {
          deliveredAt: e.at,
          ...(e.outbound ? { outbound: true } : {}),
          from: {
            miniProfile: {
              entityUrn: `urn:li:fsd_profile:${e.sender}`,
              ...(e.publicId ? { publicIdentifier: e.publicId } : {}),
            },
          },
          eventContent: { attributedBody: { text: e.text } },
        },
      ],
    })),
  };
}

describe('normalizeInboxResponse (messaging shapes)', () => {
  it('reads thread urn, sender urn, profile url, text, and receivedAt', () => {
    const body = inboxPayload([
      { thread: 't1', sender: 'p1', publicId: 'alice-ng', text: 'happy to chat', at: 1_700_000_000_000 },
    ]);
    const msgs = normalizeInboxResponse(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      threadUrn: 'urn:li:msg_conversation:t1',
      senderUrn: 'urn:li:fsd_profile:p1',
      profileUrl: 'https://www.linkedin.com/in/alice-ng/',
      text: 'happy to chat',
    });
    expect(msgs[0]!.receivedAt.getTime()).toBe(1_700_000_000_000);
  });

  it('drops the account\'s own outbound events', () => {
    const body = inboxPayload([
      { thread: 't1', sender: 'me', text: 'my earlier note', at: 1, outbound: true },
      { thread: 't1', sender: 'p1', text: 'their reply', at: 2 },
    ]);
    expect(normalizeInboxResponse(body).map((m) => m.text)).toEqual(['their reply']);
  });

  it('sorts most-recent-first and skips empty-text events', () => {
    const body = inboxPayload([
      { thread: 't1', sender: 'p1', text: 'older', at: 10 },
      { thread: 't2', sender: 'p2', text: '', at: 30 }, // non-text event: dropped
      { thread: 't3', sender: 'p3', text: 'newer', at: 20 },
    ]);
    expect(normalizeInboxResponse(body).map((m) => m.text)).toEqual(['newer', 'older']);
  });
});

describe('LiveInboxReader.readInbox', () => {
  it('drives voyagerGet and normalizes the messaging payload', async () => {
    const page = new SearchFakePage([
      inboxPayload([{ thread: 't1', sender: 'p1', text: 'yes', at: 5 }]),
    ]);
    const reader = new LiveInboxReader({ pageFor: async () => page });
    const msgs = await reader.readInbox('acct', 20);
    expect(msgs.map((m) => m.text)).toEqual(['yes']);
    // It hit the messaging conversations endpoint.
    expect(page.calls[0]).toContain('/voyager/api/messaging/conversations');
  });
});

// ---------------------------------------------------------------------------
// Connections reader — relationships connections -> AcceptedConnection[].
// ---------------------------------------------------------------------------

/** A trimmed but realistic relationships connections payload. */
function connectionsPayload(
  people: Array<{ urn: string; publicId?: string; at?: number }>,
) {
  return {
    elements: people.map((p) => ({
      ...(p.at !== undefined ? { createdAt: p.at } : {}),
      miniProfile: {
        entityUrn: `urn:li:fsd_profile:${p.urn}`,
        ...(p.publicId ? { publicIdentifier: p.publicId } : {}),
      },
    })),
  };
}

/**
 * A trimmed but REAL-shaped normalized dash connections payload, sanitized from a
 * live capture (2026-07-10). The live endpoint
 * /voyager/api/relationships/dash/connections?decorationId=…ConnectionListWithProfile-16
 * returns `data.*elements` (RECENTLY_ADDED order) + an `included[]` of Connection
 * stubs and their resolved Profiles. No cookies/tokens are present. Ids are fake.
 */
function dashConnectionsPayload(
  people: Array<{ id: string; publicId: string; first: string; last: string; headline: string; at: number }>,
) {
  const connUrn = (id: string) => `urn:li:fsd_connection:${id}`;
  const profUrn = (id: string) => `urn:li:fsd_profile:${id}`;
  const connections = people.map((p) => ({
    $type: 'com.linkedin.voyager.dash.relationships.Connection',
    createdAt: p.at,
    connectedMember: profUrn(p.id),
    entityUrn: connUrn(p.id),
    '*connectedMemberResolutionResult': profUrn(p.id),
  }));
  const profiles = people.map((p) => ({
    $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
    entityUrn: profUrn(p.id),
    publicIdentifier: p.publicId,
    firstName: p.first,
    lastName: p.last,
    headline: p.headline,
  }));
  return {
    data: {
      $type: 'com.linkedin.restli.common.CollectionResponse',
      '*elements': people.map((p) => connUrn(p.id)),
      paging: { count: people.length, start: 0, links: [] },
    },
    included: [...connections, ...profiles],
  };
}

describe('normalizeConnectionsResponse (modern dash shape)', () => {
  it('resolves Connection stubs against included[] Profiles', () => {
    const body = dashConnectionsPayload([
      {
        id: 'AAA',
        publicId: 'daniel-fanavoll',
        first: 'Daniel',
        last: 'Fanavoll',
        headline: 'Head of Ops',
        at: 1_783_697_318_000,
      },
    ]);
    const conns = normalizeConnectionsResponse(body);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      entityUrn: 'urn:li:fsd_profile:AAA',
      profileUrl: 'https://www.linkedin.com/in/daniel-fanavoll/',
      name: 'Daniel Fanavoll',
      headline: 'Head of Ops',
    });
    expect(conns[0]!.connectedAt?.getTime()).toBe(1_783_697_318_000);
  });

  it('keeps most-recent-first order and populates names + headlines', () => {
    const body = dashConnectionsPayload([
      { id: 'NEW', publicId: 'ann-new', first: 'Ann', last: 'New', headline: 'CTO', at: 30 },
      { id: 'OLD', publicId: 'bob-old', first: 'Bob', last: 'Old', headline: 'CEO', at: 10 },
      { id: 'MID', publicId: 'cid-mid', first: 'Cid', last: 'Mid', headline: 'CFO', at: 20 },
    ]);
    const conns = normalizeConnectionsResponse(body);
    expect(conns.map((c) => c.entityUrn)).toEqual([
      'urn:li:fsd_profile:NEW',
      'urn:li:fsd_profile:MID',
      'urn:li:fsd_profile:OLD',
    ]);
    expect(conns.map((c) => c.name)).toEqual(['Ann New', 'Cid Mid', 'Bob Old']);
  });
});

describe('normalizeConnectionsResponse (legacy relationships shapes)', () => {
  it('reads entity urn, profile url, and connectedAt', () => {
    const body = connectionsPayload([{ urn: 'p1', publicId: 'alice-ng', at: 1_700_000_000_000 }]);
    const conns = normalizeConnectionsResponse(body);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      entityUrn: 'urn:li:fsd_profile:p1',
      profileUrl: 'https://www.linkedin.com/in/alice-ng/',
    });
    expect(conns[0]!.connectedAt?.getTime()).toBe(1_700_000_000_000);
  });

  it('sorts most-recent-first and drops entries without a urn', () => {
    const body = {
      elements: [
        { createdAt: 10, miniProfile: { entityUrn: 'urn:li:fsd_profile:older' } },
        { createdAt: 30, miniProfile: {} }, // no urn: dropped
        { createdAt: 20, miniProfile: { entityUrn: 'urn:li:fsd_profile:newer' } },
      ],
    };
    expect(normalizeConnectionsResponse(body).map((c) => c.entityUrn)).toEqual([
      'urn:li:fsd_profile:newer',
      'urn:li:fsd_profile:older',
    ]);
  });
});

describe('LiveConnectionsReader.readConnections', () => {
  it('drives voyagerGet and normalizes the dash connections payload', async () => {
    const page = new SearchFakePage([
      dashConnectionsPayload([
        { id: 'p1', publicId: 'p-one', first: 'P', last: 'One', headline: 'Eng', at: 5 },
      ]),
    ]);
    const reader = new LiveConnectionsReader({ pageFor: async () => page });
    const conns = await reader.readConnections('acct', 40);
    expect(conns.map((c) => c.entityUrn)).toEqual(['urn:li:fsd_profile:p1']);
    // It hit the modern dash relationships connections endpoint with the decoration.
    expect(page.calls[0]).toContain('/voyager/api/relationships/dash/connections');
    expect(page.calls[0]).toContain('ConnectionListWithProfile');
  });
});
