// LiveObserve.searchPeople — free-tier Voyager (Flagship) people search.
//
// Strategy: issue a DIRECT authenticated GET to /voyager/api/graphql from the
// account's own logged-in page context (page.voyagerGet), rather than navigating
// to the search results page and intercepting its XHRs. The flagship results
// page is server-rendered — it does not reliably fire a client-side
// voyagerSearchDashClusters request on navigation; the only XHR that fires on a
// bare load is a MYNETWORK_CURATION_HUB "people you may know" decoy. Every
// maintained open-source client (StaffSpy, tomquirk/linkedin-api,
// transitive-bullshit, showrun) calls the graphql endpoint directly with the
// session cookie + csrf-token. Confirmed live on 2026-07-06: intercept-on-nav
// only ever caught the curation decoy.
//
// FREE-TIER ONLY: no Sales Navigator. So the only facets available are
// title-keyword, current-company, geography, and connection-degree. Seniority
// ("manager or above") has no facet and is approximated upstream via
// titleKeywords. A Sales Navigator backend (real seniority/function facets via
// salesApiPeopleSearch) is a separate implementation behind this same port; do
// not add it here.
//
// The request grammar is isolated in buildVoyagerGraphqlPath(); its literals
// (flagshipSearchIntent:SEARCH_SRP, resultType:List(PEOPLE), the manual
// non-percent-encoded variables string) are cross-verified against three current
// open-source clients. buildVoyagerSearchUrl() is retained as the human-facing
// results-page URL (e.g. to open the same search in a real browser).

import { extractCompany } from '@loa/shared';
import type { PagePort } from '@loa/account-runner';
import type {
  ObservePort,
  PeopleQuery,
  PersonSearchResult,
  ProfileSummary,
  PostSummary,
  EngagerSummary,
  JobSummary,
  ConversationSummary,
  RecentConnection,
} from '@loa/mcp';

/**
 * The persisted-query id for the people-search graphql call. LinkedIn rotates
 * this hash as it ships new web builds; a stale hash eventually 400s. Override
 * with LOA_SEARCH_QUERY_ID once you capture a current one from a live browser's
 * Network tab (the voyagerSearchDashClusters.<hash> on a /search/results/people/
 * request). Default is the newest observed in prior art (showrun, 2025).
 */
const DEFAULT_SEARCH_QUERY_ID = 'voyagerSearchDashClusters.05111e1b90ee7fea15bebe9f9410ced9';

function searchQueryId(): string {
  return process.env.LOA_SEARCH_QUERY_ID?.trim() || DEFAULT_SEARCH_QUERY_ID;
}

/** Flagship caps free-tier search at ~1000 results; never page past it. */
const FLAGSHIP_RESULT_CAP = 1000;

/** Results per page (Voyager `count`); prior art caps this at ~25. */
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
/**
 * Default geography when a search specifies none: United States + Canada. Bare
 * Voyager geo facet ids (not full urns), the same form callers pass explicitly.
 * A free-tier keyword search with no geo otherwise returns a worldwide mix
 * (Paris, Madrid, Bergen), so we constrain to North America by default; a caller
 * that supplies any geo (geoUrn or geoUrns) overrides this entirely.
 */
export const DEFAULT_GEO_URNS = [
  '103644278', // United States
  '101174742', // Canada
] as const;

/** All geo facet ids for a query: the legacy single geoUrn plus the geoUrns
 * array, in that order, deduped. Lets a search target multiple geographies
 * (e.g. US + Canada) in one pass, mirroring how companyUrns is a plain list.
 * When the caller supplies NO geo at all, defaults to US + Canada
 * (DEFAULT_GEO_URNS) so sourcing does not drift worldwide. */
export function collectGeoUrns(query: PeopleQuery): string[] {
  const all = [...(query.geoUrn ? [query.geoUrn] : []), ...(query.geoUrns ?? [])];
  const deduped = [...new Set(all)];
  return deduped.length > 0 ? deduped : [...DEFAULT_GEO_URNS];
}

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

  const geoUrns = collectGeoUrns(query);
  const hasFacets = geoUrns.length > 0 || !!query.companyUrns?.length || !!query.network?.length;
  // origin is LinkedIn's own entry-tracking token: FACETED_SEARCH when filters
  // are applied, SWITCH_SEARCH_VERTICAL for a plain keyword search.
  params.set('origin', hasFacets ? 'FACETED_SEARCH' : 'SWITCH_SEARCH_VERTICAL');

  // Each facet is its own JSON-array param. URLSearchParams percent-encodes the
  // brackets/quotes; LinkedIn's client decodes them back, exactly as the browser
  // does when a human clicks the filter, so either form is accepted.
  if (query.network?.length) params.set('network', JSON.stringify(query.network));
  if (geoUrns.length) params.set('geoUrn', JSON.stringify(geoUrns));
  if (query.companyUrns?.length) params.set('currentCompany', JSON.stringify(query.companyUrns));

  // People search paginates by `page` (1-based).
  const page = Math.floor(start / PAGE_SIZE) + 1;
  if (page > 1) params.set('page', String(page));

  return url.toString();
}

/**
 * Build the origin-relative /voyager/api/graphql path for one page of people
 * results. This is the request we ISSUE directly (page.voyagerGet), not a page
 * to navigate to.
 *
 * CRITICAL ENCODING RULE: the `variables=(...)` value must NOT be percent-encoded
 * — LinkedIn's Rest.li parser needs the literal parens/colons/commas. Only the
 * keywords VALUE is escaped (so a space or comma inside it can't break the
 * grammar). This is why the string is concatenated by hand rather than built
 * with URLSearchParams, which would percent-encode the structure and 400.
 *
 * Load-bearing literals (cross-verified against StaffSpy, tomquirk/linkedin-api,
 * transitive-bullshit, showrun):
 *   flagshipSearchIntent:SEARCH_SRP           — the people-results intent
 *   queryParameters:List((key:resultType,value:List(PEOPLE)))  — always present
 * Free-tier facets map to queryParameters tuples:
 *   (key:currentCompany,value:List(<companyIds>))
 *   (key:geoUrn,value:List(<geoId>))
 *   (key:network,value:List(F,S,O))     (comma-joined, as the live browser sends)
 * Title/company free text folds into keywords (no free-tier facet for those).
 */
export function buildVoyagerGraphqlPath(
  query: PeopleQuery,
  start: number,
  count: number,
): string {
  const keywordParts = [
    query.keywords,
    ...(query.titleKeywords ?? []),
    ...(query.companyKeywords ?? []),
  ]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  const keywords = keywordParts.join(' ');

  const facets: string[] = [];
  if (query.companyUrns?.length) {
    facets.push(`(key:currentCompany,value:List(${query.companyUrns.join(',')}))`);
  }
  const geoUrns = collectGeoUrns(query);
  if (geoUrns.length) facets.push(`(key:geoUrn,value:List(${geoUrns.join(',')}))`);
  if (query.network?.length) facets.push(`(key:network,value:List(${query.network.join(',')}))`);
  facets.push('(key:resultType,value:List(PEOPLE))');

  // Escape ONLY the keyword value; leave the (...) grammar literal.
  const kwPart = keywords ? `keywords:${encodeURIComponent(keywords)},` : '';
  const variables =
    `(start:${start},origin:GLOBAL_SEARCH_HEADER,` +
    `query:(${kwPart}flagshipSearchIntent:SEARCH_SRP,` +
    `queryParameters:List(${facets.join(',')}),includeFiltersInResponse:false),` +
    `count:${count})`;

  return `/voyager/api/graphql?variables=${variables}&queryId=${searchQueryId()}`;
}

/**
 * Navigate to the LinkedIn origin so a same-origin voyagerGet carries cookies.
 *
 * The origin nav can fail transiently: LinkedIn sometimes denies a request from a
 * datacenter IP with a non-renderable status, which the driver surfaces as a
 * `net::ERR_*` throw (not a checkpoint page we could detect). Retry a few times
 * with backoff so a blip self-heals, and on a persistent failure throw an
 * actionable message — the account is likely rate-limited or challenged from this
 * IP, which is recoverable, not a code fault — instead of the raw driver error.
 */
export async function ensureOnLinkedIn(page: PagePort, attempts = 3): Promise<void> {
  if (page.url().startsWith('https://www.linkedin.com')) return;
  let lastErr = '';
  for (let i = 0; i < attempts; i += 1) {
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (i < attempts - 1) await page.waitForTimeout(2000 * (i + 1));
    }
  }
  throw new Error(
    `could not reach the LinkedIn origin after ${attempts} attempts: ${lastErr}. The ` +
      `account is likely rate-limited or challenged from this IP (a recoverable denial, ` +
      `not a code fault) — wait and retry, or check the account for a security checkpoint.`,
  );
}

// ---------------------------------------------------------------------------
// Inbox reading — recent inbound replies, for the reply-detection loop.
// ---------------------------------------------------------------------------

/**
 * One inbound message as the reply loop needs it: the thread it belongs to, the
 * sender's identity (urn + a /in/ profile url when derivable), the text, and
 * when it arrived. Only counterparty (inbound) messages are surfaced; the
 * account's own outbound sends are dropped by the reader.
 */
export interface InboundMessage {
  /** urn:li:msg_conversation:(...) — the thread key. */
  threadUrn: string;
  /** The sender's profile urn (urn:li:fsd_profile:... / urn:li:member:...). */
  senderUrn: string;
  /** https://www.linkedin.com/in/<publicId>/ when the payload carries one. */
  profileUrl?: string;
  /** The message body text. */
  text: string;
  /** When LinkedIn timestamps the message (deliveredAt). */
  receivedAt: Date;
}

/** The slice of the inbox the reply-detection loop drives per account. */
export interface InboxReaderPort {
  readInbox(accountId: string, limit: number): Promise<InboundMessage[]>;
}

/** Voyager messaging conversations endpoint. Returns the most recent threads
 * with their last events inlined; free on a normal session. The count caps how
 * many threads come back (not messages). */
function messagingPath(count: number): string {
  return (
    `/voyager/api/messaging/conversations` +
    `?keyVersion=LEGACY_INBOX&q=syncToken&count=${count}`
  );
}

/**
 * LiveInboxReader: read recent inbound messages for an account by issuing a
 * direct authenticated GET to the Voyager messaging endpoint from the account's
 * own logged-in page (page.voyagerGet), the SAME same-origin primitive
 * searchPeople uses.
 *
 * Why not the DOM readInbox()/getConversation() actions: those exist and are
 * live-verified for their own jobs, but the runner's LocatorPort surface is
 * click/type/read-text only — it cannot read a row's profile anchor href, so it
 * cannot recover the sender urn a reply must map to. The messaging graphql
 * payload carries thread + participant urns + message text + deliveredAt
 * directly, which is what the loop needs. The response parsing below is
 * defensive (every field optional) because the payload is large and versioned.
 *
 * STILL TO VERIFY LIVE: the exact field names against a real messaging payload
 * (events[].deliveredAt, from.*.miniProfile.entityUrn, the account's own urn to
 * tell inbound from outbound). normalizeInboxResponse is exported so the ops
 * shakeout can run the real normalizer over a captured body and adjust names.
 */
export class LiveInboxReader implements InboxReaderPort {
  constructor(private readonly pages: PageProvider) {}

  async readInbox(accountId: string, limit: number): Promise<InboundMessage[]> {
    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    const { status, body } = await page.voyagerGet(messagingPath(limit), {
      accept: 'application/json',
    });
    if (status !== 200) {
      throw new Error(
        `voyager messaging returned HTTP ${status}; the session may be invalid`,
      );
    }
    return normalizeInboxResponse(body).slice(0, limit);
  }
}

/**
 * Walk a Voyager messaging conversations response into InboundMessage[]. Reads
 * both the decorated (`elements[]`) and normalized (`included[]`) shapes, keeps
 * only counterparty messages (a message whose sender is a participant, not the
 * viewer), and drops anything missing a thread urn, sender urn, or text.
 * Exported for the ops shakeout to run over a captured raw payload.
 */
export function normalizeInboxResponse(body: unknown): InboundMessage[] {
  const root = body as VoyagerMessagingResponse | undefined;
  const conversations =
    root?.elements ?? root?.data?.elements ?? asConversations(root?.included);

  const out: InboundMessage[] = [];
  for (const conv of conversations ?? []) {
    const threadUrn = conv?.entityUrn ?? conv?.backendUrn;
    if (!threadUrn) continue;
    for (const event of conv?.events ?? []) {
      const msg = normalizeEvent(threadUrn, event);
      if (msg) out.push(msg);
    }
  }
  // Most recent first, so a per-thread dedupe upstream keeps the latest reply.
  out.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return out;
}

/** Pull EVENT/CONVERSATION entities out of a normalized `included[]` list. */
function asConversations(included: MessagingEntity[] | undefined): Conversation[] | undefined {
  if (!Array.isArray(included)) return undefined;
  return included.filter((el) => Array.isArray(el?.events));
}

function normalizeEvent(threadUrn: string, event: MessagingEvent | undefined): InboundMessage | null {
  if (!event) return null;
  const attributed = event.eventContent?.attributedBody?.text ?? event.subject;
  const text = attributed?.trim();
  if (!text) return null; // non-text events (shares, reactions) carry no body.

  const sender = event.from?.messagingMember?.miniProfile ?? event.from?.miniProfile;
  const senderUrn = sender?.entityUrn ?? event.from?.entityUrn;
  if (!senderUrn) return null;

  // A message the account itself sent is outbound; skip it. LinkedIn flags the
  // viewer's own events, but the exact flag varies by shape, so we defensively
  // treat an explicit `outbound`/`fromViewer` marker as outbound and keep the
  // rest. // GUESS: verify against a real payload.
  if (event.outbound === true || event.from?.fromViewer === true) return null;

  const publicId = sender?.publicIdentifier;
  const deliveredAt = event.deliveredAt ?? event.createdAt;
  return {
    threadUrn,
    senderUrn,
    ...(publicId ? { profileUrl: `https://www.linkedin.com/in/${publicId}/` } : {}),
    text,
    receivedAt: typeof deliveredAt === 'number' ? new Date(deliveredAt) : new Date(),
  };
}

// ---------------------------------------------------------------------------
// Connections reading — recently accepted connections, for acceptance gating.
// ---------------------------------------------------------------------------

/**
 * One accepted connection as the acceptance tick needs it: the connected
 * person's profile urn, a /in/ profile url when derivable, and when the
 * connection formed if the payload carries it. Shape mirrors InboundMessage so
 * the SAME identity matcher maps it back to an enrolled target.
 */
export interface AcceptedConnection {
  /** The connection's profile urn (urn:li:fsd_profile:... / urn:li:member:...). */
  entityUrn: string;
  /** https://www.linkedin.com/in/<publicId>/ when the payload carries one. */
  profileUrl?: string;
  /** Full name (firstName + lastName), when the payload carries them. */
  name?: string;
  /** The connection's headline/occupation, when present. */
  headline?: string;
  /** When LinkedIn timestamps the connection (createdAt). */
  connectedAt?: Date;
}

/** The slice of the network the acceptance tick drives per account. */
export interface ConnectionsReaderPort {
  readConnections(accountId: string, limit: number): Promise<AcceptedConnection[]>;
}

/**
 * Static connections reader for fake-executor mode: returns [] so composing
 * with executor=fake never touches a browser. Mirrors how the reply tick simply
 * has no live inbox in fake mode. Seed `connections` in a test to drive matches.
 */
export class StaticConnectionsReader implements ConnectionsReaderPort {
  constructor(private readonly connections: AcceptedConnection[] = []) {}
  async readConnections(): Promise<AcceptedConnection[]> {
    return this.connections;
  }
}

/**
 * The Rest.li decoration that tells the connections endpoint to INLINE each
 * connection's Profile (name, headline, publicIdentifier) into `included[]`.
 * Without it the response carries only bare Connection stubs (createdAt +
 * connectedMember urn), so names/headlines would be blank. LinkedIn bumps the
 * trailing version (…WithProfile-16) as it ships new web builds; older versions
 * still resolved live (−14…−16 all returned 200), but override with
 * LOA_CONNECTIONS_DECORATION_ID if a future bump ever 400s. Captured live
 * 2026-07-10. Named a decorationId, not a queryId, because this is the Rest.li
 * REST endpoint (not GraphQL) — the modern replacement for the deprecated
 * /voyager/api/relationships/connections, which now 400s.
 */
const DEFAULT_CONNECTIONS_DECORATION_ID =
  'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16';

function connectionsDecorationId(): string {
  return process.env.LOA_CONNECTIONS_DECORATION_ID?.trim() || DEFAULT_CONNECTIONS_DECORATION_ID;
}

/** Voyager relationships DASH connections endpoint. Returns the account's own
 * 1st-degree connections most-recently-added first; free on a normal session.
 * The count caps how many come back. The `dash` path + ConnectionListWithProfile
 * decoration is the modern replacement for /voyager/api/relationships/connections
 * (that legacy REST path now returns HTTP 400). */
function connectionsPath(count: number): string {
  return (
    `/voyager/api/relationships/dash/connections` +
    `?decorationId=${connectionsDecorationId()}` +
    `&count=${count}&q=search&sortType=RECENTLY_ADDED&start=0`
  );
}

/**
 * LiveConnectionsReader: read an account's recently-accepted connections by
 * issuing a direct authenticated GET to the Voyager relationships DASH endpoint
 * from the account's own logged-in page (page.voyagerGet), the SAME same-origin
 * primitive searchPeople and the inbox reader use. Sorted most-recent first so a
 * parked target that just accepted surfaces near the top.
 *
 * Verified live 2026-07-10 against the seeded account: the legacy REST path
 * /voyager/api/relationships/connections now returns HTTP 400, so this hits the
 * modern /voyager/api/relationships/dash/connections with the
 * ConnectionListWithProfile decoration. The normalized+json response carries a
 * `data.*elements` order (RECENTLY_ADDED) plus an `included[]` of Connection and
 * Profile entities; normalizeConnectionsResponse resolves the two together.
 */
export class LiveConnectionsReader implements ConnectionsReaderPort {
  constructor(private readonly pages: PageProvider) {}

  async readConnections(accountId: string, limit: number): Promise<AcceptedConnection[]> {
    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    // Request the NORMALIZED shape: the dash endpoint returns Connection stubs
    // and their resolved Profiles as separate `included[]` entities keyed by urn,
    // which is how the profile (name/headline/publicId) attaches to each row.
    const { status, body } = await page.voyagerGet(connectionsPath(limit), {
      accept: 'application/vnd.linkedin.normalized+json+2.1',
    });
    if (status !== 200) {
      throw new Error(
        `voyager connections returned HTTP ${status}; the session may be invalid ` +
          `or the decoration stale (set LOA_CONNECTIONS_DECORATION_ID to a current one)`,
      );
    }
    return normalizeConnectionsResponse(body).slice(0, limit);
  }
}

/**
 * Walk a Voyager relationships connections response into AcceptedConnection[].
 *
 * The live dash endpoint returns the NORMALIZED shape (captured 2026-07-10):
 *   { data: { "*elements": [ "urn:li:fsd_connection:<id>", … ] },
 *     included: [ Connection…, Profile… ] }
 * Each `Connection` carries createdAt (epoch ms) + connectedMember (the person's
 * `urn:li:fsd_profile:<id>`) + a `*connectedMemberResolutionResult` reference to
 * the resolved `Profile` entity (firstName/lastName/headline/publicIdentifier).
 * `data.*elements` is already RECENTLY_ADDED order. We resolve each Connection to
 * its Profile via the `included[]` urn map, key identity on the fsd_profile urn
 * (so the acceptance matcher's urn-tail still matches a sourced target), and sort
 * most-recent-first as a belt-and-braces guarantee.
 *
 * A legacy decorated fallback (`elements[].miniProfile`) is retained for older
 * response forms and the unit fixtures. Exported for the ops shakeout.
 */
export function normalizeConnectionsResponse(body: unknown): AcceptedConnection[] {
  const root = body as VoyagerConnectionsResponse | undefined;

  // --- Modern normalized shape: data.*elements + included[Connection|Profile] ---
  const included = root?.included;
  if (Array.isArray(included) && included.length) {
    const byUrn = new Map<string, ConnectionEntity>();
    for (const el of included) if (el?.entityUrn) byUrn.set(el.entityUrn, el);

    // Prefer the server's RECENTLY_ADDED order in data.*elements; fall back to
    // every Connection entity in included when that ordering list is absent.
    const order = root?.data?.['*elements'];
    const conns = Array.isArray(order)
      ? order.map((u) => byUrn.get(u)).filter((e): e is ConnectionEntity => !!e)
      : included.filter(isConnectionEntity);

    const modern: AcceptedConnection[] = [];
    for (const conn of conns) {
      const c = normalizeDashConnection(conn, byUrn);
      if (c) modern.push(c);
    }
    if (modern.length) {
      modern.sort((a, b) => (b.connectedAt?.getTime() ?? 0) - (a.connectedAt?.getTime() ?? 0));
      return modern;
    }
  }

  // --- Legacy decorated fallback: elements[].miniProfile ------------------------
  const elements =
    root?.elements ?? root?.data?.elements ?? asConnectionElements(included);
  const out: AcceptedConnection[] = [];
  for (const el of elements ?? []) {
    const conn = normalizeConnectionElement(el);
    if (conn) out.push(conn);
  }
  out.sort((a, b) => (b.connectedAt?.getTime() ?? 0) - (a.connectedAt?.getTime() ?? 0));
  return out;
}

/** True when a normalized `included[]` entity is a relationships Connection
 * stub (has connectedMember, or a $type/_type tag ending in `.Connection`). */
function isConnectionEntity(el: ConnectionEntity | undefined): boolean {
  if (!el) return false;
  if (typeof el.connectedMember === 'string') return true;
  const t = el.$type ?? el._type ?? '';
  return typeof t === 'string' && t.endsWith('.Connection');
}

/**
 * Resolve one dash Connection stub against the `included[]` urn map into an
 * AcceptedConnection. Identity keys on the connectedMember fsd_profile urn (the
 * one the acceptance/reply matcher can tail-match); name/headline/profileUrl come
 * from the resolved Profile entity.
 */
function normalizeDashConnection(
  conn: ConnectionEntity | undefined,
  byUrn: Map<string, ConnectionEntity>,
): AcceptedConnection | null {
  if (!conn) return null;
  const profileRef = conn['*connectedMemberResolutionResult'] ?? conn.connectedMember;
  const profile = typeof profileRef === 'string' ? byUrn.get(profileRef) : undefined;

  // Key identity on the person's profile urn, not the fsd_connection urn.
  const entityUrn = conn.connectedMember ?? profile?.entityUrn ?? conn.entityUrn;
  if (!entityUrn) return null;

  const publicId = profile?.publicIdentifier;
  const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
  const headline = profile?.headline?.trim() || profile?.occupation?.trim();
  const connectedAt = conn.createdAt;
  return {
    entityUrn,
    ...(publicId ? { profileUrl: `https://www.linkedin.com/in/${publicId}/` } : {}),
    ...(name ? { name } : {}),
    ...(headline ? { headline } : {}),
    ...(typeof connectedAt === 'number' ? { connectedAt: new Date(connectedAt) } : {}),
  };
}

/** Pull connection entities out of a normalized `included[]` list (those that
 * carry a miniProfile). Legacy decorated shape only. */
function asConnectionElements(
  included: ConnectionEntity[] | undefined,
): ConnectionElement[] | undefined {
  if (!Array.isArray(included)) return undefined;
  return included.filter((el) => !!el?.miniProfile || !!el?.connectedMemberResolutionResult);
}

function normalizeConnectionElement(
  el: ConnectionElement | undefined,
): AcceptedConnection | null {
  if (!el) return null;
  const profile = el.miniProfile ?? el.connectedMemberResolutionResult;
  const entityUrn = profile?.entityUrn ?? el.entityUrn;
  if (!entityUrn) return null;

  const publicId = profile?.publicIdentifier;
  const connectedAt = el.createdAt;
  const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
  return {
    entityUrn,
    ...(publicId ? { profileUrl: `https://www.linkedin.com/in/${publicId}/` } : {}),
    ...(name ? { name } : {}),
    ...(profile?.occupation ? { headline: profile.occupation } : {}),
    ...(typeof connectedAt === 'number' ? { connectedAt: new Date(connectedAt) } : {}),
  };
}

// ---------------------------------------------------------------------------
// LiveObserve
// ---------------------------------------------------------------------------

export class LiveObserve implements ObservePort {
  constructor(
    private readonly pages: PageProvider,
    private readonly budget: SearchBudget,
  ) {}

  /** Recently-accepted connections, most-recent first. Reads the same live
   * Voyager relationships endpoint the acceptance tick uses. Not a people-search,
   * so it does NOT charge the search budget. */
  async listRecentConnections(accountId: string, limit: number): Promise<RecentConnection[]> {
    const reader = new LiveConnectionsReader(this.pages);
    const connections = await reader.readConnections(accountId, limit);
    return connections.map((c) => ({
      entityUrn: c.entityUrn,
      ...(c.profileUrl ? { profileUrl: c.profileUrl } : {}),
      ...(c.name ? { name: c.name } : {}),
      ...(c.headline ? { headline: c.headline } : {}),
      ...(c.connectedAt ? { connectedAt: c.connectedAt.toISOString() } : {}),
    }));
  }

  async searchPeople(
    accountId: string,
    query: PeopleQuery,
    limit: number,
  ): Promise<PersonSearchResult[]> {
    this.budget.charge(accountId);

    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    const target = Math.min(query.limit ?? limit, limit, FLAGSHIP_RESULT_CAP);

    const seen = new Set<string>();
    const results: PersonSearchResult[] = [];

    for (let start = 0; start < target; start += PAGE_SIZE) {
      const path = buildVoyagerGraphqlPath(query, start, PAGE_SIZE);
      const { status, body } = await page.voyagerGet(path, { accept: 'application/json' });

      if (status !== 200) {
        // A non-200 on the first page is a hard failure (bad session or a stale
        // queryId — set LOA_SEARCH_QUERY_ID). Later pages just stop pagination.
        if (results.length === 0) {
          throw new Error(
            `voyager people-search returned HTTP ${status}; the session may be ` +
              `invalid or the queryId stale (set LOA_SEARCH_QUERY_ID to a current one)`,
          );
        }
        break;
      }

      const items = normalizeSearchResponse(body);
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
 * Walk a voyagerSearchDashClusters response body into PersonSearchResult[].
 * Handles the two shapes the API returns depending on the Accept header:
 *   - Decorated (application/json): people are nested under
 *     data.searchDashClustersByAll.elements[].items[].item.entityResult, and the
 *     GraphQL envelope may double-nest as data.data.searchDashClustersByAll.
 *   - Normalized (…normalized+json…): a flat top-level `included[]` of entities
 *     tagged by $type/_type; we filter to the EntityResultViewModel cards.
 * Exported so ops tooling (the search shakeout) can run the REAL normalizer over
 * a captured raw payload and confirm the field names.
 */
export function normalizeSearchResponse(body: unknown): PersonSearchResult[] {
  const root = body as VoyagerSearchResponse | undefined;
  const clusters =
    root?.data?.searchDashClustersByAll?.elements ??
    root?.data?.data?.searchDashClustersByAll?.elements ??
    [];

  const out: PersonSearchResult[] = [];
  for (const cluster of clusters) {
    for (const wrapper of cluster.items ?? []) {
      const er = wrapper.item?.entityResult;
      if (!er) continue; // non-person items (feedback/promo/also-viewed cards)
      const normalized = normalizeEntityResult(er);
      if (normalized) out.push(normalized);
    }
  }

  // Fallback for the normalized `included[]` shape: filter to person cards by
  // type tag ($type or _type ending in EntityResultViewModel).
  if (out.length === 0 && Array.isArray(root?.included)) {
    for (const el of root.included) {
      const t = el?.$type ?? el?._type ?? '';
      if (typeof t === 'string' && t.endsWith('EntityResultViewModel')) {
        const normalized = normalizeEntityResult(el);
        if (normalized) out.push(normalized);
      }
    }
  }
  return out;
}

function normalizeEntityResult(er: EntityResult): PersonSearchResult | null {
  const entityUrn = er.entityUrn ?? er.trackingUrn;
  if (!entityUrn) return null;

  // Keep only person cards. A real people-search card's entityUrn wraps a
  // urn:li:fsd_profile and its trackingUrn is a urn:li:member; company/content/
  // promo cards carry neither. This drops non-person items a cluster may mix in.
  const isPerson =
    (er.entityUrn?.includes('fsd_profile') ?? false) ||
    (er.trackingUrn?.includes(':member:') ?? false);
  if (!isPerson) return null;

  const navUrl = er.navigationUrl ?? '';
  const publicId = publicIdFromUrl(navUrl);
  const profileUrl = navUrl
    ? (navUrl.split('?')[0] ?? navUrl)
    : publicId
      ? `https://www.linkedin.com/in/${publicId}/`
      : '';

  // entityUrn wraps the stable profile urn plus search context, e.g.
  // urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ABC,SEARCH_SRP,DEFAULT).
  // Persist the inner fsd_profile urn as the identity so dedup and reply-matching
  // key on the person, not the volatile search-result context.
  const linkedinUrn = profileUrnFromEntityUrn(entityUrn) ?? entityUrn;

  return {
    entityUrn,
    linkedinUrn,
    ...(publicId ? { publicId } : {}),
    name: textOf(er.title),
    headline: textOf(er.primarySubtitle),
    profileUrl,
    degree: er.entityCustomTrackingInfo?.memberDistance ?? er.badgeText?.text,
    location: textOf(er.secondarySubtitle),
    // Free-tier search carries NO structured company (verified live 2026-07-10:
    // no fsd_company, null company logos, no embedded object). The only company
    // signal is when the occupation line names it ("Director at Voltera"), so we
    // conservatively parse it from primarySubtitle — undefined when unmarked.
    currentCompany: extractCompany(textOf(er.primarySubtitle)),
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

/**
 * Extract the stable `urn:li:fsd_profile:...` from a search-result entityUrn,
 * which wraps it with search context. Returns undefined if the urn is already
 * bare or carries no profile urn, letting the caller fall back to the raw value.
 */
export function profileUrnFromEntityUrn(urn: string): string | undefined {
  return urn.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/)?.[0];
}

// ---------------------------------------------------------------------------
// Minimal structural types for the slice of the response we read. Everything is
// optional because the payload is large and versioned; we defensively read.
// ---------------------------------------------------------------------------

interface VoyagerSearchResponse {
  data?: {
    // The GraphQL envelope sometimes double-nests as data.data.…
    data?: { searchDashClustersByAll?: { elements?: SearchCluster[] } };
    searchDashClustersByAll?: { elements?: SearchCluster[] };
  };
  /** Flat entity list in the normalized (…normalized+json…) response shape. */
  included?: EntityResult[];
}

interface SearchCluster {
  items?: Array<{ item?: { entityResult?: EntityResult } }>;
}

interface TextNode {
  text?: string;
}

interface EntityResult {
  /** Type discriminator in the normalized ($type) / decorated (_type) shapes. */
  $type?: string;
  _type?: string;
  entityUrn?: string;
  trackingUrn?: string;
  navigationUrl?: string;
  title?: TextNode;
  primarySubtitle?: TextNode;
  secondarySubtitle?: TextNode;
  badgeText?: TextNode;
  entityCustomTrackingInfo?: { memberDistance?: string };
}

// --- messaging conversations response (inbox reader) ----------------------

interface VoyagerMessagingResponse {
  elements?: Conversation[];
  data?: { elements?: Conversation[] };
  /** Flat entity list in the normalized response shape. */
  included?: MessagingEntity[];
}

interface Conversation {
  entityUrn?: string;
  backendUrn?: string;
  events?: MessagingEvent[];
}

interface MessagingMiniProfile {
  entityUrn?: string;
  publicIdentifier?: string;
}

interface MessagingEvent {
  entityUrn?: string;
  createdAt?: number;
  deliveredAt?: number;
  /** LinkedIn's own marker for a message the viewer sent. */
  outbound?: boolean;
  subject?: string;
  from?: {
    entityUrn?: string;
    fromViewer?: boolean;
    miniProfile?: MessagingMiniProfile;
    messagingMember?: { miniProfile?: MessagingMiniProfile };
  };
  eventContent?: { attributedBody?: { text?: string } };
}

/** Any entity in the normalized `included[]`; only conversations carry events. */
type MessagingEntity = Conversation & Record<string, unknown>;

// --- relationships connections response (connections reader) --------------

interface VoyagerConnectionsResponse {
  elements?: ConnectionElement[];
  data?: {
    elements?: ConnectionElement[];
    /** Ordered connection urns (RECENTLY_ADDED) in the normalized dash shape. */
    '*elements'?: string[];
  };
  /** Flat entity list in the normalized response shape (Connection + Profile). */
  included?: ConnectionEntity[];
}

interface ConnectionMiniProfile {
  entityUrn?: string;
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  occupation?: string;
}

interface ConnectionElement {
  entityUrn?: string;
  /** Connection timestamp, epoch ms. */
  createdAt?: number;
  miniProfile?: ConnectionMiniProfile;
  /** Legacy inline resolved profile (older decorated shape). */
  connectedMemberResolutionResult?: ConnectionMiniProfile;
}

/**
 * An entity in the normalized dash `included[]`: either a relationships
 * `Connection` stub or a resolved identity `Profile`. Fields are optional because
 * a given entity is only one of the two. Verified live 2026-07-10:
 *   Connection: createdAt, connectedMember (urn:li:fsd_profile:<id>),
 *               *connectedMemberResolutionResult (urn ref into included[]).
 *   Profile:    entityUrn, publicIdentifier, firstName, lastName, headline.
 */
interface ConnectionEntity extends ConnectionElement {
  $type?: string;
  _type?: string;
  /** Connection stub: the connected person's urn:li:fsd_profile:<id>. */
  connectedMember?: string;
  /** Connection stub: urn reference to the resolved Profile in included[]. */
  '*connectedMemberResolutionResult'?: string;
  /** Profile-entity fields (present on Profile, absent on Connection). */
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  occupation?: string;
}

// ---------------------------------------------------------------------------
// STILL TO VERIFY LIVE
// ---------------------------------------------------------------------------
// Request grammar and response parsing are grounded in three current OSS clients.
// Two things only a live run against this account confirms:
//   - The hardcoded DEFAULT_SEARCH_QUERY_ID is current (a stale hash 400s; if so,
//     capture a fresh voyagerSearchDashClusters.<hash> and set LOA_SEARCH_QUERY_ID).
//   - The entityResult field names (title / primarySubtitle / navigationUrl /
//     memberDistance) against a real payload. The shakeout dumps the raw body so
//     these can be checked and adjusted if LinkedIn renamed them.
//
// The inbox reader (readInbox / normalizeInboxResponse) is grounded in the same
// prior art but UNPROVEN against a live messaging payload: the conversations
// endpoint path, the event field names (eventContent.attributedBody.text,
// from.*.miniProfile.entityUrn, deliveredAt), and the inbound/outbound marker
// all need one real run to confirm. normalizeInboxResponse is exported so the
// ops shakeout can dump a raw body and adjust the names.
//
// The connections reader (readConnections / normalizeConnectionsResponse) is
// VERIFIED live 2026-07-10 against the seeded account: the legacy
// /voyager/api/relationships/connections REST path returns HTTP 400, so it now
// uses /voyager/api/relationships/dash/connections with the
// ConnectionListWithProfile decoration and parses the normalized
// data.*elements + included[Connection|Profile] shape. The only rotatable piece
// is the decoration version (LOA_CONNECTIONS_DECORATION_ID overrides the default).
