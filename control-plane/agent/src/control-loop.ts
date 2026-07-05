// The agent control loop: observe -> personalize -> pace -> act -> ingest ->
// classify -> draft, expressed as an orchestrated, stepwise state machine over
// PORTs. It never touches the browser or the DB directly. Every send and every
// drafted reply stops at the human gate in v1: the loop produces a pending item
// and does not auto-send.
//
// The loop is resumable: runStep advances one phase and returns the next state,
// so a caller (or a test) can drive it one step at a time. runToStop drives it
// until it reaches a terminal or gated phase.

import type { Action, Message, Thread } from '@loa/shared';
import type { LoopContext, LoopPorts, ObservedMessage } from './ports.js';

/** The phases the loop moves through for a single target. */
export type LoopPhase =
  | 'observe'
  | 'personalize'
  | 'pace'
  | 'act'
  | 'ingest'
  | 'classify'
  | 'draft'
  | 'awaiting_approval' // gated: a pending send/reply is waiting on a human
  | 'deferred' // safety said defer; caller reschedules
  | 'suppressed' // target is hard-suppressed; do nothing
  | 'done';

export interface LoopState {
  phase: LoopPhase;
  ctx: LoopContext;
  /** Inbound observed this pass, threaded through ingest/classify/draft. */
  inbox: ObservedMessage[];
  /** Refs to pending approval items produced this run, for the caller. */
  pendingRefs: string[];
  /** When phase is 'deferred', the time the caller should retry after. */
  deferUntil?: Date;
  /** Human-readable note about the last transition, for logs and tests. */
  note?: string;
  /** Personalized opener body carried from personalize -> act. */
  draftBody?: string;
  /** Inbound rows persisted in ingest, carried into classify. */
  stored?: Message[];
  /** The message classified in classify, carried into draft. */
  classified?: Message;
  /** The intent produced in classify, carried into draft. */
  intent?: Message['intent'];
}

export function initialState(ctx: LoopContext): LoopState {
  return { phase: 'observe', ctx, inbox: [], pendingRefs: [] };
}

/**
 * Advance the loop by exactly one phase. Pure with respect to control flow: it
 * reads/writes only through ports and returns the next state. Safe to call in a
 * loop, or one step at a time from a test.
 */
export async function runStep(state: LoopState, ports: LoopPorts): Promise<LoopState> {
  const { ctx } = state;
  switch (state.phase) {
    case 'observe': {
      // A hard-suppressed target short-circuits everything.
      if (await ports.persistence.isSuppressed(ctx.target.id)) {
        return { ...state, phase: 'suppressed', note: 'target suppressed' };
      }
      const obs = await ports.executor.observe(ctx.account, ctx.target);
      await ports.persistence.recordEvent('observed', ctx.account.id, {
        targetId: ctx.target.id,
        inboundCount: obs.inbound.length,
      });
      // If there is new inbound, ingest it before considering an opener.
      if (obs.inbound.length > 0) {
        return { ...state, phase: 'ingest', inbox: obs.inbound };
      }
      return { ...state, phase: 'personalize', inbox: [] };
    }

    case 'personalize': {
      const draft = await ports.llm.personalize({
        target: ctx.target,
        account: ctx.account,
        campaign: ctx.campaign,
        history: [],
      });
      await ports.persistence.recordEvent('personalized', ctx.account.id, {
        targetId: ctx.target.id,
        model: draft.model,
      });
      return { ...state, phase: 'pace', inbox: [], draftBody: draft.body, deferUntil: undefined };
    }

    case 'pace': {
      // Safety gate before every act. We describe the intended send as an Action
      // shell for canAct; the executor mints the real row only if we ever act.
      const shell = actionShell(ctx, 'message');
      const decision = ports.safety.canAct(ctx.account, shell);
      if (decision.kind === 'deny') {
        await ports.persistence.recordEvent('paced_deny', ctx.account.id, {
          targetId: ctx.target.id,
          reason: decision.reason,
        });
        return { ...state, phase: 'done', note: `denied: ${decision.reason}` };
      }
      if (decision.kind === 'defer') {
        await ports.persistence.recordEvent('paced_defer', ctx.account.id, {
          targetId: ctx.target.id,
          until: decision.until.toISOString(),
        });
        return { ...state, phase: 'deferred', deferUntil: decision.until };
      }
      return { ...state, phase: 'act' };
    }

    case 'act': {
      // Human gate: in v1 we never auto-send. We enqueue the personalized draft
      // as a pending approval item and stop.
      const body = state.draftBody ?? '';
      const { pendingItemRef } = await ports.persistence.enqueuePendingSend({
        accountId: ctx.account.id,
        targetId: ctx.target.id,
        campaignId: ctx.campaign.id,
        draft: { body },
      });
      await ports.persistence.recordEvent('pending_send_enqueued', ctx.account.id, {
        targetId: ctx.target.id,
        pendingItemRef,
      });
      return {
        ...state,
        phase: 'awaiting_approval',
        pendingRefs: [...state.pendingRefs, pendingItemRef],
        note: 'send awaiting approval',
      };
    }

    case 'ingest': {
      // Persist each observed inbound message. Classification happens next.
      const stored: Message[] = [];
      for (const raw of state.inbox) {
        stored.push(await ports.persistence.recordInboundMessage(raw));
      }
      await ports.persistence.recordEvent('ingested', ctx.account.id, {
        targetId: ctx.target.id,
        count: stored.length,
      });
      return { ...state, phase: 'classify', note: undefined, stored };
    }

    case 'classify': {
      const stored = state.stored ?? [];
      // Classify the most recent inbound message; that drives the reply.
      const last = stored[stored.length - 1];
      if (!last) {
        return { ...state, phase: 'done', note: 'nothing to classify' };
      }
      const intent = await ports.llm.classifyReply(last);
      await ports.persistence.recordEvent('classified', ctx.account.id, {
        targetId: ctx.target.id,
        messageId: last.id,
        intent,
      });
      return { ...state, phase: 'draft', classified: last, intent };
    }

    case 'draft': {
      const last = state.classified;
      const intent = state.intent;
      if (!last || !intent) {
        return { ...state, phase: 'done', note: 'nothing to draft' };
      }
      // Reply-intent routing is the orchestrator's job; the loop only drafts a
      // reply behind the human gate for the classified intent. Stop suppression
      // and follow-up scheduling are handled by the orchestrator's router.
      const thread: Thread = {
        threadRef: last.threadRef,
        target: ctx.target,
        account: ctx.account,
        messages: [last],
      };
      const draft = await ports.llm.draftReply(thread, intent);
      const { pendingItemRef } = await ports.persistence.enqueuePendingReply({
        accountId: ctx.account.id,
        targetId: ctx.target.id,
        campaignId: ctx.campaign.id,
        threadRef: last.threadRef,
        intent,
        draft,
      });
      await ports.persistence.recordEvent('pending_reply_enqueued', ctx.account.id, {
        targetId: ctx.target.id,
        pendingItemRef,
        intent,
      });
      return {
        ...state,
        phase: 'awaiting_approval',
        pendingRefs: [...state.pendingRefs, pendingItemRef],
        note: 'reply awaiting approval',
      };
    }

    case 'awaiting_approval':
    case 'deferred':
    case 'suppressed':
    case 'done':
      return state;

    default: {
      // Exhaustiveness guard.
      const never: never = state.phase;
      throw new Error(`unhandled loop phase: ${String(never)}`);
    }
  }
}

/** Phases at which the loop stops on its own. */
const TERMINAL: ReadonlySet<LoopPhase> = new Set<LoopPhase>([
  'awaiting_approval',
  'deferred',
  'suppressed',
  'done',
]);

export function isTerminal(phase: LoopPhase): boolean {
  return TERMINAL.has(phase);
}

/**
 * Drive the loop until it reaches a terminal or gated phase. maxSteps bounds the
 * walk so a mis-wired port can never spin forever.
 */
export async function runToStop(
  state: LoopState,
  ports: LoopPorts,
  maxSteps = 32,
): Promise<LoopState> {
  let cur = state;
  for (let i = 0; i < maxSteps; i++) {
    if (isTerminal(cur.phase)) {
      return cur;
    }
    cur = await runStep(cur, ports);
  }
  return cur;
}

/** Build an in-memory Action shell for a safety check, before any row exists. */
function actionShell(ctx: LoopContext, type: Action['type']): Action {
  const now = new Date();
  return {
    id: 'pending',
    type,
    scheduledAt: now,
    executedAt: null,
    result: 'pending',
    dedupKey: `${ctx.account.id}:${ctx.target.id}:${type}`,
    accountId: ctx.account.id,
    targetId: ctx.target.id,
    campaignId: ctx.campaign.id,
    createdAt: now,
    updatedAt: now,
  };
}
