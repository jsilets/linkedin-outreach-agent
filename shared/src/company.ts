// Conservative company extraction from a LinkedIn headline.
//
// LinkedIn people-search (free tier) rarely fills a structured company, but the
// company is usually named in the headline: "… at Meridian", "… @ Globex",
// "Head of Ops at Evergreen Retail US | …". This pulls that name out for the
// {Company} merge token and for auto-classifying sourced leads.
//
// The bar is HONESTY over coverage: only return a company when a strong marker
// ("at X" / "@ X") makes it unambiguous. When there is no such marker, return
// undefined so the caller omits the company reference rather than guessing.

/** Words that are connectors inside a proper-noun company name (kept). */
const CONNECTORS = /^(of|and|the|for|&|-)$/i;

/** Delimiters that end the company span within a headline segment. */
const SEGMENT_DELIMITERS = /[|•·–—,]|\.\s|\s[-–—]\s|\s\(|:/;

/**
 * Extract a company name from a headline, or undefined when none is clearly
 * marked. Keys on the LAST "at"/"@" marker (the current employer usually sits
 * at the end, e.g. "Manager, O&M – Field Service | Fleet Reliability | Globex Energy"
 * has no marker, but "… at MN8 Energy" would). Exported for unit tests.
 */
export function extractCompany(headline: string | null | undefined): string | undefined {
  if (!headline) return undefined;
  const h = headline.replace(/\s+/g, ' ').trim();

  // All "at X" / "@ X" markers; take the last (most likely the employer).
  const marker = /(?:\bat\s+|@\s*)([A-Za-z0-9][^\n]*)/g;
  let m: RegExpExecArray | null;
  let tail: string | undefined;
  while ((m = marker.exec(h)) !== null) tail = m[1];
  if (!tail) return undefined;

  // Cut the tail at the first segment delimiter (pipe, bullet, dash-separator,
  // sentence end, parenthesis, colon).
  const span = tail.split(SEGMENT_DELIMITERS)[0]?.trim() ?? '';
  if (!span) return undefined;

  // Keep a proper-noun run: capitalized/numeric tokens plus small connectors.
  // Stop at the first lowercase word that is not a connector ("at Tesla making
  // the world better" -> "Tesla"). Cap the length so a run-on headline can't
  // swallow a whole clause.
  const words = span.split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    // A standalone "I" is used as a pipe-substitute separator ("Rivian I PG&E").
    if (w === 'I') break;
    // A name token starts with a letter/digit AND carries an uppercase letter:
    // accepts Title Case ("Shell"), all-caps ("EVSTART"), and camelCase brands
    // ("eVerged", "aetherEV"); rejects lowercase filler ("making", "the").
    const isProper = /^[A-Za-z0-9]/.test(w) && /[A-Z0-9]/.test(w);
    const isConnector = CONNECTORS.test(w);
    if (!isProper && !isConnector) break;
    // A trailing connector shouldn't extend the name ("Shell and" -> "Shell").
    if (isConnector && kept.length === 0) break;
    kept.push(w);
    if (kept.length >= 6) break;
  }
  // Drop a dangling connector at the end ("Rivian and" -> "Rivian").
  while (kept.length && CONNECTORS.test(kept[kept.length - 1]!)) kept.pop();

  const company = kept.join(' ').replace(/[.,&\s]+$/, '').trim();
  // Reject too-short or non-alphabetic residue.
  if (company.length < 2 || !/[A-Za-z]/.test(company)) return undefined;
  return company;
}
