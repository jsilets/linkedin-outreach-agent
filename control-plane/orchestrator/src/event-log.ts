// The append-only event log: the audit spine. Every state change in the
// orchestrator funnels through recordEvent, which is the only write path for
// events. There is no update and no delete; the EventRepo does not expose them.

import type { Json } from '@loa/shared';
import type { EventRepoPort } from './repo-ports.js';

export class EventLog {
  constructor(private readonly events: EventRepoPort) {}

  /**
   * Append one immutable audit event. accountId may be null for events not tied
   * to a single account. Returns the stored row's id and timestamp.
   */
  async recordEvent(
    kind: string,
    accountId: string | null,
    payload: Json,
  ): Promise<{ id: string; ts: Date }> {
    const row = await this.events.append({
      kind,
      accountId,
      payload: payload as unknown as EventPayload,
    });
    return { id: row.id, ts: row.ts };
  }
}

// The schema stores payload as jsonb; Drizzle infers it as unknown-ish. Narrow
// at the boundary rather than leaking it through the public signature.
type EventPayload = Parameters<EventRepoPort['append']>[0]['payload'];
