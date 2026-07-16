// Sent-invitation Voyager surface: the paginated read of an account's own
// pending outgoing invites, plus the withdraw action. Lives in account-runner
// (not runtime) so BOTH consumers can share one path builder + normalizer: the
// executor's withdrawInvite (account-runner) and the runtime's live reader.
// Package direction is one-way — runtime depends on account-runner — so this is
// the only place the two can meet.
//
// The invitation-manager page is infinite-scroll; we bypass its DOM entirely by
// calling the paginated endpoint behind it, so a full read sees EVERY pending
// invite (campaign-sent and manually-sent alike), not just the rendered rows.

import type { PagePort } from '../ports.js';

/** One pending outgoing invitation, resolved against its invitee profile. */
export interface SentInvitation {
  /** urn:li:invitation:<id> (legacy) or urn:li:fsd_invitation:<id> (dash). */
  invitationUrn: string;
  /** The invitee's profile urn, when the payload resolves one. */
  inviteeUrn?: string;
  /** The invitee's /in/ vanity slug, when present. */
  publicIdentifier?: string;
  /** https://www.linkedin.com/in/<publicId>/ when a vanity is known. */
  profileUrl?: string;
  /** Full name (firstName + lastName), when present. */
  name?: string;
  /** When the invite was sent (sentTime). Absent when the payload omits it —
   *  callers must NOT age-filter an invite whose sentAt is unknown. */
  sentAt?: Date;
  /** The custom note attached to the invite, when the inviter added one. */
  message?: string;
}

/**
 * The legacy Rest.li path that lists an account's OWN sent invitations. Distinct
 * from the received-invitations feed by `q=invitationType`. Multiple maintained
 * clients still call this exact path. It is a LEGACY REST surface, and LinkedIn
 * has been retiring legacy relationships paths (the connections one already
 * 400s), so the base path is overridable with LOA_SENT_INVITATIONS_PATH to
 * reroute a live 400 (e.g. onto a dash graphql surface) without a code change.
 * The normalizer already tolerates the dash-normalized response shape. Captured
 * 2026-07-15.
 */
const DEFAULT_SENT_INVITATIONS_PATH = '/voyager/api/relationships/sentInvitationViewsV2';

function sentInvitationsBasePath(): string {
  return process.env.LOA_SENT_INVITATIONS_PATH?.trim() || DEFAULT_SENT_INVITATIONS_PATH;
}

/** Build the paginated sent-invitations request for one page. */
export function sentInvitationsPath(start: number, count: number): string {
  return (
    `${sentInvitationsBasePath()}` +
    `?q=invitationType&invitationType=CONNECTION&start=${start}&count=${count}`
  );
}

/**
 * The dash action base the current web UI fires to withdraw an invite. The
 * numeric id is re-wrapped as an fsd_invitation urn and URL-encoded onto the
 * path. Overridable with LOA_WITHDRAW_INVITATIONS_PATH if LinkedIn moves the
 * action. Captured 2026-07-15.
 */
const DEFAULT_WITHDRAW_INVITATIONS_PATH = '/voyager/api/voyagerRelationshipsDashInvitations';

function withdrawInvitationsBasePath(): string {
  return process.env.LOA_WITHDRAW_INVITATIONS_PATH?.trim() || DEFAULT_WITHDRAW_INVITATIONS_PATH;
}

/** The numeric id at the tail of an invitation urn (either urn form). */
export function invitationIdFromUrn(invitationUrn: string): string {
  const m = invitationUrn.match(/invitation:(\d+)/);
  if (m?.[1]) return m[1];
  // Fallback: last colon segment, stripped of any urn wrapper punctuation.
  const inner = invitationUrn.includes(':')
    ? invitationUrn.slice(invitationUrn.lastIndexOf(':') + 1)
    : invitationUrn;
  return inner.replace(/[()"]/g, '');
}

/** Build the withdraw POST path for one invite, keyed by its numeric id. */
export function withdrawInvitationPath(numericId: string): string {
  const urn = encodeURIComponent(`urn:li:fsd_invitation:${numericId}`);
  return `${withdrawInvitationsBasePath()}/${urn}?action=withdraw`;
}

/** The body the withdraw action expects. */
export const WITHDRAW_INVITATION_BODY = { invitationType: 'CONNECTION' } as const;

/** The normalized accept header the list endpoint speaks; tolerate plain too. */
const NORMALIZED_ACCEPT = 'application/vnd.linkedin.normalized+json+2.1';

/** Page size per read; clients use 10-100. */
const SENT_INVITATIONS_PAGE_SIZE = 100;
/** Hard ceiling on paginated reads, so a runaway loop cannot page forever. */
const SENT_INVITATIONS_CEILING = 1000;

/**
 * Read an account's pending sent invitations by paging the endpoint until a
 * short page arrives, the caller's limit is met, or the safety ceiling is hit.
 * The page must already be on https://www.linkedin.com so the session cookies
 * attach to the same-origin fetch (the runtime reader ensures this first). A
 * non-200 on the FIRST page is a hard failure (stale path / bad session); later
 * pages just stop pagination. Server order is preserved; callers sort by sentAt.
 */
export async function readSentInvitations(
  page: Pick<PagePort, 'voyagerGet'>,
  opts: { limit?: number } = {},
): Promise<SentInvitation[]> {
  const limit = opts.limit ?? SENT_INVITATIONS_CEILING;
  const out: SentInvitation[] = [];
  for (
    let start = 0;
    start < SENT_INVITATIONS_CEILING && out.length < limit;
    start += SENT_INVITATIONS_PAGE_SIZE
  ) {
    const { status, body } = await page.voyagerGet(
      sentInvitationsPath(start, SENT_INVITATIONS_PAGE_SIZE),
      { accept: NORMALIZED_ACCEPT },
    );
    if (status !== 200) {
      if (out.length === 0) {
        throw new Error(
          `voyager sent-invitations returned HTTP ${status}; the session may be invalid ` +
            `or the legacy path retired (set LOA_SENT_INVITATIONS_PATH to a current one)`,
        );
      }
      break;
    }
    const pageItems = normalizeSentInvitationsResponse(body);
    for (const inv of pageItems) {
      out.push(inv);
      if (out.length >= limit) break;
    }
    if (pageItems.length < SENT_INVITATIONS_PAGE_SIZE) break; // last page
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

interface MiniProfileEntity {
  entityUrn?: string;
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  occupation?: string;
}

interface InvitationEntity {
  entityUrn?: string;
  $type?: string;
  _type?: string;
  /** Epoch ms the invite was sent. */
  sentTime?: number;
  /** The custom note, when one was attached. */
  message?: string;
  /** Normalized shape: a urn ref into included[]; decorated shape: inline. */
  invitee?:
    | string
    | {
        '*miniProfile'?: string;
        miniProfile?: MiniProfileEntity;
      };
  /** Alternate resolution reference some builds carry. */
  '*inviteeResolutionResult'?: string;
  inviteeResolutionResult?: MiniProfileEntity;
}

interface SentInvitationsResponse {
  elements?: InvitationEntity[];
  data?: {
    elements?: InvitationEntity[];
    /** Ordered invitation urns in the normalized dash shape. */
    '*elements'?: string[];
  };
  included?: Array<InvitationEntity & MiniProfileEntity>;
}

/**
 * True when an included[] entity is a real Invitation (carries sentTime +
 * invitee), NOT the SentInvitationViewV2 wrapper that `data.*elements` points to.
 * Verified live 2026-07-16: the normalized response inlines BOTH a
 * `…invitation.Invitation` entity (sentTime, invitee, the invitation urn) and a
 * `…invitation.SentInvitationViewV2` wrapper (no sentTime); `*elements` lists the
 * wrappers, so keying off it loses the timestamp. Match the `.Invitation` $type
 * (which excludes `.SentInvitationViewV2`) or the sentTime+invitee pair.
 */
function isInvitationEntity(el: (InvitationEntity & MiniProfileEntity) | undefined): boolean {
  if (!el) return false;
  const t = el.$type ?? el._type ?? '';
  if (typeof t === 'string' && t.endsWith('.Invitation')) return true;
  return typeof el.sentTime === 'number' && el.invitee != null;
}

/**
 * Walk a sent-invitations response into SentInvitation[]. Handles both shapes:
 *   - normalized (live): `included[]` holds the real `…invitation.Invitation`
 *     entities (sentTime + invitee) alongside SentInvitationViewV2 wrappers and
 *     MiniProfiles; we pick the Invitation entities directly (NOT via
 *     `data.*elements`, which lists the timestamp-less wrappers) and resolve each
 *     invitee's `*miniProfile` through included[].
 *   - decorated REST: `elements[]` are Invitations with an inline
 *     `invitee.miniProfile`.
 * Exported for the ops shakeout and unit tests.
 */
export function normalizeSentInvitationsResponse(body: unknown): SentInvitation[] {
  const root = body as SentInvitationsResponse | undefined;

  const included = root?.included;
  const byUrn = new Map<string, InvitationEntity & MiniProfileEntity>();
  if (Array.isArray(included)) {
    for (const el of included) if (el?.entityUrn) byUrn.set(el.entityUrn, el);
  }

  // Prefer the real Invitation entities inlined in included[] (they carry
  // sentTime); then the decorated `elements[]`; then the ordered `*elements` as a
  // last resort for a shape that only carries the wrappers.
  const realInvitations = (included ?? []).filter(isInvitationEntity);
  const order = root?.data?.['*elements'];
  let invitations: InvitationEntity[];
  if (realInvitations.length) {
    invitations = realInvitations;
  } else if (Array.isArray(root?.elements)) {
    invitations = root.elements;
  } else if (Array.isArray(root?.data?.elements)) {
    invitations = root.data.elements;
  } else if (Array.isArray(order)) {
    invitations = order.map((u) => byUrn.get(u)).filter((e): e is InvitationEntity => !!e);
  } else {
    invitations = [];
  }

  const out: SentInvitation[] = [];
  for (const inv of invitations) {
    const normalized = normalizeInvitation(inv, byUrn);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** Resolve one Invitation entity against included[] into a SentInvitation. */
function normalizeInvitation(
  inv: InvitationEntity | undefined,
  byUrn: Map<string, InvitationEntity & MiniProfileEntity>,
): SentInvitation | null {
  if (!inv?.entityUrn) return null;

  // The invitee mini-profile may be inline (decorated) or a urn ref (normalized).
  let profile: MiniProfileEntity | undefined;
  let inviteeUrn: string | undefined;
  const invitee = inv.invitee;
  if (typeof invitee === 'string') {
    inviteeUrn = invitee;
    profile = byUrn.get(invitee);
  } else if (invitee) {
    if (invitee.miniProfile) profile = invitee.miniProfile;
    if (typeof invitee['*miniProfile'] === 'string') {
      inviteeUrn = invitee['*miniProfile'];
      profile = profile ?? byUrn.get(invitee['*miniProfile']);
    }
  }
  if (!profile) {
    const ref = inv['*inviteeResolutionResult'];
    if (typeof ref === 'string') {
      inviteeUrn = inviteeUrn ?? ref;
      profile = byUrn.get(ref);
    } else if (inv.inviteeResolutionResult) {
      profile = inv.inviteeResolutionResult;
    }
  }

  const publicId = profile?.publicIdentifier;
  const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
  return {
    invitationUrn: inv.entityUrn,
    ...(profile?.entityUrn || inviteeUrn ? { inviteeUrn: profile?.entityUrn ?? inviteeUrn } : {}),
    ...(publicId ? { publicIdentifier: publicId } : {}),
    ...(publicId ? { profileUrl: `https://www.linkedin.com/in/${publicId}/` } : {}),
    ...(name ? { name } : {}),
    ...(typeof inv.sentTime === 'number' ? { sentAt: new Date(inv.sentTime) } : {}),
    ...(inv.message ? { message: inv.message } : {}),
  };
}
