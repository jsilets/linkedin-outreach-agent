// A narrow seam over OpenRouter's OpenAI-compatible chat-completions API. The
// OpenRouterLLMProvider depends on this interface, not on any SDK, so unit tests
// inject a fake transport and run with no network. It mirrors AnthropicSeam so
// the two providers share the same request/result shape.

import type { SeamRequest, SeamResult, SeamTool, SeamToolUse } from './anthropic-seam.js';

export type { SeamRequest, SeamResult, SeamTool };

/** The seam the OpenRouter provider depends on. */
export interface OpenRouterSeam {
  send(req: SeamRequest): Promise<SeamResult>;
}

/** Minimal transport: the subset of the global fetch we use. Injectable for tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
// anthropic/claude-fable-5 is a real OpenRouter model id (vendor/model form),
// confirmed against openrouter.ai/anthropic. Override via OPENROUTER_MODEL.
const DEFAULT_MODEL = 'anthropic/claude-fable-5';

export interface OpenRouterClientSeamOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Optional OpenRouter attribution headers. */
  siteUrl?: string;
  appTitle?: string;
  /** Inject a fake for tests; defaults to the global fetch. */
  fetch?: FetchLike;
}

// The shapes we read out of an OpenAI-compatible chat-completion response. We
// keep them loose because we validate the pieces we actually use.
interface ChatToolCall {
  function?: { name?: string; arguments?: string };
}
interface ChatMessage {
  content?: string | null;
  tool_calls?: ChatToolCall[];
  refusal?: string | null;
}
interface ChatChoice {
  message?: ChatMessage;
  finish_reason?: string;
}
interface ChatResponse {
  model?: string;
  choices?: ChatChoice[];
}

/**
 * Real seam backed by the global fetch against OpenRouter. Handles non-200s and
 * refusals gracefully: a non-200 throws (so the provider surfaces a hard error),
 * while a model-level refusal (OpenAI `refusal` field) is normalized to
 * refused: true, matching how the Anthropic seam treats stop_reason "refusal".
 */
export class OpenRouterClientSeam implements OpenRouterSeam {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly siteUrl?: string;
  private readonly appTitle?: string;
  private readonly doFetch: FetchLike;

  constructor(opts: OpenRouterClientSeamOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.model = opts.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.siteUrl = opts.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.appTitle = opts.appTitle ?? process.env.OPENROUTER_APP_TITLE;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async send(req: SeamRequest): Promise<SeamResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl;
    if (this.appTitle) headers['X-Title'] = this.appTitle;

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toOpenAiTool);
      if (req.forceTool) {
        body.tool_choice = {
          type: 'function',
          function: { name: req.forceTool },
        };
      }
    }

    const res = await this.doFetch(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`OpenRouter request failed: ${res.status} ${detail}`);
    }

    const parsed = parseResponse(await res.text());
    const choice = parsed.choices?.[0];
    const message = choice?.message;
    const model = parsed.model ?? this.model;

    if (message?.refusal) {
      return { text: '', refused: true, model };
    }

    const text = typeof message?.content === 'string' ? message.content : '';
    const toolUse = firstToolUse(message?.tool_calls);
    return { text, toolUse, refused: false, model };
  }
}

/** Map our SeamTool (Anthropic-shaped) to the OpenAI function-tool shape. */
function toOpenAiTool(tool: SeamTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** Pull the first tool call and parse its JSON arguments; undefined if unusable. */
function firstToolUse(calls: ChatToolCall[] | undefined): SeamToolUse | undefined {
  const call = calls?.[0]?.function;
  if (!call?.name) return undefined;
  let input: Record<string, unknown> = {};
  if (typeof call.arguments === 'string' && call.arguments.trim() !== '') {
    try {
      const parsed = JSON.parse(call.arguments);
      if (parsed && typeof parsed === 'object') {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed arguments: leave input empty so the provider falls back.
    }
  }
  return { name: call.name, input };
}

function parseResponse(raw: string): ChatResponse {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as ChatResponse;
  } catch {
    // Fall through to an empty response; the provider handles the empty case.
  }
  return {};
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
