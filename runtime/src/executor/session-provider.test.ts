import { access, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Target } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import { clearSingletonLocks, LiveSessionProvider } from './session-provider.js';

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
    expect(provider.profileUrlFor(target('janedoe'))).toBe('https://www.linkedin.com/in/janedoe/');
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

describe('clearSingletonLocks', () => {
  const missing = (p: string) =>
    access(p).then(
      () => false,
      () => true,
    );

  it('removes a stale SingletonLock symlink and sibling guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loa-profile-'));
    // A container restart leaves SingletonLock as a symlink to a dead host/pid.
    await symlink('some-old-host-4242', join(dir, 'SingletonLock'));
    await writeFile(join(dir, 'SingletonCookie'), '1');
    await writeFile(join(dir, 'SingletonSocket'), '1');
    await writeFile(join(dir, 'Cookies'), 'keep-me');

    await clearSingletonLocks(dir);

    expect(await missing(join(dir, 'SingletonLock'))).toBe(true);
    expect(await missing(join(dir, 'SingletonCookie'))).toBe(true);
    expect(await missing(join(dir, 'SingletonSocket'))).toBe(true);
    // Only the singleton guards go; the real profile is untouched.
    expect(await missing(join(dir, 'Cookies'))).toBe(false);
  });

  it('does not throw when the profile dir has no locks (or does not exist)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loa-profile-'));
    await expect(clearSingletonLocks(dir)).resolves.toBeUndefined();
    await expect(clearSingletonLocks(join(dir, 'nope'))).resolves.toBeUndefined();
  });
});
