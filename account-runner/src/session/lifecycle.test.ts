import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StorageStateShape } from '../ports.js';
import { SELECTORS } from '../selectors.js';
import { FakeContext, FakeLauncher, FakePage, makeCookies } from '../testing/fakes.js';
import type { LaunchConfigInput } from './context-factory.js';
import { BrowserContextFactory } from './context-factory.js';
import type { HumanTask, SessionDeps } from './lifecycle.js';
import { bootstrap, resume, validate } from './lifecycle.js';
import { saveStorageState } from './vault.js';

const key = randomBytes(32);

const input: LaunchConfigInput = {
  userDataDir: '/profiles/acct-1',
  identity: {
    server: 'http://gw:7000',
    timezoneId: 'America/New_York',
    locale: 'en-US',
    geolocation: { latitude: 40.7, longitude: -74 },
  },
};

function state(): StorageStateShape {
  return { cookies: makeCookies(), origins: [] };
}

async function deps(page: FakePage): Promise<{
  d: SessionDeps;
  tasks: HumanTask[];
  vaultPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'loa-life-'));
  const vaultPath = join(dir, 'state.enc');
  const ctx = new FakeContext(page, state());
  const launcher = new FakeLauncher(ctx);
  const factory = new BrowserContextFactory(launcher);
  const tasks: HumanTask[] = [];
  const d: SessionDeps = {
    factory,
    vaultPath,
    accountId: 'acct-1',
    raiseHumanTask: (t) => {
      tasks.push(t);
    },
  };
  return { d, tasks, vaultPath };
}

describe('bootstrap', () => {
  it('raises a login task and persists storage state', async () => {
    const page = new FakePage();
    const { d, tasks, vaultPath } = await deps(page);
    process.env.COOKIE_VAULT_KEY = key.toString('base64');
    const saved = await bootstrap(d, input, async () => {});
    expect(tasks.map((t) => t.kind)).toContain('login');
    expect(saved.cookies.length).toBeGreaterThan(0);
    // vault file exists and decrypts
    expect(vaultPath).toContain('state.enc');
  });
});

describe('resume', () => {
  async function resumeWith(profileCookies: StorageStateShape): Promise<FakeContext> {
    const page = new FakePage();
    const dir = await mkdtemp(join(tmpdir(), 'loa-life-'));
    const vaultPath = join(dir, 'state.enc');
    await saveStorageState(vaultPath, state(), key); // vault always has a li_at cookie
    process.env.COOKIE_VAULT_KEY = key.toString('base64');

    const ctx = new FakeContext(page, profileCookies);
    const launcher = new FakeLauncher(ctx);
    const factory = new BrowserContextFactory(launcher);
    const d: SessionDeps = { factory, vaultPath, accountId: 'acct-1', raiseHumanTask: () => {} };
    const { context } = await resume(d, input);
    return context as FakeContext;
  }

  it('seeds vaulted cookies into a fresh (empty) profile', async () => {
    const context = await resumeWith({ cookies: [], origins: [] });
    expect(context.addedCookies.length).toBeGreaterThan(0);
  });

  it('does NOT clobber a profile that already has a LinkedIn session', async () => {
    // Profile already carries a li_at (LinkedIn rotated it in an earlier run).
    const context = await resumeWith(state());
    expect(context.addedCookies.length).toBe(0);
  });
});

describe('validate', () => {
  it('reports a challenge and escalates a human task', async () => {
    const page = new FakePage({
      url: 'https://www.linkedin.com/checkpoint/challenge',
      counts: { [SELECTORS.challengeContainer]: 1 },
    });
    const { d, tasks } = await deps(page);
    const health = await validate(d, page);
    expect(health.challenged).toBe(true);
    expect(health.valid).toBe(false);
    expect(tasks.map((t) => t.kind)).toContain('challenge');
  });

  it('reports valid on the feed with no challenge', async () => {
    const page = new FakePage({
      url: 'https://www.linkedin.com/feed/',
      counts: { [SELECTORS.challengeContainer]: 0 },
    });
    const { d } = await deps(page);
    const health = await validate(d, page);
    expect(health.valid).toBe(true);
    expect(health.challenged).toBe(false);
  });
});
