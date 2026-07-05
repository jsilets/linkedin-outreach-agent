// FakeLLMProvider: a deterministic, offline LLMProvider so the loop runs with no
// ANTHROPIC_API_KEY. personalize/draftReply return plain short copy; classify
// maps the message body to a valid ReplyIntent by keyword, defaulting to the
// safest bucket (NotInterested) when nothing matches. Used by dev and smoke.

import { REPLY_INTENTS } from '@loa/shared';
import type {
  Draft,
  Intent,
  LLMProvider,
  Message,
  ReplyIntent,
  TargetContext,
  Thread,
} from '@loa/shared';

const MODEL = 'fake-llm-1';

/** Ordered keyword rules; first match wins. Keeps classify deterministic. */
const INTENT_RULES: Array<{ intent: ReplyIntent; test: (s: string) => boolean }> = [
  { intent: 'Stop', test: (s) => /\bstop\b|unsubscribe|remove me|do not contact/.test(s) },
  { intent: 'NotInterested', test: (s) => /not interested|no thanks|not a fit/.test(s) },
  { intent: 'OutOfOffice', test: (s) => /out of office|on leave|vacation|ooo\b/.test(s) },
  { intent: 'NotNow', test: (s) => /not now|later|next quarter|circle back|busy right now/.test(s) },
  { intent: 'Referral', test: (s) => /talk to|reach out to|my colleague|refer you|speak with/.test(s) },
  { intent: 'Objection', test: (s) => /too expensive|already use|concern|not sure this/.test(s) },
  { intent: 'Question', test: (s) => /\?|how does|what about|can you|could you/.test(s) },
  { intent: 'Interested', test: (s) => /interested|tell me more|sounds good|let's talk|keen/.test(s) },
];

function isReplyIntent(v: unknown): v is ReplyIntent {
  return typeof v === 'string' && (REPLY_INTENTS as readonly string[]).includes(v);
}

export class FakeLLMProvider implements LLMProvider {
  async personalize(ctx: TargetContext): Promise<Draft> {
    const who = ctx.target.prospectRef;
    const goal = ctx.campaign.goal;
    return {
      body: `Hi ${who}, reaching out about ${goal}. Would a short chat be useful?`,
      confidence: 0.9,
      model: MODEL,
    };
  }

  async classifyReply(msg: Message): Promise<Intent> {
    const body = msg.body.toLowerCase();
    for (const rule of INTENT_RULES) {
      if (rule.test(body)) return rule.intent;
    }
    return 'NotInterested';
  }

  async draftReply(thread: Thread, intent: Intent): Promise<Draft> {
    const last = thread.messages[thread.messages.length - 1];
    const snippet = last ? last.body.slice(0, 40) : '';
    const safeIntent: ReplyIntent = isReplyIntent(intent) ? intent : 'NotInterested';
    return {
      body: `Thanks for the reply (${safeIntent}). On "${snippet}", happy to share more when it helps.`,
      confidence: 0.85,
      model: MODEL,
    };
  }
}
