// The discovery feeder: discover -> score -> rank -> write, in one pass. This is
// the core the autonomous discover_leads tool calls. It stays agnostic to the
// data source and the qualifier (both injected) and to the store backend (it
// depends only on the lead-list write surface). The per-lead score is written
// into the member's external_context, so it shows in the UI and rides onto the
// campaign target through createCampaignFromList unchanged.

import type { Json } from '@loa/shared';
import type { db as shared } from '@loa/shared';
import type { DiscoveryResult, Icp } from '@loa/mcp';
import type { Candidate, DataSourcePort, LeadScore, QualifierPort } from './types.js';

/** The write surface the feeder needs; a subset of LeadListStorePort. */
export interface LeadListWriter {
  createList(input: { name: string; description?: string }): Promise<shared.LeadListRow>;
  insertMembers(rows: shared.NewLeadListMemberRow[]): Promise<{ inserted: number }>;
}

export interface FeederDeps {
  dataSource: DataSourcePort;
  qualifier: QualifierPort;
  lists: LeadListWriter;
}

export interface DiscoverParams {
  accountId: string;
  icp: Icp;
  listId?: string;
  listName?: string;
}

/** The stable dedup identity for a candidate, matching the LeadListAdapter. */
function identity(c: Candidate): string | undefined {
  return c.entityUrn || c.linkedinUrn || c.profileUrl || undefined;
}

/** Build a lead_list_members row, folding the score + profile fields into the
 *  external_context blob so the target inherits both on enrollment. */
function memberRow(
  listId: string,
  c: Candidate,
  s: LeadScore,
  icp: Icp,
): shared.NewLeadListMemberRow {
  const externalContext: Record<string, Json> = {
    score: s.score,
    scoreModel: s.model,
    scoreReasons: s.reasons,
    icp: icp.name,
  };
  if (c.profileUrl) externalContext.profileUrl = c.profileUrl;
  if (c.name) externalContext.name = c.name;
  if (c.headline) externalContext.headline = c.headline;
  if (c.currentCompany) externalContext.currentCompany = c.currentCompany;
  return {
    listId,
    linkedinUrn: identity(c)!,
    name: c.name ?? null,
    headline: c.headline ?? null,
    profileUrl: c.profileUrl ?? null,
    degree: c.degree ?? null,
    location: c.location ?? null,
    currentCompany: c.currentCompany ?? null,
    externalContext: externalContext as Json,
  };
}

/**
 * Run the feeder. Resolves the target list (creating one when only a name is
 * given), discovers candidates for the ICP, scores each, drops any below
 * icp.minScore, ranks the rest highest-first, and writes them. The write is
 * idempotent on (listId, linkedinUrn), so re-running is safe.
 */
export async function discoverAndScore(
  deps: FeederDeps,
  params: DiscoverParams,
): Promise<DiscoveryResult> {
  const { accountId, icp, listId: listIdArg, listName } = params;
  if (!listIdArg && !listName) {
    throw new Error('discover: provide either a listId or a listName');
  }

  const listId =
    listIdArg ??
    (await deps.lists.createList({ name: listName!, description: `ICP: ${icp.name}` })).id;

  const limit = icp.limit ?? 25;
  const candidates = await deps.dataSource.discover(accountId, icp, limit);
  if (candidates.length === 0) {
    return { listId, discovered: 0, scored: 0, inserted: 0, duplicates: 0, topScore: 0 };
  }

  const scored = await Promise.all(
    candidates.map(async (c) => ({ candidate: c, result: await deps.qualifier.score(c, icp) })),
  );

  const minScore = icp.minScore ?? 0;
  const kept = scored
    .filter((x) => identity(x.candidate) && x.result.score >= minScore)
    .sort((a, b) => b.result.score - a.result.score);

  if (kept.length === 0) {
    return { listId, discovered: candidates.length, scored: 0, inserted: 0, duplicates: 0, topScore: 0 };
  }

  const rows = kept.map((x) => memberRow(listId, x.candidate, x.result, icp));
  const { inserted } = await deps.lists.insertMembers(rows);
  return {
    listId,
    discovered: candidates.length,
    scored: kept.length,
    inserted,
    duplicates: rows.length - inserted,
    topScore: kept[0]!.result.score,
  };
}
