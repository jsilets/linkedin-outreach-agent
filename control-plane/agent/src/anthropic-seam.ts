// A narrow seam over the Anthropic Messages API. The control loop and the
// LLM provider depend on this interface, not on @anthropic-ai/sdk directly, so
// unit tests can inject a fake and run with no network.

import Anthropic from '@anthropic-ai/sdk';

/** A single tool the model may call. Mirrors the Anthropic tool shape we use. */
export interface SeamTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** What we send on each request. Kept minimal on purpose. */
export interface SeamRequest {
  system: string;
  /** The single user turn. We do not build multi-turn transcripts here. */
  user: string;
  /** Optional tools; when present we force a single tool call. */
  tools?: SeamTool[];
  /** Force this tool to be called (constrained output). */
  forceTool?: string;
  maxTokens?: number;
}

/** A tool call the model produced. */
export interface SeamToolUse {
  name: string;
  input: Record<string, unknown>;
}

/** Normalized result of one message request. */
export interface SeamResult {
  /** Concatenated text blocks, if any. */
  text: string;
  /** The first tool_use block, if any. */
  toolUse?: SeamToolUse;
  /** True when the model declined (safety classifier or model refusal). */
  refused: boolean;
  /** Model id that produced the response, for audit. */
  model: string;
}

/** The seam the provider depends on. */
export interface AnthropicSeam {
  send(req: SeamRequest): Promise<SeamResult>;
}

/**
 * Real seam backed by @anthropic-ai/sdk. Default model claude-fable-5.
 * Fable 5 has always-on thinking, so we do not pass a thinking parameter, and
 * we do not pass temperature. Refusals arrive as stop_reason "refusal" on a
 * 200; we surface that as refused rather than throwing.
 */
export class AnthropicClientSeam implements AnthropicSeam {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string; client?: Anthropic } = {}) {
    this.model = opts.model ?? process.env.LOA_LLM_MODEL ?? 'claude-fable-5';
    this.client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async send(req: SeamRequest): Promise<SeamResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    };
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools as unknown as Anthropic.Tool[];
      if (req.forceTool) {
        params.tool_choice = { type: 'tool', name: req.forceTool };
      }
    }

    const res = await this.client.messages.create(params);

    if (res.stop_reason === 'refusal') {
      return { text: '', refused: true, model: res.model };
    }

    let text = '';
    let toolUse: SeamToolUse | undefined;
    for (const block of res.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolUse = {
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        };
      }
    }
    return { text, toolUse, refused: false, model: res.model };
  }
}
