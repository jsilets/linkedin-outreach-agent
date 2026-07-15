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

import type { PagePort } from '@loa/account-runner';
import type {
  ConversationSummary,
  EngagerSummary,
  JobSummary,
  ObservePort,
  PeopleQuery,
  PersonSearchResult,
  PostSummary,
  ProfilePosition,
  ProfileSummary,
  RecentConnection,
} from '@loa/mcp';
import { extractCompany } from '@loa/shared';

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
 *   keywords=field service operations lead
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
export function buildVoyagerGraphqlPath(query: PeopleQuery, start: number, count: number): string {
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
  /** Conversation identities from the mailbox list. Unlike readInbox, this is
   * useful even when the latest visible event was sent by the account owner. */
  readThreads?(accountId: string, limit: number): Promise<InboxThread[]>;
  /** Full event history for exactly one known thread. This is the reply-gate
   * safety path: list snippets alone can hide an earlier prospect reply after a
   * human sends a later message. */
  readThreadHistory?(accountId: string, threadUrn: string): Promise<InboundMessage[]>;
}

/** A mailbox row mapped to its counterparty, independent of who sent its latest
 * message. This is the bridge from an active target to the one thread whose
 * complete history must be checked. */
export interface InboxThread {
  threadUrn: string;
  participantUrn: string;
  profileUrl?: string;
  /**
   * When this conversation last saw ANY event, either direction, as the list row
   * reports it. Direction-agnostic on purpose: it is a change detector, not a
   * reply detector. A prospect's reply followed by our own later send leaves the
   * list showing only our message, and that is exactly the case a reply must not
   * be missed in — so what matters is that the thread moved at all, not who
   * moved it.
   *
   * Undefined when the row carries no parsable timestamp. Callers must treat
   * that as "unknown, read it" and never as "unchanged".
   */
  lastActivityAt?: Date;
}

/**
 * The persisted-query id for the modern messenger conversations graphql call.
 * Like DEFAULT_SEARCH_QUERY_ID / DEFAULT_PROFILE_QUERY_ID, LinkedIn rotates this
 * hash as it ships new web builds; a stale hash eventually 400s. Override with
 * LOA_INBOX_QUERY_ID once you capture a current one from a live browser's Network
 * tab (the messengerConversations.<hash> fired on a /messaging/ load). This is a
 * default captured LIVE by npm run inbox-shakeout on 2026-07-12 (HTTP 200, parser
 * verified against the real payload). Re-run the shakeout if reads start 400ing.
 */
const DEFAULT_INBOX_QUERY_ID = 'messengerConversations.0d5e6781bbee71c3e51c8843c6519f48';
/** Captured read-only from the paused account on 2026-07-14 by opening an
 * existing /messaging/thread/:id page. LinkedIn rotates this hash, so retain an
 * environment escape hatch exactly like the conversation-list query. */
const DEFAULT_INBOX_MESSAGES_QUERY_ID = 'messengerMessages.5846eeb71c981f11e0134cb6626cc314';

function inboxQueryId(): string {
  return process.env.LOA_INBOX_QUERY_ID?.trim() || DEFAULT_INBOX_QUERY_ID;
}

function inboxMessagesQueryId(): string {
  return process.env.LOA_INBOX_MESSAGES_QUERY_ID?.trim() || DEFAULT_INBOX_MESSAGES_QUERY_ID;
}

/**
 * Build the origin-relative modern messenger conversations graphql path for one
 * mailbox. Replaces the deprecated
 * /voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=syncToken, which
 * now fails (non-200). Mirrors profileComponentsPath: the outer `variables=(...)`
 * grammar stays literal; only the mailboxUrn VALUE is percent-encoded (its colons
 * must survive as %3A, exactly as the live browser sends them). `count` caps how
 * many conversations come back (not messages). `mailboxUrn` is the viewer's own
 * fsd_profile urn (see readMailboxUrn).
 */
export function messengerConversationsPath(mailboxUrn: string, count: number): string {
  const encoded = encodeURIComponent(mailboxUrn);
  const variables = `(mailboxUrn:${encoded},count:${count})`;
  return (
    `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${inboxQueryId()}` +
    `&queryName=MessengerConversationsBySyncToken&variables=${variables}`
  );
}

/** Detail read for ONE conversation's complete event history. The conversation
 * list endpoint intentionally returns compact snippets, so it is never used as
 * evidence that a prospect has not replied. Captured from the thread page's own
 * GraphQL request, this query accepts the full conversation urn as a value. */
export function messengerConversationEventsPath(threadUrn: string): string {
  // encodeURIComponent intentionally leaves parentheses literal, but the live
  // messengerMessages request percent-encodes the nested conversation urn's
  // delimiters. LinkedIn rejects the literal form with HTTP 400.
  const encoded = encodeURIComponent(threadUrn).replace(/\(/g, '%28').replace(/\)/g, '%29');
  const variables = `(conversationUrn:${encoded})`;
  return (
    `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${inboxMessagesQueryId()}` +
    `&variables=${variables}`
  );
}

/** The account's own /voyager/api/me endpoint: the oldest, stablest Voyager read,
 * used only to resolve the viewer's mailbox urn for the messenger query above. */
const ME_PATH = '/voyager/api/me';

/**
 * Resolve the viewer's own fsd_profile urn (the messenger mailboxUrn) for an
 * account's page. The modern messenger graphql query keys on this urn, which the
 * legacy LEGACY_INBOX read did not need. LOA_MAILBOX_URN overrides the /me read
 * as an escape hatch (single-account/debug); otherwise it is read live from
 * /voyager/api/me and parsed defensively by mailboxUrnFromMe. Throws when it
 * cannot be resolved so a messaging read fails loudly rather than querying the
 * wrong mailbox.
 */
async function readMailboxUrn(page: PagePort): Promise<string> {
  const override = process.env.LOA_MAILBOX_URN?.trim();
  if (override) return override;
  const { status, body } = await page.voyagerGet(ME_PATH, { accept: 'application/json' });
  if (status !== 200) {
    throw new Error(
      `voyager /me returned HTTP ${status}; cannot resolve the mailbox owner urn for a ` +
        `messaging read (set LOA_MAILBOX_URN to override)`,
    );
  }
  const urn = mailboxUrnFromMe(body);
  if (!urn) {
    throw new Error(
      'could not resolve the mailbox owner urn from /voyager/api/me ' +
        '(set LOA_MAILBOX_URN to override)',
    );
  }
  return urn;
}

/** Pull the viewer's fsd_profile urn out of a /voyager/api/me body. The response
 * carries the viewer's profile as an fsd_profile or (older) fs_miniProfile urn;
 * scan for either and re-wrap as the fsd_profile urn the messenger query keys on.
 * Exported for the ops shakeout / unit tests to run over a captured body. */
export function mailboxUrnFromMe(body: unknown): string | undefined {
  const json = JSON.stringify(body ?? '');
  const id =
    json.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/)?.[1] ??
    json.match(/urn:li:fs_miniProfile:([A-Za-z0-9_-]+)/)?.[1];
  return id ? `urn:li:fsd_profile:${id}` : undefined;
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
    const body = await this.readConversationList(accountId, limit);
    return normalizeInboxResponse(body).slice(0, limit);
  }

  async readThreads(accountId: string, limit: number): Promise<InboxThread[]> {
    const body = await this.readConversationList(accountId, limit);
    return normalizeInboxThreads(body).slice(0, limit);
  }

  async readThreadHistory(accountId: string, threadUrn: string): Promise<InboundMessage[]> {
    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    const { status, body } = await page.voyagerGet(messengerConversationEventsPath(threadUrn), {
      accept: 'application/json',
    });
    if (status !== 200) {
      throw new Error(
        `voyager conversation history returned HTTP ${status}; refusing to treat a thread as reply-free`,
      );
    }
    return normalizeThreadHistoryResponse(body, threadUrn);
  }

  private async readConversationList(accountId: string, limit: number): Promise<unknown> {
    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    const mailboxUrn = await readMailboxUrn(page);
    const { status, body } = await page.voyagerGet(messengerConversationsPath(mailboxUrn, limit), {
      accept: 'application/json',
    });
    if (status !== 200) {
      throw new Error(
        `voyager messaging returned HTTP ${status}; the session may be invalid or the inbox ` +
          `queryId stale (set LOA_INBOX_QUERY_ID to a current one)`,
      );
    }
    return body;
  }
}

/**
 * Walk a Voyager messaging conversations response into InboundMessage[]. Reads
 * BOTH the legacy shape (conversations with inlined `events[]`) and the modern
 * messenger graphql shape (conversations with `messages.elements[]` under a
 * `data.messengerConversations*` node); keeps only counterparty messages (a
 * message whose sender is not the viewer) and drops anything missing a thread
 * urn, sender urn, or text. Exported for the ops shakeout to run over a captured
 * raw payload.
 */
export function normalizeInboxResponse(body: unknown): InboundMessage[] {
  const root = body as VoyagerMessagingResponse | undefined;
  const conversations = collectConversations(root);

  const out: InboundMessage[] = [];
  for (const conv of conversations) {
    const threadUrn = conv?.entityUrn ?? conv?.backendUrn;
    if (!threadUrn) continue;
    const viewerUrn = viewerUrnFromConversation(conv);
    for (const event of eventsOf(conv)) {
      const msg = normalizeEvent(threadUrn, event, viewerUrn);
      if (msg) out.push(msg);
    }
  }
  // Most recent first, so a per-thread dedupe upstream keeps the latest reply.
  out.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return out;
}

/** Map a conversations-list payload to counterparty identities. Participant
 * data lives on the conversation, not the latest event, which is essential
 * when the account owner has replied after the prospect. */
export function normalizeInboxThreads(body: unknown): InboxThread[] {
  const root = body as VoyagerMessagingResponse | undefined;
  const out: InboxThread[] = [];
  for (const conv of collectConversations(root)) {
    const threadUrn = conv.entityUrn ?? conv.backendUrn;
    if (!threadUrn) continue;
    const viewerUrn = viewerUrnFromConversation(conv);
    const participant = participantFromConversation(conv, viewerUrn);
    if (!participant?.entityUrn) continue;
    const lastActivityAt = latestActivityOf(conv);
    out.push({
      threadUrn,
      participantUrn: participant.entityUrn,
      ...(participant.publicIdentifier
        ? { profileUrl: `https://www.linkedin.com/in/${participant.publicIdentifier}/` }
        : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
    });
  }
  return [...new Map(out.map((thread) => [thread.threadUrn, thread])).values()];
}

/** Normalize the dedicated events response. Some Voyager versions wrap events
 * inside a conversation; others return a flat elements array, so support both
 * without silently dropping a reply. */
export function normalizeThreadHistoryResponse(body: unknown, threadUrn: string): InboundMessage[] {
  const nested = normalizeInboxResponse(body).filter((message) => message.threadUrn === threadUrn);
  if (nested.length) return nested;
  const viewerUrn = threadUrn.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/)?.[0];
  const root = body as { elements?: MessagingEvent[]; data?: Record<string, unknown> };
  const events = [
    ...(root?.elements ?? []),
    ...(Array.isArray(root?.data?.elements) ? (root.data.elements as MessagingEvent[]) : []),
    ...Object.values(root?.data ?? {}).flatMap((value) => {
      const elements = (value as { elements?: unknown } | null | undefined)?.elements;
      return Array.isArray(elements) ? (elements as MessagingEvent[]) : [];
    }),
  ];
  const out: InboundMessage[] = [];
  for (const event of events) {
    const message = normalizeEvent(threadUrn, event, viewerUrn);
    if (message) out.push(message);
  }
  return out.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
}

/**
 * Gather conversation entities from every shape this endpoint (legacy or modern)
 * can return: the decorated `elements[]`, the normalized `data.elements`, the
 * flat `included[]`, and the modern graphql `data.<queryName>.elements` (e.g.
 * data.messengerConversationsBySyncToken.elements). The graphql query-name key
 * varies by build, so any object under `data` carrying an `elements` array is
 * treated as a conversation list.
 */
function collectConversations(root: VoyagerMessagingResponse | undefined): Conversation[] {
  if (!root) return [];
  const out: Conversation[] = [];
  if (Array.isArray(root.elements)) out.push(...root.elements);
  if (Array.isArray(root.data?.elements)) out.push(...(root.data?.elements ?? []));
  const data = root.data as Record<string, unknown> | undefined;
  if (data) {
    for (const value of Object.values(data)) {
      const elements = (value as { elements?: unknown } | null | undefined)?.elements;
      if (Array.isArray(elements)) out.push(...(elements as Conversation[]));
    }
  }
  const included = asConversations(root.included);
  if (included) out.push(...included);
  return out;
}

/** A conversation's messages across both shapes: legacy inlined `events[]` and
 * modern `messages.elements[]`. */
function eventsOf(conv: Conversation | undefined): MessagingEvent[] {
  return [...(conv?.events ?? []), ...(conv?.messages?.elements ?? [])];
}

/**
 * The newest event timestamp on a conversation list row, in either direction.
 *
 * Reads the same deliveredAt/createdAt the event normalizer uses, but WITHOUT
 * the outbound filter: this answers "has this thread moved", which our own send
 * moves just as much as a prospect's reply does. Undefined when no event carries
 * a usable number, so a caller cannot mistake "no timestamp" for "no change".
 */
function latestActivityOf(conv: Conversation | undefined): Date | undefined {
  let newest: number | undefined;
  for (const event of eventsOf(conv)) {
    const at = event.deliveredAt ?? event.createdAt;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (newest === undefined || at > newest) newest = at;
  }
  return newest === undefined ? undefined : new Date(newest);
}

/**
 * The viewer's own fsd_profile urn, derived from the conversation's own
 * entityUrn. The modern messenger conversation urn embeds the mailbox owner:
 * urn:li:msg_conversation:(urn:li:fsd_profile:<VIEWER>,<thread>). Reading it here
 * lets normalizeEvent tell the viewer's outbound messages apart without a
 * separate viewer-urn argument (the legacy shape carried an explicit
 * outbound/fromViewer flag instead). Undefined when the urn is not the wrapped
 * modern form, in which case the legacy flags are the only signal.
 */
function viewerUrnFromConversation(conv: Conversation | undefined): string | undefined {
  return conv?.entityUrn?.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/)?.[0];
}

/** Counterparty identity from the conversation's participant collection. The
 * modern and legacy payloads name this collection differently, so the small
 * structural type below exposes all known spellings. Fall back to any
 * counterparty event only for legacy responses that do not inline participants. */
function participantFromConversation(
  conv: Conversation,
  viewerUrn?: string,
): MessagingMiniProfile | undefined {
  const members = [
    ...(conv.participants ?? []),
    ...(conv.conversationParticipants ?? []),
    ...(conv.messagingMembers ?? []),
    ...(conv.participant ? [conv.participant] : []),
  ];
  const direct = members
    .map((member) => member.miniProfile ?? member)
    .map((member) => ({ ...member, entityUrn: profileUrnFromParticipant(member.entityUrn) }))
    .find((member) => member.entityUrn && member.entityUrn !== viewerUrn);
  if (direct?.entityUrn) return direct;
  for (const event of eventsOf(conv)) {
    const parsed = parseEvent(event, viewerUrn);
    if (parsed && !parsed.outbound) {
      return { entityUrn: parsed.senderUrn, publicIdentifier: parsed.publicId };
    }
  }
  return undefined;
}

/** The current messenger GraphQL list wraps a profile identity as
 * `urn:li:msg_messagingParticipant:urn:li:fsd_profile:<id>`. Normalize only
 * that wrapper, preserving legacy direct profile/member urns unchanged. */
function profileUrnFromParticipant(entityUrn: string | undefined): string | undefined {
  if (!entityUrn) return undefined;
  return (
    entityUrn.match(/urn:li:(?:fsd_profile|fs_miniProfile|member):[A-Za-z0-9_-]+/)?.[0] ?? entityUrn
  );
}

/** Pull EVENT/CONVERSATION entities out of a normalized `included[]` list (either
 * shape: legacy `events[]` or modern `messages.elements[]`). */
function asConversations(included: MessagingEntity[] | undefined): Conversation[] | undefined {
  if (!Array.isArray(included)) return undefined;
  return included.filter(
    (el) => Array.isArray(el?.events) || Array.isArray(el?.messages?.elements),
  );
}

/** One messaging event parsed to its essentials, direction kept. Used by both
 * the inbox reader (which drops outbound) and getConversation (which keeps
 * both). Null when the event carries no text or no identifiable sender. */
interface ParsedEvent {
  senderUrn: string;
  text: string;
  publicId?: string;
  receivedAt: Date;
  /** True when the account itself sent the message (viewer's own event). */
  outbound: boolean;
}

/**
 * Parse a single messaging event into its text/sender/direction. Kept separate
 * from normalizeEvent so getConversation can surface BOTH directions of a thread
 * while the inbox reader keeps only inbound. LinkedIn flags the viewer's own
 * events, but the exact flag varies by shape, so we defensively treat an explicit
 * `outbound`/`fromViewer` marker as outbound. // GUESS: verify against a real
 * payload.
 */
function parseEvent(event: MessagingEvent | undefined, viewerUrn?: string): ParsedEvent | null {
  if (!event) return null;
  // Legacy: eventContent.attributedBody.text / subject. Modern: body.text.
  const attributed = event.eventContent?.attributedBody?.text ?? event.subject ?? event.body?.text;
  const text = attributed?.trim();
  if (!text) return null; // non-text events (shares, reactions) carry no body.

  // Legacy: from.*.miniProfile.entityUrn. Modern: sender.hostIdentityUrn.
  const sender = event.from?.messagingMember?.miniProfile ?? event.from?.miniProfile;
  const senderUrn = sender?.entityUrn ?? event.from?.entityUrn ?? event.sender?.hostIdentityUrn;
  if (!senderUrn) return null;

  const publicId =
    sender?.publicIdentifier ??
    publicIdFromProfileUrl(event.sender?.participantType?.member?.profileUrl);
  const deliveredAt = event.deliveredAt ?? event.createdAt;
  return {
    senderUrn,
    text,
    ...(publicId ? { publicId } : {}),
    receivedAt: typeof deliveredAt === 'number' ? new Date(deliveredAt) : new Date(),
    // Legacy flags, or (modern) the sender is the mailbox owner derived from the
    // conversation urn. Either marks the message as the viewer's own.
    outbound:
      event.outbound === true ||
      event.from?.fromViewer === true ||
      (!!viewerUrn && senderUrn === viewerUrn),
  };
}

/** The /in/<publicId> tail of a modern messenger profileUrl, when present. */
function publicIdFromProfileUrl(url: string | undefined): string | undefined {
  return url?.match(/\/in\/([^/?#]+)/)?.[1];
}

function normalizeEvent(
  threadUrn: string,
  event: MessagingEvent | undefined,
  viewerUrn?: string,
): InboundMessage | null {
  const parsed = parseEvent(event, viewerUrn);
  if (!parsed) return null;
  // A message the account itself sent is outbound; the inbox reader skips it.
  if (parsed.outbound) return null;

  return {
    threadUrn,
    senderUrn: parsed.senderUrn,
    ...(parsed.publicId ? { profileUrl: `https://www.linkedin.com/in/${parsed.publicId}/` } : {}),
    text: parsed.text,
    receivedAt: parsed.receivedAt,
  };
}

// ---------------------------------------------------------------------------
// Conversation reading — one thread's full message history (both directions),
// for getConversation. Reuses the SAME messaging endpoint the inbox reader hits.
// ---------------------------------------------------------------------------

/** How many recent conversations getConversation scans for the target thread. */
const CONVERSATION_WINDOW = 40;

/**
 * Locate one thread in a Voyager messaging conversations payload and map its
 * events into a ConversationSummary (both inbound and outbound, oldest-first for
 * reading). Matches on either entityUrn or backendUrn. Returns null when the
 * thread is not present in the payload so the caller can throw a clear
 * not-found error naming the ref (silence is what this whole change fixes).
 * Exported for the ops shakeout to run over a captured raw body.
 */
export function normalizeConversation(
  body: unknown,
  threadRef: string,
): ConversationSummary | null {
  const root = body as VoyagerMessagingResponse | undefined;
  const conversations = collectConversations(root);

  for (const conv of conversations) {
    if (conv?.entityUrn !== threadRef && conv?.backendUrn !== threadRef) continue;
    const viewerUrn = viewerUrnFromConversation(conv);
    const messages: ConversationSummary['messages'] = [];
    for (const event of eventsOf(conv)) {
      const parsed = parseEvent(event, viewerUrn);
      if (!parsed) continue;
      messages.push({
        direction: parsed.outbound ? 'outbound' : 'inbound',
        body: parsed.text,
        at: parsed.receivedAt,
      });
    }
    // Oldest-first so the thread reads top-to-bottom like the LinkedIn UI.
    messages.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { threadRef, messages };
  }
  return null;
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
  const elements = root?.elements ?? root?.data?.elements ?? asConnectionElements(included);
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

function normalizeConnectionElement(el: ConnectionElement | undefined): AcceptedConnection | null {
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

  /**
   * A single person's profile, read live over the modern Voyager identity DASH
   * profile-components GraphQL query (the experience section):
   *   GET /voyager/api/graphql?queryId=voyagerIdentityDashProfileComponents.<hash>
   *       &variables=(tabIndex:0,sectionType:experience,profileUrn:<urn>,count:50)
   * This replaces the deprecated /voyager/api/identity/profiles/{id}/profileView,
   * which now returns HTTP 410 Gone. The request keys on the fsd_profile urn, so
   * the caller's search-result urn (bare or wrapped) is unwrapped by
   * profileIdFromUrn and re-wrapped as urn:li:fsd_profile:<id>.
   *
   * The USE CASE is ICP enrichment: the experience section carries the person's
   * CURRENT ROLE + CURRENT COMPANY and recent positions — signal beyond the
   * headline the search already provided. A single-profile read, so it does NOT
   * charge the search budget — but it still ensures the page is on the LinkedIn
   * origin first, like the other readers.
   */
  async getProfile(accountId: string, linkedinUrn: string): Promise<ProfileSummary> {
    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    const { status, body } = await page.voyagerGet(
      profileComponentsPath(profileIdFromUrn(linkedinUrn)),
      { accept: 'application/json' },
    );
    if (status !== 200) {
      throw new Error(
        `voyager profile-components returned HTTP ${status} for ${linkedinUrn}; the session ` +
          `may be invalid or the profile queryId stale (set LOA_PROFILE_QUERY_ID to a current one)`,
      );
    }
    return normalizeProfileResponse(body, linkedinUrn);
  }

  /**
   * One thread's message history (both directions), read live over the same
   * Voyager messaging endpoint the inbox reader uses. Scans the CONVERSATION_WINDOW
   * most recent conversations for the thread whose entityUrn/backendUrn matches
   * threadRef. A `pending:<accountId>:<targetId>` ref is an internal placeholder
   * for a not-yet-sent message — there is no LinkedIn thread yet, so we throw a
   * specific error rather than pretend. If the thread is simply not in the recent
   * window, we throw naming the ref and window size rather than returning an empty
   * conversation (silence is the bug this change fixes). Not a people-search, so it
   * does NOT charge the search budget.
   */
  async getConversation(accountId: string, threadRef: string): Promise<ConversationSummary> {
    if (threadRef.startsWith('pending:')) {
      throw new Error(
        `no LinkedIn thread exists yet for ${threadRef}: this is a pending (not-yet-sent) ` +
          `placeholder ref, so there is no conversation to read until the first message is sent`,
      );
    }
    const page = await this.pages.pageFor(accountId);
    await ensureOnLinkedIn(page);
    const mailboxUrn = await readMailboxUrn(page);
    const { status, body } = await page.voyagerGet(
      messengerConversationsPath(mailboxUrn, CONVERSATION_WINDOW),
      { accept: 'application/json' },
    );
    if (status !== 200) {
      throw new Error(
        `voyager messaging returned HTTP ${status}; the session may be invalid or the inbox ` +
          `queryId stale (set LOA_INBOX_QUERY_ID to a current one)`,
      );
    }
    const summary = normalizeConversation(body, threadRef);
    if (!summary) {
      throw new Error(
        `thread ${threadRef} was not found in the ${CONVERSATION_WINDOW} most recent ` +
          `conversations; it may be older than the window or the ref may be wrong`,
      );
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // These reads have no live backend yet. Rather than fall back to canned data
  // (which would poison real personalization), they throw a loud error so an MCP
  // caller knows the signal is unavailable in real mode.
  // -------------------------------------------------------------------------

  getRecentPosts(): Promise<PostSummary[]> {
    return notLive('getRecentPosts');
  }
  getPostEngagers(): Promise<EngagerSummary[]> {
    return notLive('getPostEngagers');
  }
  getCompanyJobs(): Promise<JobSummary[]> {
    return notLive('getCompanyJobs');
  }
}

function notLive(method: string): Promise<never> {
  return Promise.reject(
    new Error(
      `LiveObserve.${method} is not implemented yet; do not personalize from this tool ` +
        `in real mode (there is no live backend, so any data would be fabricated)`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Profile reading — one member's profileView -> ProfileSummary.
// ---------------------------------------------------------------------------

/**
 * The profile id for the identity endpoint. In this codebase linkedinUrn is
 * usually `urn:li:fsd_profile:<id>` (see profileUrnFromEntityUrn), whose tail is
 * the id the endpoint wants. A bare id or a public identifier (e.g. "dana-lopez")
 * is used as-is.
 */
export function profileIdFromUrn(linkedinUrn: string): string {
  return linkedinUrn.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/)?.[1] ?? linkedinUrn;
}

/**
 * The persisted-query id for the profile-components graphql call (the experience
 * section). Like DEFAULT_SEARCH_QUERY_ID, LinkedIn rotates this hash as it ships
 * new web builds; a stale hash eventually 400s. Override with LOA_PROFILE_QUERY_ID
 * once you capture a current one from a live browser's Network tab (the
 * voyagerIdentityDashProfileComponents.<hash> on a profile-page load). Default is
 * the current value captured in the maintained StaffSpy client (2025), which is
 * already cross-verified for people-search in this file.
 */
const DEFAULT_PROFILE_QUERY_ID =
  'voyagerIdentityDashProfileComponents.277ba7d7b9afffb04683953cede751fb';

function profileQueryId(): string {
  return process.env.LOA_PROFILE_QUERY_ID?.trim() || DEFAULT_PROFILE_QUERY_ID;
}

/**
 * Build the origin-relative /voyager/api/graphql path for one profile's
 * experience section. Mirrors buildVoyagerGraphqlPath (search): the outer
 * variables `(...)` grammar stays literal; only the profileUrn value is
 * percent-encoded (its colons must survive as %3A, exactly as the live browser
 * sends them). `id` is the fsd_profile urn tail, re-wrapped as the full urn the
 * query keys on.
 */
export function profileComponentsPath(id: string): string {
  const profileUrn = encodeURIComponent(`urn:li:fsd_profile:${id}`);
  const variables = `(tabIndex:0,sectionType:experience,profileUrn:${profileUrn},count:50)`;
  return (
    `/voyager/api/graphql?queryId=${profileQueryId()}` +
    `&queryName=ProfileComponentsBySectionType&variables=${variables}`
  );
}

/**
 * Walk a Voyager profile-components (experience section) response into a
 * ProfileSummary. Parsed defensively (every field optional) like the other
 * normalizers. The experience section carries positions but NOT the person's
 * name — the search result already supplied that — so `name` is left blank and
 * the summary's value is the structured experience: currentTitle, currentCompany
 * and the positions[] history. `headline` is synthesized from the current role
 * ("Title at Company") so a caller expecting one still gets a meaningful line.
 * The `raw` field carries the response's data slice for a caller that wants more
 * than the summarized fields. Exported for the ops shakeout to run over a
 * captured body.
 */
export function normalizeProfileResponse(body: unknown, linkedinUrn: string): ProfileSummary {
  const root = body as VoyagerProfileComponentsResponse | undefined;
  const positions = extractPositions(root);
  // Experiences come back most-recent first; prefer an explicitly ongoing role.
  const current = positions.find((p) => p.current) ?? positions[0];
  const currentTitle = current?.title;
  const currentCompany = current?.company;
  const headline =
    currentTitle && currentCompany
      ? `${currentTitle} at ${currentCompany}`
      : (currentTitle ?? currentCompany ?? '');
  return {
    linkedinUrn,
    handle: profileIdFromUrn(linkedinUrn),
    name: '',
    headline,
    ...(currentTitle ? { currentTitle } : {}),
    ...(currentCompany ? { currentCompany } : {}),
    ...(positions.length ? { positions } : {}),
    raw: (root?.data ?? root ?? {}) as unknown as ProfileSummary['raw'],
  };
}

/** Walk the profile-components experience tree into positions, most-recent
 * first. Handles both a single position and the grouped multi-role shape (one
 * company with several nested roles). */
function extractPositions(root: VoyagerProfileComponentsResponse | undefined): ProfilePosition[] {
  // Iterate EVERY top-level section element, not just the first: LinkedIn can
  // split the experience section across more than one element, and reading only
  // [0] would silently drop the later positions.
  const sections = root?.data?.identityDashProfileComponentsBySectionType?.elements ?? [];
  const elements = sections.flatMap(
    (s) => s?.components?.pagedListComponent?.components?.elements ?? [],
  );
  const out: ProfilePosition[] = [];
  for (const el of elements) {
    const entity = el?.components?.entityComponent;
    if (!entity) continue;

    // Grouped multi-role: this entity's title is the company, and each role
    // lives in a nested pagedListComponent. Its subtitle is the employment type.
    const nested =
      entity.subComponents?.components?.[0]?.components?.pagedListComponent?.components?.elements;
    if (Array.isArray(nested) && nested.length) {
      const company = componentText(entity.titleV2);
      for (const sub of nested) {
        const subEntity = sub?.components?.entityComponent;
        if (!subEntity) continue;
        const pos = makePosition(componentText(subEntity.titleV2), company, subEntity);
        if (pos) out.push(pos);
      }
      continue;
    }

    // Single position: subtitle is "Company · <employment type>".
    const company = splitCompany(textOf(entity.subtitle));
    const pos = makePosition(componentText(entity.titleV2), company, entity);
    if (pos) out.push(pos);
  }
  return out;
}

/** Assemble one ProfilePosition from a resolved title/company plus the entity's
 * caption (dates) and metadata (location). Null when it carries no title AND no
 * company (a blank card). */
function makePosition(
  title: string | undefined,
  company: string | undefined,
  entity: ProfileComponentEntity,
): ProfilePosition | null {
  if (!title && !company) return null;
  const dateRange = textOf(entity.caption);
  const location = textOf(entity.metadata);
  return {
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(dateRange ? { dateRange } : {}),
    ...(location ? { location } : {}),
    current: !!dateRange && /present/i.test(dateRange),
  };
}

/** titleV2 nests its text one level deeper than the flat text nodes:
 * `{ text: { text: "..." } }`. */
function componentText(node: { text?: TextNode } | undefined): string | undefined {
  return textOf(node?.text);
}

/** A subtitle like "Acme Corp · Full-time" carries the company before the
 * separator; take that, dropping a trailing employment-type token. */
function splitCompany(subtitle: string | undefined): string | undefined {
  if (!subtitle) return undefined;
  return subtitle.split(' · ')[0]?.trim() || undefined;
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
  /** Counterparty members carried on list rows, even where events contain only
   * the latest outbound snippet. The exact wrapper differs across Voyager
   * builds, hence the three optional spellings. */
  participants?: MessagingMember[];
  conversationParticipants?: MessagingMember[];
  messagingMembers?: MessagingMember[];
  participant?: MessagingMember;
  /** Legacy shape: events inlined on the conversation. */
  events?: MessagingEvent[];
  /** Modern messenger shape: messages under a paged list. */
  messages?: { elements?: MessagingEvent[] };
}

interface MessagingMiniProfile {
  entityUrn?: string;
  publicIdentifier?: string;
}

interface MessagingMember extends MessagingMiniProfile {
  miniProfile?: MessagingMiniProfile;
}

interface MessagingEvent {
  entityUrn?: string;
  createdAt?: number;
  deliveredAt?: number;
  /** LinkedIn's own marker for a message the viewer sent (legacy). */
  outbound?: boolean;
  subject?: string;
  from?: {
    entityUrn?: string;
    fromViewer?: boolean;
    miniProfile?: MessagingMiniProfile;
    messagingMember?: { miniProfile?: MessagingMiniProfile };
  };
  eventContent?: { attributedBody?: { text?: string } };
  /** Modern messenger shape: the message body and its sender. */
  body?: { text?: string };
  sender?: {
    /** The sender's fsd_profile urn. */
    hostIdentityUrn?: string;
    participantType?: { member?: { profileUrl?: string } };
  };
}

/** Any entity in the normalized `included[]`; only conversations carry events. */
type MessagingEntity = Conversation & Record<string, unknown>;

// --- identity profile-components response (profile reader) ----------------

/** One entity card in the experience section. titleV2/subtitle/caption/metadata
 * are display components; subComponents nests grouped multi-role positions.
 * Every field optional because the payload is large and versioned. */
interface ProfileComponentEntity {
  /** Job title (single) or company name (grouped): `{ text: { text } }`. */
  titleV2?: { text?: TextNode };
  /** Company + employment type (single) or employment type (grouped). */
  subtitle?: TextNode;
  /** Date/duration line, e.g. "Jan 2022 - Present · 2 yrs". */
  caption?: TextNode;
  /** Location line. */
  metadata?: TextNode;
  /** Grouped multi-role positions under one company. */
  subComponents?: {
    components?: Array<{ components?: { pagedListComponent?: ProfilePagedList } }>;
  };
}

/** A pagedListComponent wrapping a list of entity cards. Reused at the top level
 * (the section's positions) and nested (a company's grouped roles). */
interface ProfilePagedList {
  components?: {
    elements?: Array<{ components?: { entityComponent?: ProfileComponentEntity } }>;
  };
}

/** The graphql envelope for voyagerIdentityDashProfileComponents (experience). */
interface VoyagerProfileComponentsResponse {
  data?: {
    identityDashProfileComponentsBySectionType?: {
      elements?: Array<{ components?: { pagedListComponent?: ProfilePagedList } }>;
    };
  };
}

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
// The inbox reader (readInbox / normalizeInboxResponse) was migrated off the
// deprecated /voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX read
// (now fails non-200) to the modern messenger graphql query
// (/voyager/api/voyagerMessagingGraphQL/graphql, messengerConversations). It is
// UNPROVEN against a live payload from THIS account:
//   - The DEFAULT_INBOX_QUERY_ID hash is a best-effort default that could NOT be
//     captured live here (a stale hash 400s — capture a fresh
//     messengerConversations.<hash> from a /messaging/ load and set
//     LOA_INBOX_QUERY_ID).
//   - The mailbox resolution: readMailboxUrn reads /voyager/api/me and parses the
//     viewer's fsd_profile urn (mailboxUrnFromMe). LOA_MAILBOX_URN overrides it.
//   - The modern field names (messages.elements[].body.text, sender.hostIdentityUrn,
//     sender.participantType.member.profileUrl) and the viewer-urn-embedded-in-the-
//     conversation-urn outbound heuristic. normalizeInboxResponse still handles the
//     LEGACY shape too, and is exported so the ops shakeout can dump a raw body and
//     adjust the names. getConversation shares this endpoint and the same parseEvent
//     parser, so it inherits the same unverified field names (plus the
//     entityUrn/backendUrn thread-match).
//
// The profile reader (getProfile / normalizeProfileResponse) was migrated off
// the DEPRECATED /voyager/api/identity/profiles/{id}/profileView (now HTTP 410
// Gone) to the modern voyagerIdentityDashProfileComponents graphql query
// (sectionType:experience), grounded in the maintained StaffSpy client. UNPROVEN
// against a live payload from THIS account: the DEFAULT_PROFILE_QUERY_ID hash
// (a stale hash 400s — capture a fresh voyagerIdentityDashProfileComponents.<hash>
// and set LOA_PROFILE_QUERY_ID) and the component field names (titleV2.text.text,
// subtitle/caption/metadata.text, the pagedListComponent nesting, grouped
// multi-role subComponents). Run the profile shakeout (src/tools/profile-shakeout.ts)
// to dump a raw body and confirm; normalizeProfileResponse is exported so it can
// run the real normalizer over the captured payload.
//
// The connections reader (readConnections / normalizeConnectionsResponse) is
// VERIFIED live 2026-07-10 against the seeded account: the legacy
// /voyager/api/relationships/connections REST path returns HTTP 400, so it now
// uses /voyager/api/relationships/dash/connections with the
// ConnectionListWithProfile decoration and parses the normalized
// data.*elements + included[Connection|Profile] shape. The only rotatable piece
// is the decoration version (LOA_CONNECTIONS_DECORATION_ID overrides the default).
