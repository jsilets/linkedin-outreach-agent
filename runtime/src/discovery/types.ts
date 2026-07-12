// Discovery feeder types. The ICP shape is defined in @loa/mcp (it crosses the
// tool boundary); everything here is runtime-internal to the feeder: the
// candidate shape a data source yields, the score a qualifier returns, and the
// two ports the feeder depends on.

import type { Icp } from '@loa/mcp';
import type { Json } from '@loa/shared';

export type { Icp, IcpField } from '@loa/mcp';

/**
 * A discovered prospect, before scoring. A superset of a PersonSearchResult: a
 * data source fills what it has. `raw` carries opaque provider extras (an
 * external enricher's firmographics) passed through to the qualifier.
 */
export interface Candidate {
  /** Stable identifier; used as the dedup identity when writing to a list. */
  entityUrn: string;
  /** Canonical profile URL. */
  profileUrl: string;
  name?: string;
  headline?: string;
  currentCompany?: string;
  location?: string;
  degree?: string;
  publicId?: string;
  /** Mirrors entityUrn; kept so PersonSearchResult maps straight across. */
  linkedinUrn?: string;
  raw?: Json;
}

/** A qualifier's judgment of one candidate against an ICP. */
export interface LeadScore {
  /** 0..100. Higher is a better ICP fit. */
  score: number;
  /** Short, operator-readable justification. Shown in the UI, stored in the blob. */
  reasons: string[];
  /** Which qualifier produced it, for auditing (e.g. "heuristic-v1"). */
  model: string;
}

/** Turns a candidate + ICP into a score. Heuristic (offline) or LLM-backed. */
export interface QualifierPort {
  score(candidate: Candidate, icp: Icp): Promise<LeadScore>;
}
