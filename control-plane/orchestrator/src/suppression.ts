// Suppression across all campaigns. When a target says Stop, we must never send
// to that person again, on any campaign. Targets are per-campaign rows, but a
// person is identified by their LinkedIn URN, so suppression is keyed by URN.
//
// The fixed schema has no suppression table, so suppression is recorded as an
// append-only event (kind 'target_suppressed', payload carries the URN) and read
// back by scanning events for that URN. This keeps the audit spine as the single
// source of truth and needs no schema change.

import type { EventLog } from './event-log.js';
import type { EventRepoPort, TargetRepoPort } from './repo-ports.js';

const SUPPRESSION_KIND = 'target_suppressed';

export class SuppressionService {
  constructor(
    private readonly targets: TargetRepoPort,
    private readonly events: EventRepoPort,
    private readonly log: EventLog,
  ) {}

  /**
   * Hard-suppress the person behind this target across every campaign. Records
   * one suppression event carrying the URN, plus the originating target id.
   */
  async suppressByTarget(targetId: string): Promise<{ linkedinUrn: string }> {
    const target = await this.targets.findById(targetId);
    if (!target) {
      throw new Error(`target not found: ${targetId}`);
    }
    await this.log.recordEvent(SUPPRESSION_KIND, null, {
      linkedinUrn: target.linkedinUrn,
      originTargetId: targetId,
    });
    return { linkedinUrn: target.linkedinUrn };
  }

  /** True if the person behind this target has been suppressed on any campaign. */
  async isSuppressed(targetId: string): Promise<boolean> {
    const target = await this.targets.findById(targetId);
    if (!target) {
      return false;
    }
    return this.isUrnSuppressed(target.linkedinUrn);
  }

  /** True if any suppression event names this URN. */
  async isUrnSuppressed(linkedinUrn: string): Promise<boolean> {
    // Suppression events are recorded with accountId null; scan that bucket.
    const rows = await this.events.listSuppression();
    return rows.some((r) => {
      const payload = r.payload as { linkedinUrn?: unknown } | null;
      return payload != null && payload.linkedinUrn === linkedinUrn;
    });
  }
}
