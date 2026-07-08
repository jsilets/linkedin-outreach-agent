// Identity matcher shared by the reply tick and the acceptance tick. Both map a
// LinkedIn person (a message sender, or a newly-accepted connection) back to an
// enrolled target by comparing every identity we can: exact urn, urn-tail id, and
// /in/ vanity slug. A target's linkedinUrn is either a urn (urn:li:person:... /
// urn:li:fsd_profile:...) or a profile url captured at sourcing.

import type { db as shared } from '@loa/shared';

type TargetRow = shared.TargetRow;

/**
 * Stable person id from a urn, lowercased for comparison. LinkedIn stamps the
 * same opaque member id (the "ACoAA..." token) inside every person urn shape, so
 * pull that token out and compare on it. This matters because a sourced target's
 * linkedinUrn is often the search wrapper
 * `urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAA...,SEARCH_SRP,DEFAULT)`
 * while an accepted connection or a message sender carries a bare
 * `urn:li:fsd_profile:ACoAA...` / `urn:li:member:...`. A naive last-colon slice
 * would keep the wrapper's trailing `,SEARCH_SRP,DEFAULT` and never match, so
 * extract the first entity-typed id token when present.
 */
export function urnTail(urn: string): string {
  const token = urn.match(/(?:fsd_profile|fs_miniProfile|miniProfile|member|person):([\w-]+)/i);
  if (token?.[1]) return token[1].toLowerCase();
  // Fallback for other forms: last colon segment, parens/quotes stripped.
  const inner = urn.includes(':') ? urn.slice(urn.lastIndexOf(':') + 1) : urn;
  return inner.replace(/[()"]/g, '').toLowerCase();
}

/** The /in/ profile url a sourced target carries in its enrichment blob, if any.
 * add_targets stores the profileUrl there (the targets row itself only has the
 * urn), so it is the most reliable cross-surface key: vanity slugs are stable
 * where opaque member ids can differ by API surface. */
function targetProfileUrl(target: TargetRow): string | undefined {
  const ctx = target.externalContext as { profileUrl?: unknown } | null | undefined;
  return typeof ctx?.profileUrl === 'string' ? ctx.profileUrl : undefined;
}

/** /in/<slug> vanity from a profile url, lowercased. */
export function vanityOf(url: string): string | undefined {
  const m = url.match(/\/in\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]).toLowerCase() : undefined;
}

/**
 * True if a LinkedIn identity (a person urn plus an optional /in/ profile url) is
 * this target. Match on any identity we can compare: exact urn, urn-tail id, or
 * vanity slug.
 */
export function matchesIdentity(
  urn: string,
  profileUrl: string | undefined,
  target: TargetRow,
): boolean {
  const ref = target.linkedinUrn.trim();
  const idTail = urnTail(urn);
  const refTail = urnTail(ref);
  if (idTail && idTail === refTail) return true;

  // Compare vanity slugs when either side is a profile url. The ref vanity comes
  // from the urn itself when it is a /in/ url, else from the enrichment blob's
  // profileUrl (the common case for a sourced target whose urn is a wrapper).
  const refUrl = ref.includes('/in/') ? ref : targetProfileUrl(target);
  const refVanity = refUrl ? vanityOf(refUrl) : undefined;
  const idVanity = profileUrl ? vanityOf(profileUrl) : undefined;
  if (refVanity && idVanity && refVanity === idVanity) return true;
  // The ref may be a bare public id and the identity a matching /in/ vanity.
  if (idVanity && refTail && idVanity === refTail) return true;
  if (refVanity && idTail && refVanity === idTail) return true;
  return false;
}
