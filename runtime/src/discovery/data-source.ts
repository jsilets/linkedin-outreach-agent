// Data sources: where discovery candidates come from. LiveSearchDataSource is
// the default; it translates an ICP's query facets into a PeopleQuery and runs
// the existing live people search (observe-live.ts). An external provider can
// implement DataSourcePort behind the same seam without touching the feeder.

import type { ObservePort, PeopleQuery, PersonSearchResult, Icp } from '@loa/mcp';
import type { Candidate, DataSourcePort } from './types.js';

/** Translate an ICP's discovery facets into a free-tier PeopleQuery. */
export function icpToPeopleQuery(icp: Icp, limit: number): PeopleQuery {
  const q = icp.query;
  const query: PeopleQuery = { limit };
  if (q.keywords) query.keywords = q.keywords;
  if (q.titleKeywords?.length) query.titleKeywords = q.titleKeywords;
  if (q.companyKeywords?.length) query.companyKeywords = q.companyKeywords;
  if (q.companyUrns?.length) query.companyUrns = q.companyUrns;
  if (q.geoUrns?.length) query.geoUrns = q.geoUrns;
  if (q.network?.length) query.network = q.network;
  return query;
}

/** A search result carries everything a Candidate needs; map it straight over. */
export function personToCandidate(p: PersonSearchResult): Candidate {
  return {
    entityUrn: p.entityUrn,
    profileUrl: p.profileUrl,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.headline !== undefined ? { headline: p.headline } : {}),
    ...(p.currentCompany !== undefined ? { currentCompany: p.currentCompany } : {}),
    ...(p.location !== undefined ? { location: p.location } : {}),
    ...(p.degree !== undefined ? { degree: p.degree } : {}),
    ...(p.publicId !== undefined ? { publicId: p.publicId } : {}),
    ...(p.linkedinUrn !== undefined ? { linkedinUrn: p.linkedinUrn } : {}),
  };
}

/** Default data source: the live LinkedIn people search already in the runtime. */
export class LiveSearchDataSource implements DataSourcePort {
  constructor(private readonly observe: Pick<ObservePort, 'searchPeople'>) {}

  async discover(accountId: string, icp: Icp, limit: number): Promise<Candidate[]> {
    const people = await this.observe.searchPeople(accountId, icpToPeopleQuery(icp, limit), limit);
    return people.map(personToCandidate);
  }
}
