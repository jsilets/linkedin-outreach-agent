import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StorageStateShape } from '../ports.js';
import {
  extractSessionCookies,
  loadStorageState,
  open,
  resolveVaultKey,
  saveStorageState,
  seal,
  VaultError,
} from './vault.js';

const key = randomBytes(32);

const sampleState: StorageStateShape = {
  cookies: [
    {
      name: 'li_at',
      value: 'SECRET_LI_AT_VALUE',
      domain: '.linkedin.com',
      path: '/',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
    {
      name: 'JSESSIONID',
      value: 'ajax:12345',
      domain: '.www.linkedin.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    },
  ],
  origins: [
    {
      origin: 'https://www.linkedin.com',
      localStorage: [{ name: 'foo', value: 'bar' }],
    },
  ],
};

describe('vault crypto', () => {
  it('round-trips seal -> open with the same key', () => {
    const env = seal('hello world', key);
    expect(open(env, key)).toBe('hello world');
  });

  it('fails to open with the wrong key', () => {
    const env = seal('hello world', key);
    const wrong = randomBytes(32);
    expect(() => open(env, wrong)).toThrow(VaultError);
  });

  it('does not embed plaintext in the envelope', () => {
    const env = seal('SUPER_SECRET', key);
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('SUPER_SECRET');
  });
});

describe('resolveVaultKey', () => {
  it('accepts a base64 32-byte key', () => {
    const b64 = randomBytes(32).toString('base64');
    expect(resolveVaultKey(b64)).toHaveLength(32);
  });

  it('accepts a hex 32-byte key', () => {
    const hex = randomBytes(32).toString('hex');
    expect(resolveVaultKey(hex)).toHaveLength(32);
  });

  it('throws when unset', () => {
    expect(() => resolveVaultKey('')).toThrow(VaultError);
    expect(() => resolveVaultKey(undefined)).toThrow(VaultError);
  });

  it('throws when key is the wrong length', () => {
    expect(() => resolveVaultKey('shortkey')).toThrow(VaultError);
  });
});

describe('storage state persistence', () => {
  it('save then load yields the original state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loa-vault-'));
    const path = join(dir, 'acct-1', 'state.enc');
    await saveStorageState(path, sampleState, key);
    const loaded = await loadStorageState(path, key);
    expect(loaded).toEqual(sampleState);
  });

  it('load with the wrong key throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loa-vault-'));
    const path = join(dir, 'state.enc');
    await saveStorageState(path, sampleState, key);
    await expect(loadStorageState(path, randomBytes(32))).rejects.toThrow(VaultError);
  });

  it('load from a missing file throws', async () => {
    await expect(loadStorageState('/nope/does/not/exist.enc', key)).rejects.toThrow(VaultError);
  });
});

describe('extractSessionCookies', () => {
  it('pulls li_at and JSESSIONID', () => {
    const { liAt, jsessionId } = extractSessionCookies(sampleState);
    expect(liAt).toBe('SECRET_LI_AT_VALUE');
    expect(jsessionId).toBe('ajax:12345');
  });
});
