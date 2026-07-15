// Canonical LinkedIn person identity.
//
// A people-search result's entityUrn wraps the stable profile urn with volatile
// tracking context, e.g.
//   urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAA123,SEARCH_SRP,DEFAULT)
// The bare `urn:li:fsd_profile:ACoAA123` is the person; the SEARCH_SRP/DEFAULT
// tail changes with the surface the card came from. Keying dedup or suppression
// on the wrapped form means the same person sourced via a different flow gets a
// different key and dedup silently fails. Every storage path that keys on a
// person must first pass the urn through here.

/**
 * The stable identity key for a person: the bare `urn:li:fsd_profile:<id>` when
 * the input carries one (wrapped or already bare), else the input unchanged. A
 * dev/manual ref (`urn:li:person:...`), a member urn, or a profile url has no
 * fsd_profile token and passes through as-is, so those identities stay stable
 * too. Idempotent: canonicalProfileKey(canonicalProfileKey(x)) === canonicalProfileKey(x).
 *
 * Mirrors the extraction in the runtime's profileUrnFromEntityUrn /
 * profileIdFromUrn (observe-live) and the urnTail matcher, which already read
 * this same token out of either form.
 */
export function canonicalProfileKey(urn: string): string {
  return urn.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/)?.[0] ?? urn;
}

/**
 * Whether a display name is a LinkedIn-truncated stub rather than a real name.
 *
 * LinkedIn abbreviates the surname of people outside your network ("R S.",
 * "Joe D.", "Sarab S."), so a lead sourced from search carries the stub, not the
 * name. Once the invite is accepted the person is 1st-degree and their full name
 * becomes visible, so the stub is only ever a stale artifact of how the lead was
 * sourced.
 *
 * This matters because the message composer addresses the recipient by typing
 * the name into LinkedIn's typeahead: a stub finds nobody (or, worse, is short
 * enough to substring-match a stranger). Callers use this to decide when a
 * stored name must be refreshed from an authoritative 1st-degree source.
 *
 * Matches a trailing single-letter initial with a period ("Joe D.", "R S."), the
 * shape LinkedIn actually emits. A real surname, an initial WITHOUT a period
 * ("Malcolm X"), and a credential suffix ("Priya Raman, P.Eng.") are all
 * left alone.
 */
export function isTruncatedName(name: string | null | undefined): boolean {
  const n = name?.trim();
  if (!n) return false;
  return /\s[A-Za-z]\.$/.test(n);
}
