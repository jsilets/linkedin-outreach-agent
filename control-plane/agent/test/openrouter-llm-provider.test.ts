// OpenRouterLLMProvider unit tests. A fake fetch transport stands in for the
// network: each test scripts the raw OpenAI-compatible response body the seam
// would receive, then asserts the provider maps it onto the LLMProvider contract.

import { describe, expect, it } from 'vitest';
import { REPLY_INTENTS } from '@loa/shared';
import { OpenRouterLLMProvider } from '../src/openrouter-llm-provider.js';
import { OpenRouterClientSeam, type FetchLike } from '../src/openrouter-seam.js';
import {
  fakeAccount,
  fakeCampaign,
  fakeMessage,
  fakeTarget,
} from './fakes.js';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a fake fetch that returns a scripted 200 body and records the request. */
function fakeFetch(
  responseBody: unknown,
  opts: { status?: number; ok?: boolean } = {},
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      async text() {
        return typeof responseBody === 'string'
          ? responseBody
          : JSON.stringify(responseBody);
      },
    };
  };
  return { fetch, calls };
}

/** An OpenAI-compatible chat response carrying a text message. */
function textResponse(content: string, model = 'anthropic/claude-fable-5'): unknown {
  return { model, choices: [{ message: { content } }] };
}

/** An OpenAI-compatible chat response carrying a single tool call. */
function toolResponse(args: unknown, model = 'anthropic/claude-fable-5'): unknown {
  return {
    model,
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              function: {
                name: 'record_intent',
                arguments: typeof args === 'string' ? args : JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function providerWith(responseBody: unknown, opts: { status?: number; ok?: boolean } = {}) {
  const { fetch, calls } = fakeFetch(responseBody, opts);
  const seam = new OpenRouterClientSeam({ apiKey: 'test-key', fetch });
  return { provider: new OpenRouterLLMProvider({ seam }), calls };
}

describe('OpenRouterLLMProvider.personalize', () => {
  it('returns a trimmed Draft carrying the model id', async () => {
    const { provider, calls } = providerWith(textResponse('  Loved your ops talk.  '));
    const draft = await provider.personalize({
      target: fakeTarget(),
      account: fakeAccount(),
      campaign: fakeCampaign(),
      history: [],
    });
    expect(draft.body).toBe('Loved your ops talk.');
    expect(draft.model).toBe('anthropic/claude-fable-5');
    // It POSTed to OpenRouter with a bearer token and a system+user message pair.
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer test-key');
    const body = calls[0]!.body as { messages: { role: string }[] };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('throws when the model refuses', async () => {
    const { provider } = providerWith({
      choices: [{ message: { refusal: 'I cannot help with that.' } }],
    });
    await expect(
      provider.personalize({
        target: fakeTarget(),
        account: fakeAccount(),
        campaign: fakeCampaign(),
        history: [],
      }),
    ).rejects.toThrow(/refused/);
  });
});

describe('OpenRouterLLMProvider.classifyReply', () => {
  it('maps an inbound to a valid ReplyIntent via a tool call, and forces the tool', async () => {
    const { provider, calls } = providerWith(toolResponse({ intent: 'Interested' }));
    const got = await provider.classifyReply(
      fakeMessage({ body: 'Yes, this sounds great, let us talk' }),
    );
    expect(got).toBe('Interested');
    expect(REPLY_INTENTS).toContain(got);
    // The request must constrain output: a record_intent function tool, forced.
    const body = calls[0]!.body as {
      tools?: { function?: { name?: string; parameters?: unknown } }[];
      tool_choice?: { type?: string; function?: { name?: string } };
    };
    expect(body.tools?.[0]?.function?.name).toBe('record_intent');
    expect(body.tool_choice).toMatchObject({
      type: 'function',
      function: { name: 'record_intent' },
    });
    expect(body.tools?.[0]?.function?.parameters).toMatchObject({
      properties: { intent: { enum: [...REPLY_INTENTS] } },
    });
  });

  it('falls back to parsing JSON text when no tool call is returned', async () => {
    const { provider } = providerWith(textResponse('{"intent": "Question"}'));
    const got = await provider.classifyReply(fakeMessage({ body: 'what does it do?' }));
    expect(got).toBe('Question');
  });

  it('defaults to NotInterested on a malformed tool call', async () => {
    const { provider } = providerWith(toolResponse({ intent: 'Bananas' }));
    const got = await provider.classifyReply(fakeMessage());
    expect(REPLY_INTENTS).toContain(got);
    expect(got).toBe('NotInterested');
  });

  it('defaults to NotInterested on unparseable tool arguments and empty text', async () => {
    const { provider } = providerWith(toolResponse('not json at all'));
    const got = await provider.classifyReply(fakeMessage());
    expect(got).toBe('NotInterested');
  });

  it('defaults to NotInterested on a refusal', async () => {
    const { provider } = providerWith({
      choices: [{ message: { refusal: 'no' } }],
    });
    const got = await provider.classifyReply(fakeMessage());
    expect(got).toBe('NotInterested');
  });
});

describe('OpenRouterLLMProvider.draftReply', () => {
  it('drafts a reply and passes the intent into the prompt', async () => {
    const { provider, calls } = providerWith(textResponse('Happy to set up 20 minutes.'));
    const draft = await provider.draftReply(
      {
        threadRef: 'thread-1',
        target: fakeTarget(),
        account: fakeAccount(),
        messages: [fakeMessage({ body: 'yes lets talk' })],
      },
      'Interested',
    );
    expect(draft.body).toBe('Happy to set up 20 minutes.');
    const body = calls[0]!.body as { messages: { role: string; content: string }[] };
    const userTurn = body.messages.find((m) => m.role === 'user')!;
    expect(userTurn.content).toContain('Interested');
  });
});

describe('OpenRouterClientSeam transport', () => {
  it('throws on a non-200 response', async () => {
    const { fetch } = fakeFetch('rate limited', { ok: false, status: 429 });
    const seam = new OpenRouterClientSeam({ apiKey: 'k', fetch });
    await expect(
      seam.send({ system: 's', user: 'u' }),
    ).rejects.toThrow(/OpenRouter request failed: 429/);
  });

  it('adds attribution headers only when configured', async () => {
    const { fetch, calls } = fakeFetch(textResponse('hi'));
    const seam = new OpenRouterClientSeam({
      apiKey: 'k',
      fetch,
      siteUrl: 'https://example.com',
      appTitle: 'LOA',
    });
    await seam.send({ system: 's', user: 'u' });
    expect(calls[0]!.headers['HTTP-Referer']).toBe('https://example.com');
    expect(calls[0]!.headers['X-Title']).toBe('LOA');
  });
});
