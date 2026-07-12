// The list-scoring surface, wired as a DiscoveryPort. Two entry points, both
// landing scores in lead_list_members.external_context:
//   - scoreLeads(): harness-driven, writes scores an agent already computed.
//   - scoreList():  offline, runs the built-in HeuristicQualifier over a list.
// Sourcing is a separate step (source_to_list); nothing here makes a live search.

import type {
  DiscoveryPort,
  Icp,
  LeadScoreInput,
  ScoreLeadsResult,
  ScoreListResult,
} from '@loa/mcp';
import type { Json } from '@loa/shared';
import { ICP_FIT_THRESHOLD, readIcpScore } from '@loa/shared';
import type { RuntimeStore } from '../store/index.js';
import { HeuristicQualifier } from './heuristic-qualifier.js';
import type { Candidate, QualifierPort } from './types.js';

export * from './types.js';

/** Adapter implementing the MCP DiscoveryPort over the store. Offline: it reads
 *  stored member fields and writes scores; it never touches LinkedIn. */
export class DiscoveryAdapter implements DiscoveryPort {
  private readonly qualifier: QualifierPort;

  constructor(
    private readonly store: RuntimeStore,
    deps: { qualifier?: QualifierPort } = {},
  ) {
    this.qualifier = deps.qualifier ?? new HeuristicQualifier();
  }

  /** Run the heuristic over the members already in a list, rebuilding a
   *  Candidate from each stored member row, and write the score envelope into
   *  external_context. Safe to re-run (e.g. after tightening the ICP). */
  async scoreList(listId: string, icp: Icp, overwrite = false): Promise<ScoreListResult> {
    const members = await this.store.leadList.listMembers(listId);
    let scored = 0;
    let offIcp = 0;
    let topScore = 0;
    let skippedOtherScorer = 0;
    for (const m of members) {
      const candidate: Candidate = {
        entityUrn: m.linkedinUrn,
        profileUrl: m.profileUrl ?? '',
        name: m.name ?? undefined,
        headline: m.headline ?? undefined,
        currentCompany: m.currentCompany ?? undefined,
        location: m.location ?? undefined,
        degree: m.degree ?? undefined,
        linkedinUrn: m.linkedinUrn,
      };
      const result = await this.qualifier.score(candidate, icp);
      // Never silently downgrade a higher-quality score: if the member already
      // carries a score from a different scorer (e.g. a harness score) and the
      // caller did not ask to overwrite, leave it and count it as skipped.
      if (!overwrite) {
        const existing = readIcpScore(m.externalContext);
        if (existing.scoreModel !== null && existing.scoreModel !== result.model) {
          skippedOtherScorer += 1;
          continue;
        }
      }
      const patch: Record<string, Json> = {
        score: result.score,
        scoreModel: result.model,
        scoreReasons: result.reasons,
        icp: icp.name,
      };
      const ok = await this.store.leadList.updateMemberContext(listId, m.linkedinUrn, patch);
      if (!ok) continue;
      scored += 1;
      if (result.score < ICP_FIT_THRESHOLD) offIcp += 1;
      if (result.score > topScore) topScore = result.score;
    }
    return { listId, scored, offIcp, topScore, skippedOtherScorer };
  }

  /** Attach agent-computed scores to existing list members. Returns how many
   *  matched a member (unmatched urns are reported so the caller sees misses). */
  async scoreLeads(listId: string, scores: LeadScoreInput[]): Promise<ScoreLeadsResult> {
    let updated = 0;
    const missed: string[] = [];
    for (const s of scores) {
      const patch: Record<string, Json> = {
        score: s.score,
        scoreModel: 'harness',
        ...(s.reasons ? { scoreReasons: s.reasons } : {}),
      };
      const ok = await this.store.leadList.updateMemberContext(listId, s.linkedinUrn, patch);
      if (ok) updated += 1;
      else missed.push(s.linkedinUrn);
    }
    return { updated, missed };
  }
}
