// OpenRouterLLMProvider implements the locked LLMProvider interface from
// @loa/shared against OpenRouter's OpenAI-compatible HTTP API. It is a fallback
// for autonomous runs; the framework's primary mode is being driven by an
// external agent over MCP, in which case no LLM key is needed at all.
//
// The HTTP call sits behind OpenRouterSeam so tests inject a fake fetch and run
// with no network. classifyReply constrains output to the REPLY_INTENTS enum via
// OpenAI tool-calling; if no valid tool call comes back it parses JSON, and if
// that also fails it defaults to NotInterested (the safest routing bucket),
// mirroring ClaudeLLMProvider.

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
import type { OpenRouterSeam, SeamTool } from './openrouter-seam.js';
import { OpenRouterClientSeam } from './openrouter-seam.js';

// anthropic/claude-fable-5 is a real OpenRouter model id (vendor/model form),
// confirmed against openrouter.ai/anthropic. Override via OPENROUTER_MODEL or the
// constructor.
const DEFAULT_MODEL = 'anthropic/claude-fable-5';

// A short human, plain-spoken voice. No em-dashes, no AI-isms, no hard sell.
const STYLE_RULES = [
  'Write like a real person sending a short LinkedIn note.',
  'Plain sentences. No em-dashes. No words like "delve", "seamless", "robust", "leverage".',
  'No wrap-up restatements. Do not repeat the heading or the previous sentence.',
  'Keep it under 60 words. One clear reason for reaching out. No hard sell.',
].join(' ');

// The classify tool constrains output to exactly one enum value.
const CLASSIFY_TOOL: SeamTool = {
  name: 'record_intent',
  description:
    'Record the single best-fitting intent for the inbound message. Choose exactly one.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [...REPLY_INTENTS],
        description: 'The one intent that best classifies the message.',
      },
    },
    required: ['intent'],
  },
};

function isReplyIntent(value: unknown): value is ReplyIntent {
  return typeof value === 'string' && (REPLY_INTENTS as readonly string[]).includes(value);
}

/** Best-effort extraction of an intent from free text (JSON or bare enum). */
function intentFromText(text: string): ReplyIntent | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  // First try to parse a JSON object with an "intent" field.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const candidate = (parsed as Record<string, unknown>)['intent'];
      if (isReplyIntent(candidate)) return candidate;
    }
  } catch {
    // Not JSON; fall through to a substring scan.
  }
  // Otherwise scan for a bare enum value anywhere in the text.
  for (const intent of REPLY_INTENTS) {
    if (trimmed.includes(intent)) return intent;
  }
  return undefined;
}

/** Compact JSON of the target context the model may use to personalize. */
function personalizeUserPrompt(ctx: TargetContext): string {
  const payload = {
    goal: ctx.campaign.goal,
    messageStrategy: ctx.campaign.messageStrategy,
    senderHandle: ctx.account.handle,
    prospectRef: ctx.target.prospectRef,
    linkedinUrn: ctx.target.linkedinUrn,
    externalContext: ctx.target.externalContext,
    priorMessages: ctx.history.map((m) => ({ direction: m.direction, body: m.body })),
  };
  return [
    'Write a short opening message to this LinkedIn prospect.',
    'Use the external context to find one specific, genuine reason to reach out.',
    'Return only the message body, no preamble and no signature.',
    '',
    'Context (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function draftReplyUserPrompt(thread: Thread, intent: Intent): string {
  const payload = {
    intent,
    senderHandle: thread.account.handle,
    prospectRef: thread.target.prospectRef,
    messages: thread.messages.map((m) => ({ direction: m.direction, body: m.body })),
  };
  return [
    `Write a reply to this LinkedIn conversation. The inbound message was classified as "${intent}".`,
    replyGuidanceForIntent(intent),
    'Return only the reply body, no preamble and no signature.',
    '',
    'Conversation (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

// Per-intent guidance keeps the reply appropriate to what the person said.
function replyGuidanceForIntent(intent: Intent): string {
  switch (intent) {
    case 'Interested':
      return 'They are interested. Suggest one concrete, low-friction next step.';
    case 'Question':
      return 'They asked something. Answer it directly and briefly, then offer to go deeper.';
    case 'Referral':
      return 'They pointed to someone else. Thank them and ask for a warm introduction.';
    case 'Objection':
      return 'They raised a concern. Acknowledge it honestly and address it in one or two sentences.';
    case 'NotNow':
      return 'The timing is wrong for them. Be gracious and offer to follow up later.';
    case 'OutOfOffice':
      return 'This is an auto-reply. Write a brief note to resend when they are back.';
    case 'NotInterested':
      return 'They are not interested. Thank them, leave the door open, and do not push.';
    case 'Stop':
      return 'They asked to stop. Acknowledge and confirm you will not message again. Keep it to one sentence.';
    default:
      return 'Reply appropriately and briefly.';
  }
}

export interface OpenRouterLLMProviderOptions {
  seam?: OpenRouterSeam;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  siteUrl?: string;
  appTitle?: string;
}

export class OpenRouterLLMProvider implements LLMProvider {
  private readonly seam: OpenRouterSeam;
  private readonly model: string;

  constructor(opts: OpenRouterLLMProviderOptions = {}) {
    this.model = opts.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    this.seam =
      opts.seam ??
      new OpenRouterClientSeam({
        apiKey: opts.apiKey,
        model: this.model,
        baseUrl: opts.baseUrl,
        siteUrl: opts.siteUrl,
        appTitle: opts.appTitle,
      });
  }

  async personalize(ctx: TargetContext): Promise<Draft> {
    const res = await this.seam.send({
      system: `You are drafting outbound LinkedIn openers. ${STYLE_RULES}`,
      user: personalizeUserPrompt(ctx),
      maxTokens: 512,
    });
    if (res.refused) {
      throw new Error('LLM refused to personalize this target');
    }
    return { body: res.text.trim(), model: res.model };
  }

  async classifyReply(msg: Message): Promise<Intent> {
    const res = await this.seam.send({
      system:
        'You classify inbound LinkedIn replies into exactly one intent. Always call the record_intent tool.',
      user: `Classify this inbound message.\n\nMessage:\n${msg.body}`,
      tools: [CLASSIFY_TOOL],
      forceTool: 'record_intent',
      maxTokens: 256,
    });
    // A refusal defaults to the safest routing bucket.
    if (res.refused) {
      return 'NotInterested';
    }
    // Prefer a valid tool call.
    const candidate = res.toolUse?.input?.['intent'];
    if (isReplyIntent(candidate)) {
      return candidate;
    }
    // Some models/endpoints skip tool calls; fall back to parsing the text.
    const fromText = intentFromText(res.text);
    if (fromText) {
      return fromText;
    }
    // Nothing usable: default to the safest bucket.
    return 'NotInterested';
  }

  async draftReply(thread: Thread, intent: Intent): Promise<Draft> {
    const res = await this.seam.send({
      system: `You are drafting replies in an ongoing LinkedIn conversation. ${STYLE_RULES}`,
      user: draftReplyUserPrompt(thread, intent),
      maxTokens: 512,
    });
    if (res.refused) {
      throw new Error('LLM refused to draft this reply');
    }
    return { body: res.text.trim(), model: res.model };
  }
}
