// Scheduler adapter: the source of paced follow-ups for the agent loop and the
// orchestrator reply router. It holds queued follow-ups in memory and uses the
// PacingScheduler to compute the earliest working-hours run time (nextRunAt) for
// each. It satisfies BOTH divergent follow-up port shapes:
//   - orchestrator SchedulerLikePort.enqueueFollowUp({targetId,campaignId,...})
//   - agent SchedulerPort.enqueueFollowUp({accountId,targetId,campaignId,...})
//
// PacingScheduler.dueActions remains available to a future dispatch tick that
// pulls due actions out of the queue and hands them to the executor; the runtime
// exposes the scheduler instance so that loop can be added without a rewire.

import type { SchedulerPort as AgentSchedulerPort } from '@loa/agent';
import type { SchedulerLikePort } from '@loa/orchestrator';
import type { SafetyPort as SchedulerSafetyPort } from '@loa/scheduler';
import { PacingScheduler } from '@loa/scheduler';
import type { Account, Action } from '@loa/shared';

/** One queued follow-up the scheduler is holding. */
export interface QueuedFollowUp {
  accountId?: string;
  targetId: string;
  campaignId: string;
  /** Earliest time the follow-up may run, after pacing. */
  notBefore: Date;
  reason: string;
  enqueuedAt: Date;
}

export interface SchedulerServiceDeps {
  safety: SchedulerSafetyPort;
  rng?: () => number;
  now?: () => Date;
}

export class SchedulerService {
  readonly pacing: PacingScheduler;
  private readonly queue: QueuedFollowUp[] = [];
  private readonly now: () => Date;

  constructor(deps: SchedulerServiceDeps) {
    this.pacing = new PacingScheduler(deps.safety, deps.rng ? { rng: deps.rng } : {});
    this.now = deps.now ?? (() => new Date());
  }

  /** All queued follow-ups, for inspection and tests. */
  pending(): readonly QueuedFollowUp[] {
    return this.queue;
  }

  /** Pace a raw notBefore into the next working instant with jitter. */
  private paced(notBefore: Date): Date {
    // Build a throwaway Action just to reuse nextRunAt's working-hours + jitter
    // math; only scheduledAt matters for that computation.
    const now = this.now();
    const shell: Action = {
      id: 'followup',
      type: 'message',
      scheduledAt: notBefore,
      executedAt: null,
      result: 'pending',
      dedupKey: 'followup',
      accountId: '',
      targetId: '',
      campaignId: '',
      createdAt: now,
      updatedAt: now,
    };
    return this.pacing.nextRunAt(shell, now);
  }

  /** orchestrator SchedulerLikePort */
  asOrchestratorPort(): SchedulerLikePort {
    return {
      enqueueFollowUp: async (input) => {
        this.queue.push({
          targetId: input.targetId,
          campaignId: input.campaignId,
          notBefore: this.paced(input.notBefore),
          reason: input.reason,
          enqueuedAt: this.now(),
        });
      },
    };
  }

  /** agent SchedulerPort (carries accountId too) */
  asAgentPort(): AgentSchedulerPort {
    return {
      enqueueFollowUp: async (input) => {
        this.queue.push({
          accountId: input.accountId,
          targetId: input.targetId,
          campaignId: input.campaignId,
          notBefore: this.paced(input.notBefore),
          reason: input.reason,
          enqueuedAt: this.now(),
        });
      },
    };
  }

  /** Expose dueActions for a future dispatch tick. */
  dueActions(account: Account, actions: Action[], at: Date = this.now()) {
    return this.pacing.dueActions(account, actions, at);
  }
}
