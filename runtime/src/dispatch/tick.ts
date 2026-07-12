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
// setInterval so any host process can run it. No local/cloud
// assumptions and no shared mutable tick state, so it is restartable.

import {
  type ActRequest,
  type GateDeps,
  type GateOutcome,
  gateAct,
  mayExecuteDirectly,
} from '@loa/mcp';
import type { MessageRepoPort, TargetRepoPort } from '@loa/orchestrator';
import type { AccountSchedule, CampaignStepType, Json, db as shared } from '@loa/shared';
import {
  CONTACTED_TARGET_STAGES,
  canonicalProfileKey,
  DEFAULT_SCHEDULE,
  SafetyDeferredError,
} from '@loa/shared';
import { personalizeBody } from '../executor/session-provider.js';
import type { SequenceStorePort } from '../store/index.js';
import { advanceAfterStep, dueAfterDelay } from './advance.js';

type CampaignStepRow = shared.CampaignStepRow;
type TargetProgressRow = shared.TargetProgressRow;
type TargetRow = shared.TargetRow;
type MessageRow = shared.MessageRow;

/** Stages where the sequence must stop: past 'connected' a human owns the live
 * thread (in_conversation / replied / won), and 'lost' is terminal. A message
 * step must NOT keep firing at these — instead we pull the target from the
 * funnel so its cursor goes terminal too. (Below 'connected' the invite is not
 * yet accepted, so a message is merely held for a later tick.) */
const SEQUENCE_STOP_STAGES: ReadonlySet<string> = new Set([
  'in_conversation',
  'replied',
  'won',
  'lost',
]);

/** Stages at which a target in ANOTHER campaign counts as "already being
 * contacted" for the cross-campaign lock: real outreach has gone out (invited)
 * or landed (connected / in_conversation / replied / won). A person only sourced
 * or queued elsewhere is fair game — whichever campaign fires first wins and the
 * other then holds, so two pre-contact enrollments never deadlock. Mirrors the
 * shared CONTACTED_TARGET_STAGES used by list/campaign removal. */
const CROSS_CAMPAIGN_CONTACT_STAGES: ReadonlySet<string> = new Set(CONTACTED_TARGET_STAGES);

/** Of the contacted stages, the only TRANSIENT one: an outstanding invite that
 * will resolve (accepted -> connected, or withdrawn). While another campaign's
 * invite to the same person is pending we HOLD this campaign's outbound step, so
 * we never send two invites at once. Every OTHER contacted stage
 * (connected / in_conversation / replied / won) can be a permanent resting
 * state, so holding on it would livelock forever — those cases eject this
 * target cleanly instead. */
const CROSS_CAMPAIGN_HOLD_STAGES: ReadonlySet<string> = new Set(['invited']);

/**
 * Send-time reply probe. Returns true if the target has an inbound message newer
 * than `since` (in which case it has ALSO routed that reply — pulling the funnel
 * and cancelling outstanding messages), so the caller must not send. A throw
 * means the reply lane is broken and the caller must fail closed (not send).
 * Backed by the ReplyTick in live mode; omitted in fake mode.
 */
export interface SendTimeReplyCheck {
  check(accountId: string, target: TargetRow, since: Date | null): Promise<boolean>;
}

/** How one due cursor resolved in a tick. Returned for observability + tests. */
export type StepOutcome =
  | { kind: 'delayed'; progressId: string; nextStep: number }
  | { kind: 'executed'; progressId: string; actionId: string; nextStep: number }
  | { kind: 'completed'; progressId: string }
  | { kind: 'held'; progressId: string; reason: string } // gate queued/deferred/denied, or not connected
  | { kind: 'awaiting_connection'; progressId: string } // connect sent; parked for acceptance
  | { kind: 'cancelled'; progressId: string; messageId?: string; reason: string } // approved send killed pre-flight
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
type TargetStagePort = Pick<TargetRepoPort, 'findById' | 'setStage' | 'listByUrn'>;

export interface DispatchTickDeps {
  sequence: SequenceStorePort;
  gate: GateDeps;
  targets: TargetStagePort;
  /** Messages, so the tick can send human-approved drafts when the working-hours
   * window opens (the approval path no longer dispatches directly). */
  messages: MessageRepoPort;
  /** Cross-campaign suppression (the person said Stop, on any campaign). Wired by
   * compose from the orchestrator; omitted by tests that do not exercise it. When
   * present, a suppressed target's approved send is cancelled and a suppressed
   * message/connect step pulls the target from the funnel. */
  suppression?: { isSuppressed(targetId: string): Promise<boolean> };
  /** Send-time reply probe (live inbox read). Wired by compose only when a real
   * session exists; a broken probe fails closed (no send). */
  replyProbe?: SendTimeReplyCheck;
  /** Fire-and-forget audit sink for cancellations and probe blocks. Wired by
   * compose from the orchestrator event log; a logging failure never blocks or
   * fails a tick. */
  log?: {
    recordEvent(kind: string, accountId: string | null, payload: Json): Promise<unknown>;
  };
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
  private readonly messages: MessageRepoPort;
  private readonly suppression?: { isSuppressed(targetId: string): Promise<boolean> };
  private readonly replyProbe?: SendTimeReplyCheck;
  private readonly log?: {
    recordEvent(kind: string, accountId: string | null, payload: Json): Promise<unknown>;
  };
  private readonly now: () => Date;
  private readonly onOutcome?: (o: StepOutcome) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: DispatchTickDeps) {
    this.sequence = deps.sequence;
    this.gate = deps.gate;
    this.targets = deps.targets;
    this.messages = deps.messages;
    this.suppression = deps.suppression;
    this.replyProbe = deps.replyProbe;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
    this.onOutcome = deps.onOutcome;
  }

  /** Fire-and-forget audit event; a logging failure never affects the tick. */
  private logEvent(kind: string, accountId: string | null, payload: Json): void {
    void this.log?.recordEvent(kind, accountId, payload).catch(() => {});
  }

  /** Is the person behind this cursor already actively contacted in a DIFFERENT
   * campaign? Returns the blocking target's identity (for the audit event) when
   * so, else undefined. Keys on the canonical person urn so a match holds across
   * however the two campaigns sourced the same person. */
  private async heldByOtherCampaign(
    progress: TargetProgressRow,
  ): Promise<{ campaignId: string; stage: string; linkedinUrn: string } | undefined> {
    const target = await this.targets.findById(progress.targetId);
    if (!target) return undefined;
    const key = canonicalProfileKey(target.linkedinUrn);
    const others = await this.targets.listByUrn(key);
    const blocker = others.find(
      (t) => t.campaignId !== progress.campaignId && CROSS_CAMPAIGN_CONTACT_STAGES.has(t.stage),
    );
    if (!blocker) return undefined;
    return { campaignId: blocker.campaignId, stage: blocker.stage, linkedinUrn: key };
  }

  /** The account's working schedule (its own, else the global default). */
  private async scheduleFor(accountId: string): Promise<AccountSchedule> {
    const acct = await this.gate.safety.getAccount(accountId);
    return acct.limits?.schedule ?? DEFAULT_SCHEDULE;
  }

  /** One pass: send any approved-and-due messages, then process every due
   * cursor. Approved messages are sent first so an approval that landed off-hours
   * goes out as soon as this tick runs inside the window. */
  async runTick(now: Date = this.now()): Promise<TickResult> {
    const outcomes: StepOutcome[] = [];

    for (const msg of await this.messages.listApproved()) {
      const outcome = await this.sendApproved(msg, now);
      if (outcome) {
        outcomes.push(outcome);
        this.onOutcome?.(outcome);
      }
    }

    const due = await this.sequence.dueTargetProgress(now);
    for (const progress of due) {
      const outcome = await this.step(progress, now);
      outcomes.push(outcome);
      this.onOutcome?.(outcome);
    }
    return { ran: due.length, outcomes };
  }

  /** Send one human-approved message through the executor (which re-checks
   * safety at token mint). On a send, flip it to 'sent' and advance the target's
   * sequence cursor. On a safety deferral (outside the working-hours window or a
   * day off) leave it 'approved' to retry next tick — the operator never
   * re-approves. Returns an outcome only when the send actually landed. */
  private async sendApproved(msg: MessageRow, now: Date): Promise<StepOutcome | undefined> {
    const req = msg.pendingReq as ActRequest | undefined;
    if (!req) return undefined; // pre-binding orphan; nothing to dispatch

    // Pre-send guards. An approval given earlier can be invalidated before the
    // window opens: the person replied, was hard-suppressed, or the target went
    // terminal. Never send in those cases — cancel (terminal 'cancelled').
    const suppressed = this.suppression ? await this.suppression.isSuppressed(msg.targetId) : false;
    if (req.type === 'message') {
      const target = await this.targets.findById(msg.targetId);
      const progress = await this.sequence.getTargetProgressByTarget(msg.targetId);
      const cancelReason =
        progress?.state === 'replied'
          ? 'replied'
          : !target
            ? 'target_missing'
            : target.stage === 'lost'
              ? 'stage_lost'
              : suppressed
                ? 'suppressed'
                : null;
      if (cancelReason) return this.cancelApproved(msg, progress?.id, cancelReason);
      // Send-time reply probe: catch a reply that landed AFTER approval. A true
      // result means the probe already routed it (pulling the funnel and
      // cancelling this row), so hold — do not send. A throw fails closed: leave
      // the message approved and retry next tick, because a broken reply lane
      // must never be treated as "no reply" and allow a send.
      if (this.replyProbe && target) {
        const since = progress?.lastStepAt ?? msg.createdAt;
        let replied: boolean;
        try {
          replied = await this.replyProbe.check(req.accountId, target, since);
        } catch {
          return undefined;
        }
        if (replied) {
          this.logEvent('approved_send_held_reply', msg.accountId, {
            messageId: msg.id,
            targetId: msg.targetId,
          });
          return { kind: 'held', progressId: progress?.id ?? msg.targetId, reason: 'replied' };
        }
      }
    } else if (suppressed) {
      // Suppression also blocks connect/react/follow approved sends.
      return this.cancelApproved(msg, undefined, 'suppressed');
    }

    // The edited body lives on the message; the persisted request may hold the
    // original draft, so send the message body.
    const outbound: ActRequest = { ...req, payload: msg.body };
    let actionId: string;
    try {
      const action = await this.gate.executor.execute(outbound);
      if (action.result !== 'success') return undefined; // ok:false; retry next tick
      actionId = action.id;
    } catch (err) {
      if (err instanceof SafetyDeferredError) return undefined; // window closed; retry next tick
      // A genuine send failure: leave it approved for a later retry.
      return undefined;
    }

    await this.messages.setStatus(msg.id, 'sent');

    // A connect approved out-of-band parks for acceptance, exactly like a
    // tick-driven connect step: set the target 'invited' and hold the cursor at
    // awaiting_connection ON the connect step. Do NOT advance past it with
    // advanceAfterStep — the invite is not accepted yet, and advancing would let
    // the next (message) step fire against a non-connection. The acceptance tick
    // releases it once accepted.
    if (req.type === 'connect') {
      await this.targets.setStage(msg.targetId, 'invited');
      const prog = await this.sequence.getTargetProgressByTarget(msg.targetId);
      if (prog && prog.state === 'awaiting_approval') {
        await this.sequence.advanceTargetProgress(prog.id, {
          state: 'awaiting_connection',
          nextStepAt: null,
          lastStepAt: now,
          errorMessage: null,
        });
        return { kind: 'awaiting_connection', progressId: prog.id };
      }
      return { kind: 'executed', progressId: prog?.id ?? msg.targetId, actionId, nextStep: -1 };
    }

    // Advance the sequence cursor for this target, if it is sequence-driven and
    // still parked awaiting this approval.
    const prog = await this.sequence.getTargetProgressByTarget(msg.targetId);
    if (prog?.state !== 'awaiting_approval') {
      return { kind: 'executed', progressId: prog?.id ?? msg.targetId, actionId, nextStep: -1 };
    }
    const steps = (await this.sequence.listCampaignSteps(prog.campaignId)).filter((s) => s.enabled);
    const schedule = await this.scheduleFor(prog.accountId);
    const patch = advanceAfterStep(steps, prog.currentStep, now, schedule);
    await this.sequence.advanceTargetProgress(prog.id, patch);
    return { kind: 'executed', progressId: prog.id, actionId, nextStep: patch.currentStep! };
  }

  /** Cancel an approved-but-unsent message (terminal 'cancelled') and record an
   * audit event. Called when a pre-send guard fires (reply / suppression / lost /
   * missing target). Also pulls the target from the funnel so a cursor parked in
   * awaiting_approval goes terminal instead of stalling invisibly with no message
   * left to send (a no-op when the enrollment is already terminal). */
  private async cancelApproved(
    msg: MessageRow,
    progressId: string | undefined,
    reason: string,
  ): Promise<StepOutcome> {
    await this.messages.setStatus(msg.id, 'cancelled');
    await this.sequence.pullTargetFromFunnel(msg.targetId, reason);
    this.logEvent('approved_send_cancelled', msg.accountId, {
      messageId: msg.id,
      targetId: msg.targetId,
      reason,
    });
    return { kind: 'cancelled', progressId: progressId ?? msg.targetId, messageId: msg.id, reason };
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
      await this.sequence.advanceTargetProgress(progress.id, {
        state: 'completed',
        nextStepAt: null,
      });
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
      const schedule = await this.scheduleFor(progress.accountId);
      await this.sequence.advanceTargetProgress(progress.id, {
        currentStep: nextIdx,
        nextStepAt: dueAfterDelay(now, nextStep.delaySeconds, schedule),
        lastStepAt: now,
      });
      return { kind: 'delayed', progressId: progress.id, nextStep: nextIdx };
    }

    // The body carried to the gate for approval. Personalized in place for a
    // message step below, so the operator reviews the real text, not raw tokens.
    let draftBody = draftBodyFor(step);

    // A message step fires ONLY from a plain 'connected' stage.
    if (step.stepType === 'message') {
      const target = await this.targets.findById(progress.targetId);
      // Past 'connected' a human owns the live thread: pull the target from the
      // funnel so the cursor goes terminal instead of holding forever.
      if (target && SEQUENCE_STOP_STAGES.has(target.stage)) {
        const reason = `stage_${target.stage}`;
        await this.sequence.pullTargetFromFunnel(progress.targetId, reason);
        return { kind: 'held', progressId: progress.id, reason };
      }
      // Before 'connected' (or target gone): not yet a 1st-degree connection, so
      // hold WITHOUT firing and leave the cursor for a later tick.
      if (target?.stage !== 'connected') {
        return { kind: 'held', progressId: progress.id, reason: 'not_connected' };
      }
      // A hard-suppressed person must never receive a message: pull the funnel.
      if (this.suppression && (await this.suppression.isSuppressed(progress.targetId))) {
        await this.sequence.pullTargetFromFunnel(progress.targetId, 'suppressed');
        return { kind: 'held', progressId: progress.id, reason: 'suppressed' };
      }
      // Draft-time reply probe: catch a reply that landed while this step waited on
      // its delay. True -> the probe routed it (funnel pulled), so hold. Throw ->
      // a BROKEN reply lane must NOT block drafting: log reply_probe_failed and
      // PROCEED to the gate, which parks the draft awaiting_approval. The actual
      // SEND is separately fail-closed by the send-time probe in sendApproved
      // (throw -> no send, retry next tick), so a human still approves a draft that
      // re-probes before it goes out. We never SEND on a broken lane; drafting is
      // safe because approval re-probes.
      //
      // EXCEPT under autonomous autonomy: there the gate executes the message
      // immediately (mayExecuteDirectly), no human and no send-time re-probe sit
      // between this point and the send, so proceeding on a broken lane WOULD
      // send. Autonomous campaigns therefore keep the old fail-closed behavior:
      // hold and retry next tick.
      if (this.replyProbe) {
        const since = progress.lastStepAt ?? progress.createdAt;
        let replied = false;
        try {
          replied = await this.replyProbe.check(progress.accountId, target, since);
        } catch {
          this.logEvent('reply_probe_failed', progress.accountId, {
            progressId: progress.id,
            targetId: progress.targetId,
          });
          const campaign = await this.gate.safety.getCampaign(progress.campaignId);
          if (mayExecuteDirectly(campaign.autonomyLevel, 'message')) {
            return { kind: 'held', progressId: progress.id, reason: 'reply_probe_failed' };
          }
        }
        if (replied) {
          this.logEvent('step_held_reply', progress.accountId, {
            progressId: progress.id,
            targetId: progress.targetId,
          });
          return { kind: 'held', progressId: progress.id, reason: 'replied' };
        }
      }

      // Personalize the draft NOW (target is a live 'connected' row here), so the
      // stored draft the operator reads/edits/approves is the real text. The
      // executor re-runs personalizeBody at send time; that is a no-op once the
      // tokens are already resolved.
      if (target) {
        draftBody = personalizeBody(draftBody ?? '', {
          ...target,
          externalContext: target.externalContext as Json,
        });
      }
    }

    // A hard-suppressed person must never receive an invite either.
    if (
      step.stepType === 'connect' &&
      this.suppression &&
      (await this.suppression.isSuppressed(progress.targetId))
    ) {
      await this.sequence.pullTargetFromFunnel(progress.targetId, 'suppressed');
      return { kind: 'held', progressId: progress.id, reason: 'suppressed' };
    }

    // Cross-campaign contact lock: never let two campaigns contact the same
    // person at once. Only connect/message are outbound contact; view/follow/
    // react are low-touch and not gated here.
    if (step.stepType === 'connect' || step.stepType === 'message') {
      const held = await this.heldByOtherCampaign(progress);
      if (held) {
        const payload = {
          progressId: progress.id,
          targetId: progress.targetId,
          linkedinUrn: held.linkedinUrn,
          otherCampaignId: held.campaignId,
          otherStage: held.stage,
        };
        if (CROSS_CAMPAIGN_HOLD_STAGES.has(held.stage)) {
          // Another campaign's invite to this person is still pending — hold and
          // leave the cursor for a later tick; it resolves when that invite is
          // accepted (-> we then eject) or withdrawn (-> we proceed).
          this.logEvent('step_held_cross_campaign', progress.accountId, payload);
          return { kind: 'held', progressId: progress.id, reason: 'cross_campaign_active' };
        }
        // The person is already landed/engaged (connected / in_conversation /
        // replied / won) in another campaign. That stage can rest forever, so
        // holding would livelock — eject this target cleanly instead, with a
        // visible reason, rather than silently pile a second touch on them.
        this.logEvent('target_skipped_cross_campaign', progress.accountId, payload);
        await this.sequence.excludeTargetFromFunnel(progress.targetId, 'cross_campaign_contacted');
        await this.targets.setStage(progress.targetId, 'lost');
        return { kind: 'held', progressId: progress.id, reason: 'cross_campaign_contacted' };
      }
    }

    // Action step: route through the SAME gate + executor path as the Act tools.
    const req = actRequestFor(step.stepType, step, progress);
    let outcome: GateOutcome;
    try {
      outcome = await gateAct(this.gate, req, draftBody);
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

    // Executed. Advance to the next step (or complete) with the shared rule,
    // day-aligning the next due time to the account's working schedule.
    const schedule = await this.scheduleFor(progress.accountId);
    const patch = advanceAfterStep(steps, idx, now, schedule);
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
