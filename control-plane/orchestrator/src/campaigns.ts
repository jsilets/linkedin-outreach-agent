// Campaign management: create campaigns, add targets, attach external context,
// and read/set the autonomy level. Every mutating operation records an event
// through the EventLog so the audit spine sees it.

import type { AutonomyLevel, Campaign, Json, Target } from '@loa/shared';
import type { EventLog } from './event-log.js';
import type { CampaignRepoPort, TargetRepoPort } from './repo-ports.js';
import { rowToCampaign, rowToTarget } from './mappers.js';

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
    const rows = await this.targets.createMany(
      inputs.map((t) => ({
        campaignId,
        prospectRef: t.prospectRef,
        linkedinUrn: t.linkedinUrn,
        externalContext: (t.externalContext ?? {}) as never,
      })),
    );
    await this.log.recordEvent('targets_added', null, {
      campaignId,
      count: rows.length,
    });
    return rows.map(rowToTarget);
  }

  /** Store the opaque enrichment blob on a target. */
  async attachExternalContext(targetId: string, blob: Json): Promise<Target> {
    const row = await this.targets.setExternalContext(targetId, blob as never);
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
