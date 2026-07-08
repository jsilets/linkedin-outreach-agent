// The dispatch tick: walks enrolled targets through their campaign sequence.
//
// Each tick pulls due target-progress cursors (state='in_progress' and
// nextStepAt<=now), loads the campaign's step template, and acts on the step the
// cursor points at:
//   - 'delay'  -> pure wait: advance the cursor and set nextStepAt from THIS
//                 step's delaySeconds. No action is minted.
//   - action   -> build an ActRequest and route it through gateAct(), the SAME
//                 chokepoint the MCP Act tools use (autonomy matrix + SafetyGate
//                 budget/canAct + executor). Never bypasses safety.
//
// Cursor advance on an action step:
//   executed -> advance currentStep, set nextStepAt from the NEXT step's
//               delaySeconds, set lastStepAt. Past the last step -> completed.
//   queued   -> the autonomy level sent this to human approval; treat like a
//               deferral and leave the cursor for a later tick (the operator
//               drives the approved send separately).
//   deferred / denied -> leave the cursor untouched for the next tick.
//   throw    -> executor failure: record errorMessage and mark the cursor failed.
//
// Host-agnostic: runTick(now) does one pass; start(intervalMs) wraps it in a
// setInterval so a Railway process (or any host) can run it. No local/cloud
// assumptions and no shared mutable tick state, so it is restartable.

import type { CampaignStepType } from '@loa/shared';
import type { db as shared } from '@loa/shared';
import { gateAct, type ActRequest, type GateDeps, type GateOutcome } from '@loa/mcp';
import type { TargetRepoPort } from '@loa/orchestrator';
import type { SequenceStorePort } from '../store/index.js';
import { advanceAfterStep } from './advance.js';

type CampaignStepRow = shared.CampaignStepRow;
type TargetProgressRow = shared.TargetProgressRow;

/** Stages from which a message step may fire: a 1st-degree connection or beyond.
 * LinkedIn only lets you message a connection, so a message before acceptance is
 * held. The acceptance tick moves a target to 'connected'; the reply router moves
 * it further (in_conversation/replied/won). */
const MESSAGEABLE_STAGES: ReadonlySet<string> = new Set([
  'connected',
  'in_conversation',
  'replied',
  'won',
]);

/** How one due cursor resolved in a tick. Returned for observability + tests. */
export type StepOutcome =
  | { kind: 'delayed'; progressId: string; nextStep: number }
  | { kind: 'executed'; progressId: string; actionId: string; nextStep: number }
  | { kind: 'completed'; progressId: string }
  | { kind: 'held'; progressId: string; reason: string } // gate queued/deferred/denied, or not connected
  | { kind: 'awaiting_connection'; progressId: string } // connect sent; parked for acceptance
  | { kind: 'failed'; progressId: string; error: string }
  | { kind: 'no_steps'; progressId: string }
  | { kind: 'exhausted'; progressId: string }; // cursor past the last step already

export interface TickResult {
  ran: number;
  outcomes: StepOutcome[];
}

/** Narrow target-stage surface the tick needs: read the stage before a message
 * step (the connected gate) and set it after a connect step (park at 'invited').
 * Supplied by compose from the store's target repo; tests pass a fake. */
type TargetStagePort = Pick<TargetRepoPort, 'findById' | 'setStage'>;

export interface DispatchTickDeps {
  sequence: SequenceStorePort;
  gate: GateDeps;
  targets: TargetStagePort;
  now?: () => Date;
  /** Optional sink for per-outcome logging (audit / metrics). */
  onOutcome?: (o: StepOutcome) => void;
}

/** The action step types (everything but the pure-wait 'delay'). */
type ActionStepType = Exclude<CampaignStepType, 'delay'>;

/** Build the ActRequest payload for an action step. Never called for 'delay'. */
function actRequestFor(
  stepType: ActionStepType,
  step: CampaignStepRow,
  progress: TargetProgressRow,
): ActRequest {
  const base = {
    accountId: progress.accountId,
    targetId: progress.targetId,
    campaignId: progress.campaignId,
  };
  switch (stepType) {
    case 'connect':
      return { ...base, type: 'connect', payload: step.note ?? null };
    case 'message':
      return { ...base, type: 'message', payload: step.body ?? '' };
    case 'react':
      return { ...base, type: 'react', payload: { reaction: step.reaction ?? 'like' } };
    case 'view_profile':
      return { ...base, type: 'view_profile' };
    case 'follow':
      return { ...base, type: 'follow' };
    default: {
      const never: never = stepType;
      throw new Error(`actRequestFor called on non-action step: ${String(never)}`);
    }
  }
}

/** Draft body carried to the gate for approval, when the step has one. */
function draftBodyFor(step: CampaignStepRow): string | undefined {
  if (step.stepType === 'message') return step.body ?? '';
  if (step.stepType === 'connect') return step.note ?? undefined;
  return undefined;
}

export class DispatchTick {
  private readonly sequence: SequenceStorePort;
  private readonly gate: GateDeps;
  private readonly targets: TargetStagePort;
  private readonly now: () => Date;
  private readonly onOutcome?: (o: StepOutcome) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: DispatchTickDeps) {
    this.sequence = deps.sequence;
    this.gate = deps.gate;
    this.targets = deps.targets;
    this.now = deps.now ?? (() => new Date());
    this.onOutcome = deps.onOutcome;
  }

  /** One pass: process every due cursor. Safe to call repeatedly. */
  async runTick(now: Date = this.now()): Promise<TickResult> {
    const due = await this.sequence.dueTargetProgress(now);
    const outcomes: StepOutcome[] = [];
    for (const progress of due) {
      const outcome = await this.step(progress, now);
      outcomes.push(outcome);
      this.onOutcome?.(outcome);
    }
    return { ran: due.length, outcomes };
  }

  /** Advance one target-progress cursor by exactly one sequence step. */
  private async step(progress: TargetProgressRow, now: Date): Promise<StepOutcome> {
    const steps = (await this.sequence.listCampaignSteps(progress.campaignId)).filter(
      (s) => s.enabled,
    );
    if (steps.length === 0) return { kind: 'no_steps', progressId: progress.id };

    const idx = progress.currentStep;
    if (idx >= steps.length) {
      // Cursor already past the end; normalize to completed.
      await this.sequence.advanceTargetProgress(progress.id, { state: 'completed', nextStepAt: null });
      return { kind: 'exhausted', progressId: progress.id };
    }

    const step = steps[idx]!;

    // 'delay': a pure wait. Its own delaySeconds was already applied when the
    // cursor advanced ONTO this step (delaySeconds = wait before a step becomes
    // due, per the schema). So running it just advances to the next step and
    // gates that behind the next step's own delaySeconds. This keeps a single,
    // uniform rule and avoids double-counting the delay.
    if (step.stepType === 'delay') {
      const nextIdx = idx + 1;
      if (nextIdx >= steps.length) {
        await this.sequence.advanceTargetProgress(progress.id, {
          currentStep: nextIdx,
          state: 'completed',
          nextStepAt: null,
          lastStepAt: now,
        });
        return { kind: 'completed', progressId: progress.id };
      }
      const nextStep = steps[nextIdx]!;
      await this.sequence.advanceTargetProgress(progress.id, {
        currentStep: nextIdx,
        nextStepAt:
          nextStep.delaySeconds > 0 ? new Date(now.getTime() + nextStep.delaySeconds * 1000) : null,
        lastStepAt: now,
      });
      return { kind: 'delayed', progressId: progress.id, nextStep: nextIdx };
    }

    // A message can only go to a 1st-degree connection, so gate it on the target
    // stage. Normally the acceptance tick has already released the cursor here
    // (target='connected'), so this is a defensive net: if the target is not yet
    // connected, hold WITHOUT firing and leave the cursor for a later tick.
    if (step.stepType === 'message') {
      const target = await this.targets.findById(progress.targetId);
      if (!target || !MESSAGEABLE_STAGES.has(target.stage)) {
        return { kind: 'held', progressId: progress.id, reason: 'not_connected' };
      }
    }

    // Action step: route through the SAME gate + executor path as the Act tools.
    const req = actRequestFor(step.stepType, step, progress);
    let outcome: GateOutcome;
    try {
      outcome = await gateAct(this.gate, req, draftBodyFor(step));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.sequence.advanceTargetProgress(progress.id, {
        state: 'failed',
        errorMessage: error,
        nextStepAt: null,
      });
      return { kind: 'failed', progressId: progress.id, error };
    }

    if (outcome.kind === 'queued') {
      // Autonomy routed this to human approval. Park the cursor in
      // awaiting_approval so it is no longer due: without this the next tick
      // would re-run the step and enqueue a duplicate approval every pass. The
      // post-approval resume moves it forward (approve) or stops it (reject).
      await this.sequence.advanceTargetProgress(progress.id, { state: 'awaiting_approval' });
      return { kind: 'held', progressId: progress.id, reason: 'queued' };
    }

    if (outcome.kind === 'deferred' || outcome.kind === 'denied') {
      // Transient (pacing / budget). Leave the cursor in_progress and retry next
      // tick; nothing was enqueued, so there is nothing to dedupe.
      return { kind: 'held', progressId: progress.id, reason: outcome.kind };
    }

    // A connect invite is out. Instead of a timer-based advance, PARK the cursor
    // for acceptance: set the target stage to 'invited' and hold at 'awaiting_-
    // connection' with no due time. The cursor stays ON the connect step so the
    // acceptance tick knows where to resume from (it advances past connect once
    // the invite is accepted). This is what gates a later message behind a real
    // 1st-degree connection.
    if (step.stepType === 'connect') {
      await this.targets.setStage(progress.targetId, 'invited');
      await this.sequence.advanceTargetProgress(progress.id, {
        state: 'awaiting_connection',
        nextStepAt: null,
        lastStepAt: now,
        errorMessage: null,
      });
      return { kind: 'awaiting_connection', progressId: progress.id };
    }

    // Executed. Advance to the next step (or complete) with the shared rule.
    const patch = advanceAfterStep(steps, idx, now);
    await this.sequence.advanceTargetProgress(progress.id, patch);
    return {
      kind: 'executed',
      progressId: progress.id,
      actionId: outcome.actionId,
      nextStep: patch.currentStep!,
    };
  }

  /** Start a restartable interval loop. No-op if already started. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // skip if the previous tick is still in flight
      this.running = true;
      void this.runTick()
        .catch(() => {
          // A tick must never crash the loop; per-cursor failures are recorded
          // on the row. Swallow here so the interval keeps running.
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    // Do not keep the process alive solely for the tick (host owns lifecycle).
    this.timer.unref?.();
  }

  /** Stop the interval loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
