// Campaign management: create campaigns, add targets, attach external context,
// and read/set the autonomy level. Every mutating operation records an event
// through the EventLog so the audit spine sees it.

import type { AutonomyLevel, Campaign, Json, Target } from '@loa/shared';
import { canonicalProfileKey } from '@loa/shared';
import type { EventLog } from './event-log.js';
import { rowToCampaign, rowToTarget } from './mappers.js';
import type { CampaignRepoPort, TargetRepoPort } from './repo-ports.js';

export interface CreateCampaignInput {
  goal: string;
  messageStrategy: string;
  owner: string;
  autonomyLevel?: AutonomyLevel;
}

export interface AddTargetInput {
  prospectRef: string;
  linkedinUrn: string;
  externalContext?: Json;
}

export class CampaignService {
  constructor(
    private readonly campaigns: CampaignRepoPort,
    private readonly targets: TargetRepoPort,
    private readonly log: EventLog,
  ) {}

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    const row = await this.campaigns.create({
      goal: input.goal,
      messageStrategy: input.messageStrategy,
      owner: input.owner,
      autonomyLevel: input.autonomyLevel ?? 'supervised',
    });
    await this.log.recordEvent('campaign_created', null, {
      campaignId: row.id,
      owner: input.owner,
    });
    return rowToCampaign(row);
  }

  async addTargets(campaignId: string, inputs: AddTargetInput[]): Promise<Target[]> {
    // Key every dedup decision on the canonical bare person urn, never the search
    // wrapper: the same person sourced via a different flow must collapse to one
    // key. Dedupe against the campaign's existing targets (any stage, so a
    // previously removed/lost target is not re-added — removal sticks) and within
    // the input batch. The read-then-insert dedup below still races two
    // concurrent calls, but the targets (campaignId, linkedinUrn) unique index +
    // createMany's onConflictDoNothing is the race-safe backstop that closes it.
    const canon = inputs.map((t) => ({ ...t, linkedinUrn: canonicalProfileKey(t.linkedinUrn) }));
    const existing = await this.targets.listByCampaign(campaignId);
    const seen = new Set(existing.map((t) => canonicalProfileKey(t.linkedinUrn)));
    const fresh: AddTargetInput[] = [];
    for (const t of canon) {
      if (seen.has(t.linkedinUrn)) continue;
      seen.add(t.linkedinUrn);
      fresh.push(t);
    }
    const rows = await this.targets.createMany(
      fresh.map((t) => ({
        campaignId,
        prospectRef: t.prospectRef,
        linkedinUrn: t.linkedinUrn,
        externalContext: (t.externalContext ?? {}) as never,
      })),
    );
    await this.log.recordEvent('targets_added', null, {
      campaignId,
      count: rows.length,
      skipped: inputs.length - rows.length,
    });
    return rows.map(rowToTarget);
  }

  /** Store the opaque enrichment blob on a target. */
  async attachExternalContext(targetId: string, blob: Json): Promise<Target> {
    // Merge (not replace) so an enrichment/score attaches without clobbering the
    // profile fields already on the target. Tolerate a JSON-string blob (some
    // callers double-encode) by parsing it back to an object first.
    const patch = toContextPatch(blob);
    const row = await this.targets.mergeExternalContext(targetId, patch);
    await this.log.recordEvent('external_context_attached', null, {
      targetId,
    });
    return rowToTarget(row);
  }

  async setAutonomyLevel(campaignId: string, level: AutonomyLevel): Promise<Campaign> {
    const row = await this.campaigns.setAutonomy(campaignId, level);
    await this.log.recordEvent('autonomy_set', null, {
      campaignId,
      level,
    });
    return rowToCampaign(row);
  }

  async readAutonomyLevel(campaignId: string): Promise<AutonomyLevel | undefined> {
    const row = await this.campaigns.findById(campaignId);
    return row?.autonomyLevel;
  }
}

// Coerce an attach blob into a jsonb-mergeable object. A plain object passes
// through; a JSON string (double-encoded by some callers) is parsed. Anything
// that is not a JSON object is rejected, since a scalar can't merge into the
// external_context map without clobbering it.
function toContextPatch(blob: Json): Record<string, Json> {
  let value: unknown = blob;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('attachExternalContext: blob is a string that is not valid JSON');
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('attachExternalContext: context must be a JSON object');
  }
  return value as Record<string, Json>;
}
