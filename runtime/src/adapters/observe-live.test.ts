import { describe, it, expect } from 'vitest';
import type {
  InterceptedResponse,
  LocatorPort,
  PagePort,
} from '@loa/account-runner';
import type { ObservePort, PeopleQuery } from '@loa/mcp';
import {
  buildVoyagerSearchUrl,
  buildVoyagerGraphqlPath,
  collectGeoUrns,
  DEFAULT_GEO_URNS,
  normalizeSearchResponse,
  normalizeInboxResponse,
  normalizeConnectionsResponse,
  normalizeConversation,
  normalizeProfileResponse,
  profileIdFromUrn,
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
      keywords: 'field service operations lead',
      titleKeywords: ['manager', 'director'],
      companyKeywords: ['Acme'],
      companyUrns: ['439853', '2685826'],
      geoUrn: '103644278',
      network: ['S', 'O'],
    };
    const params = new URL(buildVoyagerSearchUrl(q, 0)).searchParams;
    expect(params.get('keywords')).toBe('field service operations lead manager director Acme');
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

// ---------------------------------------------------------------------------
// Profile reader — profileView -> ProfileSummary.
// ---------------------------------------------------------------------------

describe('profileIdFromUrn', () => {
  it('extracts the tail id from an fsd_profile urn', () => {
    expect(profileIdFromUrn('urn:li:fsd_profile:ACoAAF9')).toBe('ACoAAF9');
  });
  it('passes a bare id / public identifier through unchanged', () => {
    expect(profileIdFromUrn('dana-lopez')).toBe('dana-lopez');
  });
});

/** A trimmed voyagerIdentityDashProfileComponents (experience) payload: a flat
 * list of single positions. Mirrors the live shape the normalizer walks. */
function experiencePayload(
  positions: Array<{ title: string; subtitle: string; caption: string; location?: string }>,
) {
  return {
    data: {
      identityDashProfileComponentsBySectionType: {
        elements: [
          {
            components: {
              pagedListComponent: {
                components: {
                  elements: positions.map((p) => ({
                    components: {
                      entityComponent: {
                        titleV2: { text: { text: p.title } },
                        subtitle: { text: p.subtitle },
                        caption: { text: p.caption },
                        ...(p.location ? { metadata: { text: p.location } } : {}),
                      },
                    },
                  })),
                },
              },
            },
          },
        ],
      },
    },
  };
}

describe('normalizeProfileResponse', () => {
  it('reads the experience section into positions + current role/company', () => {
    const body = experiencePayload([
      { title: 'VP Engineering', subtitle: 'Acme Corp · Full-time', caption: 'Jan 2022 - Present · 2 yrs', location: 'San Francisco' },
      { title: 'Staff Engineer', subtitle: 'Globex · Full-time', caption: 'Jan 2018 - Dec 2021 · 4 yrs' },
    ]);
    const p = normalizeProfileResponse(body, 'urn:li:fsd_profile:ACoAAF9');
    expect(p).toMatchObject({
      linkedinUrn: 'urn:li:fsd_profile:ACoAAF9',
      handle: 'ACoAAF9',
      currentTitle: 'VP Engineering',
      currentCompany: 'Acme Corp',
      // headline is synthesized from the current role.
      headline: 'VP Engineering at Acme Corp',
    });
    expect(p.positions).toHaveLength(2);
    expect(p.positions![0]).toMatchObject({
      title: 'VP Engineering',
      company: 'Acme Corp',
      location: 'San Francisco',
      current: true,
    });
    expect(p.positions![1]).toMatchObject({ title: 'Staff Engineer', company: 'Globex', current: false });
    // raw carries the data slice for callers wanting more than the summary.
    expect((p.raw as { identityDashProfileComponentsBySectionType?: unknown }).identityDashProfileComponentsBySectionType).toBeTruthy();
  });

  it('handles a sparse payload (no experience section)', () => {
    const p = normalizeProfileResponse({ data: {} }, 'urn:li:fsd_profile:ACoAAF9');
    expect(p).toMatchObject({
      linkedinUrn: 'urn:li:fsd_profile:ACoAAF9',
      handle: 'ACoAAF9', // falls back to the urn tail
      name: '',
      headline: '',
    });
    expect(p.positions ?? []).toEqual([]);
    expect(p.currentCompany).toBeUndefined();
  });

  it('flattens a grouped multi-role company into one position per role', () => {
    const body = {
      data: {
        identityDashProfileComponentsBySectionType: {
          elements: [
            {
              components: {
                pagedListComponent: {
                  components: {
                    elements: [
                      {
                        components: {
                          entityComponent: {
                            // Grouped: the outer title is the company name.
                            titleV2: { text: { text: 'Acme Corp' } },
                            subComponents: {
                              components: [
                                {
                                  components: {
                                    pagedListComponent: {
                                      components: {
                                        elements: [
                                          {
                                            components: {
                                              entityComponent: {
                                                titleV2: { text: { text: 'Senior PM' } },
                                                subtitle: { text: 'Full-time' },
                                                caption: { text: 'Jan 2023 - Present · 1 yr' },
                                                metadata: { text: 'Remote' },
                                              },
                                            },
                                          },
                                          {
                                            components: {
                                              entityComponent: {
                                                titleV2: { text: { text: 'PM' } },
                                                subtitle: { text: 'Full-time' },
                                                caption: { text: 'Jan 2021 - Dec 2022 · 2 yrs' },
                                              },
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    };
    const p = normalizeProfileResponse(body, 'urn:li:fsd_profile:x');
    expect(p.positions).toHaveLength(2);
    expect(p.positions![0]).toMatchObject({ title: 'Senior PM', company: 'Acme Corp', current: true, location: 'Remote' });
    expect(p.positions![1]).toMatchObject({ title: 'PM', company: 'Acme Corp', current: false });
    expect(p.currentTitle).toBe('Senior PM');
    expect(p.currentCompany).toBe('Acme Corp');
  });

  it('collects positions split across multiple top-level section elements', () => {
    const oneElement = (title: string, company: string, caption: string) => ({
      components: {
        pagedListComponent: {
          components: {
            elements: [
              {
                components: {
                  entityComponent: {
                    titleV2: { text: { text: title } },
                    subtitle: { text: `${company} · Full-time` },
                    caption: { text: caption },
                  },
                },
              },
            ],
          },
        },
      },
    });
    const body = {
      data: {
        identityDashProfileComponentsBySectionType: {
          // Experience split across TWO top-level elements — reading only [0]
          // would drop the second job.
          elements: [
            oneElement('VP Eng', 'Acme Corp', 'Jan 2022 - Present · 2 yrs'),
            oneElement('Staff Eng', 'Globex', 'Jan 2018 - Dec 2021 · 4 yrs'),
          ],
        },
      },
    };
    const p = normalizeProfileResponse(body, 'urn:li:fsd_profile:x');
    expect(p.positions).toHaveLength(2);
    expect(p.positions![0]).toMatchObject({ title: 'VP Eng', company: 'Acme Corp', current: true });
    expect(p.positions![1]).toMatchObject({ title: 'Staff Eng', company: 'Globex', current: false });
    expect(p.currentTitle).toBe('VP Eng');
    expect(p.currentCompany).toBe('Acme Corp');
  });
});

describe('LiveObserve.getProfile', () => {
  it('drives the profile-components graphql endpoint and normalizes the payload', async () => {
    const page = new SearchFakePage([
      experiencePayload([{ title: 'VP Eng', subtitle: 'Acme · Full-time', caption: 'Jan 2020 - Present' }]),
    ]);
    const p = await observeWith(page).getProfile('acct', 'urn:li:fsd_profile:ACoAAF9');
    expect(p.currentCompany).toBe('Acme');
    expect(p.currentTitle).toBe('VP Eng');
    // It hit the modern profile-components graphql query, not the dead profileView.
    expect(page.calls[0]).toContain('/voyager/api/graphql?');
    expect(page.calls[0]).toContain('voyagerIdentityDashProfileComponents');
    expect(page.calls[0]).toContain('sectionType:experience');
    expect(page.calls[0]).toContain(encodeURIComponent('urn:li:fsd_profile:ACoAAF9'));
    expect(page.calls[0]).not.toContain('profileView');
  });
});

// ---------------------------------------------------------------------------
// Conversation reader — one thread -> ConversationSummary (both directions).
// ---------------------------------------------------------------------------

/** A trimmed messaging payload holding a single thread with several events. */
function conversationPayload(
  threadUrn: string,
  events: Array<{ sender: string; text: string; at: number; outbound?: boolean }>,
) {
  return {
    elements: [
      {
        entityUrn: threadUrn,
        events: events.map((e) => ({
          deliveredAt: e.at,
          ...(e.outbound ? { outbound: true } : {}),
          from: { miniProfile: { entityUrn: `urn:li:fsd_profile:${e.sender}` } },
          eventContent: { attributedBody: { text: e.text } },
        })),
      },
    ],
  };
}

describe('normalizeConversation (thread mapping)', () => {
  it('maps both inbound and outbound events, oldest-first', () => {
    const thread = 'urn:li:msg_conversation:t1';
    const body = conversationPayload(thread, [
      { sender: 'p1', text: 'hello back', at: 20 },
      { sender: 'me', text: 'hi there', at: 10, outbound: true },
    ]);
    const summary = normalizeConversation(body, thread);
    expect(summary).not.toBeNull();
    expect(summary!.threadRef).toBe(thread);
    expect(summary!.messages).toEqual([
      { direction: 'outbound', body: 'hi there', at: new Date(10) },
      { direction: 'inbound', body: 'hello back', at: new Date(20) },
    ]);
  });

  it('returns null when the thread is not in the payload', () => {
    const body = conversationPayload('urn:li:msg_conversation:other', [
      { sender: 'p1', text: 'hi', at: 5 },
    ]);
    expect(normalizeConversation(body, 'urn:li:msg_conversation:missing')).toBeNull();
  });
});

describe('LiveObserve.getConversation', () => {
  it('maps a found thread (inbound + outbound) via the messaging endpoint', async () => {
    const thread = 'urn:li:msg_conversation:t1';
    const page = new SearchFakePage([
      conversationPayload(thread, [
        { sender: 'me', text: 'hi there', at: 10, outbound: true },
        { sender: 'p1', text: 'hello back', at: 20 },
      ]),
    ]);
    const summary = await observeWith(page).getConversation('acct', thread);
    expect(summary.messages.map((m) => `${m.direction}:${m.body}`)).toEqual([
      'outbound:hi there',
      'inbound:hello back',
    ]);
    expect(page.calls[0]).toContain('/voyager/api/messaging/conversations');
  });

  it('throws naming the ref when the thread is not in the recent window', async () => {
    const page = new SearchFakePage([
      conversationPayload('urn:li:msg_conversation:other', [{ sender: 'p1', text: 'hi', at: 5 }]),
    ]);
    await expect(
      observeWith(page).getConversation('acct', 'urn:li:msg_conversation:missing'),
    ).rejects.toThrow(/urn:li:msg_conversation:missing/);
  });

  it('throws a specific pending-send error for a pending: ref (no voyager call)', async () => {
    const page = new SearchFakePage([{}]);
    await expect(
      observeWith(page).getConversation('acct', 'pending:acct:target-9'),
    ).rejects.toThrow(/pending .*placeholder|no LinkedIn thread exists yet/i);
    // It short-circuits before touching the page.
    expect(page.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real mode never fabricates: the unimplemented reads throw a loud error rather
// than return canned data. compose() wires the observe port to `new LiveObserve`
// whenever a real session exists (see compose.ts observe block), so these
// rejections are exactly what an MCP caller hits in real mode. compose itself
// needs a live browser session to build real mode, which is impractical to fake
// in a unit test, so we assert the behavior on LiveObserve directly and rely on
// reading the one-line compose wiring for the rest.
// ---------------------------------------------------------------------------

describe('LiveObserve unimplemented reads (real mode)', () => {
  const observe: ObservePort = observeWith(new SearchFakePage([{}]));

  it('getRecentPosts rejects with a do-not-personalize error', async () => {
    await expect(observe.getRecentPosts('acct', 'urn:li:fsd_profile:x', 3)).rejects.toThrow(
      /not implemented yet; do not personalize/i,
    );
  });

  it('getPostEngagers and getCompanyJobs also reject (no canned data)', async () => {
    await expect(observe.getPostEngagers('acct', 'urn:li:activity:1', 3)).rejects.toThrow(
      /not implemented yet/i,
    );
    await expect(observe.getCompanyJobs('acct', 'urn:li:company:1', 3)).rejects.toThrow(
      /not implemented yet/i,
    );
  });
});
