// The discovery feeder, wired as a DiscoveryPort. Two entry points, both landing
// scores in lead_list_members.external_context:
//   - discoverLeads(): autonomous, runs the live search + HeuristicQualifier.
//   - scoreLeads():     harness-driven, writes scores an agent already computed.
// compose() builds this only when LOA_DISCOVERY_ENABLED is on.

import type { Json } from '@loa/shared';
import type {
  DiscoveryPort,
  DiscoveryResult,
  Icp,
  LeadScoreInput,
  ObservePort,
  ScoreLeadsResult,
} from '@loa/mcp';
import type { RuntimeStore } from '../store/index.js';
import { LiveSearchDataSource } from './data-source.js';
import { HeuristicQualifier } from './heuristic-qualifier.js';
import { discoverAndScore } from './feeder.js';
import type { DataSourcePort, QualifierPort } from './types.js';

export * from './types.js';
export { LiveSearchDataSource, icpToPeopleQuery, personToCandidate } from './data-source.js';
export { HeuristicQualifier } from './heuristic-qualifier.js';
export { discoverAndScore } from './feeder.js';
export type { FeederDeps, DiscoverParams, LeadListWriter } from './feeder.js';

/** Adapter implementing the MCP DiscoveryPort over the feeder + the store. */
export class DiscoveryAdapter implements DiscoveryPort {
  private readonly dataSource: DataSourcePort;
  private readonly qualifier: QualifierPort;

  constructor(
    private readonly store: RuntimeStore,
    observe: Pick<ObservePort, 'searchPeople'>,
    deps: { dataSource?: DataSourcePort; qualifier?: QualifierPort } = {},
  ) {
    this.dataSource = deps.dataSource ?? new LiveSearchDataSource(observe);
    this.qualifier = deps.qualifier ?? new HeuristicQualifier();
  }

  async discoverLeads(params: {
    accountId: string;
    icp: Icp;
    listId?: string;
    listName?: string;
  }): Promise<DiscoveryResult> {
    return discoverAndScore(
      { dataSource: this.dataSource, qualifier: this.qualifier, lists: this.store.leadList },
      params,
    );
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
