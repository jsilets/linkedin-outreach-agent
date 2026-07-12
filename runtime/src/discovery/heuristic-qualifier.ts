// HeuristicQualifier: the offline, deterministic scorer behind score_list (the
// keyless fallback path). No network, no key. It reads only the fields a people
// search already returns (headline, company, location, degree) and scores them
// against the ICP's structured attributes plus a free-text description overlap.
//
// Model: a Bayesian-flavored log-odds sum. Start at even odds (logit 0 => 50).
// Each positive attribute hit adds weight; a miss subtracts a little; a negative
// attribute hit subtracts a lot. Description terms found in the candidate text
// nudge up. The logit is squashed to 0..100 with a logistic. Everything is a
// pure function of (candidate, icp), so the score is stable and testable.

import type { Candidate, Icp, IcpField, LeadScore, QualifierPort } from './types.js';

const MODEL = 'heuristic-v1';

// Contribution weights (log-odds). Tuned so a couple of solid hits clear 70 and
// a disqualifier sinks a candidate regardless of other matches.
const HIT = 1.5;
const MISS = -0.6;
const NEGATIVE_HIT = -3;
const DEGREE_BONUS: Record<string, number> = { '1st': 0.3, '2nd': 0.1, '3rd': -0.1 };

/** Words too common to carry ICP signal; dropped from description matching. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'who',
  'are',
  'our',
  'their',
  'from',
  'into',
  'have',
  'has',
  'not',
  'you',
  'your',
  'they',
  'them',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'at',
  'or',
  'is',
  'as',
  'by',
  'be',
  'we',
  'us',
  'it',
  'ideal',
  'customer',
  'profile',
  'company',
  'companies',
  'people',
  'person',
  'lead',
  'leads',
  'role',
  'roles',
]);

/** The candidate text an ICP field is matched against. */
function fieldText(candidate: Candidate, field: IcpField): string {
  const headline = candidate.headline ?? '';
  const company = candidate.currentCompany ?? '';
  const location = candidate.location ?? '';
  switch (field) {
    case 'title':
    case 'seniority':
      return headline;
    case 'company':
      return `${company} ${headline}`;
    case 'location':
      return location;
    case 'industry':
      return `${headline} ${company}`;
    default:
      return headline;
  }
}

/** First match term found as a case-insensitive substring, or undefined. */
function firstMatch(haystack: string, terms: string[]): string | undefined {
  const hay = haystack.toLowerCase();
  for (const t of terms) {
    const needle = t.trim().toLowerCase();
    if (needle && hay.includes(needle)) return t.trim();
  }
  return undefined;
}

function logistic(logit: number): number {
  return Math.round(100 / (1 + Math.exp(-logit)));
}

export class HeuristicQualifier implements QualifierPort {
  async score(candidate: Candidate, icp: Icp): Promise<LeadScore> {
    const attributes = icp.attributes ?? [];
    const hasDescription = !!icp.description?.trim();

    // No criteria at all: nothing to judge against, stay neutral rather than
    // inventing a rank.
    if (attributes.length === 0 && !hasDescription) {
      return { score: 50, reasons: ['no ICP criteria to score against'], model: MODEL };
    }

    let logit = 0;
    const reasons: string[] = [];

    for (const attr of attributes) {
      const weight = attr.weight ?? 1;
      const matched = firstMatch(fieldText(candidate, attr.field), attr.match);
      if (attr.negative) {
        if (matched) {
          logit += NEGATIVE_HIT * weight;
          reasons.push(`disqualifier: ${attr.field} matches "${matched}"`);
        }
        // A negative miss is the desired state; stay silent.
      } else if (matched) {
        logit += HIT * weight;
        reasons.push(`${attr.field} matches "${matched}"`);
      } else {
        logit += MISS * weight;
      }
    }

    if (hasDescription) {
      const hay =
        `${candidate.headline ?? ''} ${candidate.currentCompany ?? ''} ${candidate.location ?? ''}`.toLowerCase();
      const terms = [
        ...new Set(
          icp
            .description!.toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
        ),
      ];
      if (terms.length > 0) {
        const hits = terms.filter((t) => hay.includes(t));
        const frac = hits.length / terms.length;
        // Center at 0.3 overlap so a partial match is roughly neutral.
        logit += (frac - 0.3) * 1.2;
        if (hits.length > 0) reasons.push(`ICP terms: ${hits.slice(0, 3).join(', ')}`);
      }
    }

    if (candidate.degree && DEGREE_BONUS[candidate.degree] !== undefined) {
      logit += DEGREE_BONUS[candidate.degree]!;
    }

    const score = logistic(logit);
    if (reasons.length === 0) reasons.push('no ICP attributes matched');
    return { score, reasons, model: MODEL };
  }
}
