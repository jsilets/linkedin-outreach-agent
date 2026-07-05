import { describe, expect, it } from 'vitest';
import { REPLY_INTENTS } from '@loa/shared';
import { ClaudeLLMProvider } from '../src/llm-provider.js';
import {
  FakeSeam,
  fakeAccount,
  fakeCampaign,
  fakeMessage,
  fakeTarget,
  refusalResult,
  textResult,
  toolResult,
} from './fakes.js';

describe('ClaudeLLMProvider.classifyReply', () => {
  it('maps each sample message to the right enum via the forced tool call', async () => {
    const samples: { body: string; intent: (typeof REPLY_INTENTS)[number] }[] = [
      { body: 'Yes, this sounds great, let us talk', intent: 'Interested' },
      { body: 'What exactly does your product do?', intent: 'Question' },
      { body: 'You should talk to my colleague Dana', intent: 'Referral' },
      { body: 'We already use a competitor and are happy', intent: 'Objection' },
      { body: 'Circle back next quarter', intent: 'NotNow' },
      { body: 'I am on vacation until August', intent: 'OutOfOffice' },
      { body: 'Not for us, thanks', intent: 'NotInterested' },
      { body: 'Please stop messaging me', intent: 'Stop' },
    ];

    for (const sample of samples) {
      const seam = new FakeSeam(() => toolResult({ intent: sample.intent }));
      const provider = new ClaudeLLMProvider({ seam });
      const got = await provider.classifyReply(fakeMessage({ body: sample.body }));
      expect(got).toBe(sample.intent);
      // The request must force the record_intent tool with the enum schema.
      const req = seam.requests[0]!;
      expect(req.forceTool).toBe('record_intent');
      expect(req.tools?.[0]?.input_schema.properties.intent).toMatchObject({
        enum: [...REPLY_INTENTS],
      });
    }
  });

  it('falls back to a safe enum on a malformed tool call', async () => {
    const seam = new FakeSeam(() => toolResult({ intent: 'Bananas' }));
    const provider = new ClaudeLLMProvider({ seam });
    const got = await provider.classifyReply(fakeMessage());
    expect(REPLY_INTENTS).toContain(got);
    expect(got).toBe('NotInterested');
  });

  it('falls back to a safe enum on a refusal', async () => {
    const seam = new FakeSeam(() => refusalResult());
    const provider = new ClaudeLLMProvider({ seam });
    const got = await provider.classifyReply(fakeMessage());
    expect(got).toBe('NotInterested');
  });
});

describe('ClaudeLLMProvider.personalize', () => {
  it('returns a trimmed opener with the model id', async () => {
    const seam = new FakeSeam(() => textResult('  Loved your talk on ops.  '));
    const provider = new ClaudeLLMProvider({ seam });
    const draft = await provider.personalize({
      target: fakeTarget(),
      account: fakeAccount(),
      campaign: fakeCampaign(),
      history: [],
    });
    expect(draft.body).toBe('Loved your talk on ops.');
    expect(draft.model).toBe('fake-model');
  });

  it('throws when the model refuses', async () => {
    const seam = new FakeSeam(() => refusalResult());
    const provider = new ClaudeLLMProvider({ seam });
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

describe('ClaudeLLMProvider.draftReply', () => {
  it('drafts a reply for the given intent', async () => {
    const seam = new FakeSeam(() => textResult('Happy to set up 20 minutes.'));
    const provider = new ClaudeLLMProvider({ seam });
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
    // The intent must reach the prompt so the reply is appropriate.
    expect(seam.requests[0]!.user).toContain('Interested');
  });
});
