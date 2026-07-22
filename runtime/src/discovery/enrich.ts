// Company enrichment from the real profile. The free-tier people-search returns
// only a freeform headline, so sourcing has to GUESS a company out of it
// (extractCompany). That guess is wrong in two ways that matter: a headline like
// "COO @ aetherEV, ex. Tesla" makes us think the person is at Tesla (a former
// employer), and a headline with no company at all leaves us blind. Neither is a
// safe basis for an ICP decision or a "{Company}" merge in a message.
//
// The authoritative value is the current position on the person's profile. This
// module resolves it from get_profile's parsed experience section and stamps a
// provenance flag so downstream code can tell a real company from a guess.
//
// Cost: get_profile is a live fetch, so we never run this over bulk discovery.
// It runs at the scoring gate (a curated list of tens) and only for members not
// already profile-verified, so re-runs are cheap.

import type { ObservePort, ProfilePosition, ProfileSummary } from '@loa/mcp';

/** Provenance stamp on a target/member's currentCompany. 'profile' = read off
 * the current position on the real profile; 'headline' = guessed from the search
 * headline (never trusted for a message merge). Stored in external_context. */
export const COMPANY_SOURCE_PROFILE = 'profile';
export const COMPANY_SOURCE_HEADLINE = 'headline';

/** The verified current role, resolved from a profile's experience section. */
export interface EnrichedCompany {
  currentCompany?: string;
  currentTitle?: string;
  /** Always 'profile' — the whole point is that this came off the real profile. */
  companySource: typeof COMPANY_SOURCE_PROFILE;
}

/** Pick the position that represents the person's CURRENT employer. Prefers a
 * position explicitly flagged current ("Present"); falls back to the first
 * (most-recent) position when none is flagged. Returns undefined for an empty
 * experience section. Exported for unit tests. */
export function resolveCurrentPosition(
  positions: ProfilePosition[] | undefined,
): ProfilePosition | undefined {
  if (!positions || positions.length === 0) return undefined;
  return positions.find((p) => p.current) ?? positions[0];
}

/** Derive the verified company/title from a profile summary. Prefers the current
 * position (the honest "where do they work NOW" answer); falls back to the
 * profile's own currentCompany/currentTitle fields when the experience section
 * did not parse into positions. Exported for unit tests. */
export function companyFromProfile(profile: ProfileSummary): EnrichedCompany {
  const pos = resolveCurrentPosition(profile.positions);
  const currentCompany = (pos?.company ?? profile.currentCompany ?? '').trim();
  const currentTitle = (pos?.title ?? profile.currentTitle ?? '').trim();
  return {
    ...(currentCompany ? { currentCompany } : {}),
    ...(currentTitle ? { currentTitle } : {}),
    companySource: COMPANY_SOURCE_PROFILE,
  };
}

/** Resolves the current company for a lead from its real profile. */
export interface CompanyEnricher {
  /** Return the profile-verified company/title for a lead, or null when it
   * cannot be resolved (no operating account, or the live read failed). A null
   * must never block the caller — it falls back to whatever it already had.
   * Pass accountId when the caller knows the sender (enroll); omit it to resolve
   * the single operating account (scoring, which is account-agnostic). */
  enrich(linkedinUrn: string, accountId?: string): Promise<EnrichedCompany | null>;
}

/** CompanyEnricher backed by the live observe port. Uses the caller's accountId
 * when given, else resolves the operating account (single-op runtime: the
 * first/only sender), reads the profile, and derives the current company. Any
 * failure returns null rather than throwing, so one unreadable profile never
 * sinks a whole scoring or enroll batch. */
export class ProfileCompanyEnricher implements CompanyEnricher {
  constructor(
    private readonly observe: Pick<ObservePort, 'getProfile'>,
    private readonly resolveAccountId: () => Promise<string | undefined>,
  ) {}

  async enrich(linkedinUrn: string, accountId?: string): Promise<EnrichedCompany | null> {
    const acct = accountId ?? (await this.resolveAccountId());
    if (!acct) return null;
    try {
      const profile = await this.observe.getProfile(acct, linkedinUrn);
      const enriched = companyFromProfile(profile);
      // No company AND no title means the read gave us nothing usable; treat it
      // as a miss so the caller keeps whatever it already had.
      if (!enriched.currentCompany && !enriched.currentTitle) return null;
      return enriched;
    } catch {
      return null;
    }
  }
}
