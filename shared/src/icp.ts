// Reading the ICP fit score back out of a member/target external_context blob.
//
// The discovery feeder and score_leads write a score envelope into
// external_context ({ score, scoreModel, scoreReasons, icp }); every read path
// (MCP get_list, the web list + funnel views, the enroll gate) needs the SAME
// interpretation of that blob, so the parsing and the off-ICP threshold live
// here once instead of being re-derived per consumer.

/**
 * Fit scores at or above this are treated as on-ICP; below it a member/target
 * is flagged off-ICP for operator review. The heuristic scorer centers a
 * neutral candidate at 50 (even log-odds), so 50 is the natural fit/no-fit line.
 * The flag is advisory: a low score on a sparse headline is a prompt to look,
 * not an automatic removal.
 */
export const ICP_FIT_THRESHOLD = 50;

/** The fit signal surfaced to operators and gates, read out of the blob. */
export interface IcpScoreView {
  /** 0..100 fit score, or null when the member was never scored. */
  score: number | null;
  /** Which qualifier produced it (e.g. "heuristic-v1", "harness"). */
  scoreModel: string | null;
  /** Short operator-readable justification lines. */
  scoreReasons: string[] | null;
  /** The ICP label the score was computed against. */
  icp: string | null;
  /** score !== null && score < ICP_FIT_THRESHOLD. False for unscored members. */
  offIcp: boolean;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : null;
}

/**
 * Pull the fit-score envelope out of an external_context blob. Tolerant of the
 * blob being undefined, a non-object, or missing the score fields (an unscored
 * member reads back score=null, offIcp=false).
 */
export function readIcpScore(
  externalContext: unknown,
  threshold = ICP_FIT_THRESHOLD,
): IcpScoreView {
  const ec = (externalContext ?? {}) as Record<string, unknown>;
  const score = num(ec.score);
  return {
    score,
    scoreModel: str(ec.scoreModel),
    scoreReasons: strList(ec.scoreReasons),
    icp: str(ec.icp),
    offIcp: score !== null && score < threshold,
  };
}
