import { describe, it, expect } from 'vitest';
import type { Target } from '@loa/shared';
import { LiveSessionProvider } from './session-provider.js';

function target(linkedinUrn: string): Target {
  const now = new Date();
  return {
    id: 't1',
    prospectRef: 'crm:1',
    linkedinUrn,
    externalContext: {},
    stage: 'sourced',
    campaignId: 'c1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('LiveSessionProvider.profileUrlFor', () => {
  const provider = new LiveSessionProvider({
    profileDir: '/tmp/p',
    vaultDir: '/tmp/v',
    allowNoProxy: true,
  });

  it('passes through an absolute LinkedIn URL', () => {
    expect(provider.profileUrlFor(target('https://www.linkedin.com/in/jane/'))).toBe(
      'https://www.linkedin.com/in/jane/',
    );
  });

  it('builds a profile URL from a person URN', () => {
    expect(provider.profileUrlFor(target('urn:li:person:ABC123'))).toBe(
      'https://www.linkedin.com/in/ABC123/',
    );
  });

  it('treats a bare handle as a public identifier', () => {
    expect(provider.profileUrlFor(target('janedoe'))).toBe(
      'https://www.linkedin.com/in/janedoe/',
    );
  });
});

describe('LiveSessionProvider proxy guard', () => {
  it('refuses to open a session with no proxy unless allowNoProxy', async () => {
    const provider = new LiveSessionProvider({
      profileDir: '/tmp/p',
      vaultDir: '/tmp/v',
      allowNoProxy: false,
    });
    await expect(provider.pageFor('acc-1')).rejects.toThrow(/proxy/i);
  });
});
