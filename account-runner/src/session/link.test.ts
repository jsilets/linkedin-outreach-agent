import { describe, it, expect } from 'vitest';
import { buildStorageStateFromPastedCookies } from './link.js';
import { extractSessionCookies, seal, open, resolveVaultKey, VaultError } from './vault.js';

const KEY = Buffer.alloc(32, 7); // deterministic 32-byte key for the test

describe('buildStorageStateFromPastedCookies', () => {
  it('produces a storage state carrying li_at and a quoted JSESSIONID', () => {
    const state = buildStorageStateFromPastedCookies({
      liAt: 'AQEDATestToken123',
      jsessionId: 'ajax:5551234567890',
    });
    const { liAt, jsessionId } = extractSessionCookies(state);
    expect(liAt).toBe('AQEDATestToken123');
    // Normalized to the double-quoted form LinkedIn stores.
    expect(jsessionId).toBe('"ajax:5551234567890"');

    const liAtCookie = state.cookies.find((c) => c.name === 'li_at');
    expect(liAtCookie).toMatchObject({ domain: '.linkedin.com', secure: true, httpOnly: true });
    const jsessionCookie = state.cookies.find((c) => c.name === 'JSESSIONID');
    // JSESSIONID must be JS-readable (used to build the csrf header in-page).
    expect(jsessionCookie).toMatchObject({ domain: '.www.linkedin.com', httpOnly: false });
  });

  it('accepts JSESSIONID that already has quotes without doubling them', () => {
    const state = buildStorageStateFromPastedCookies({
      liAt: 'tok',
      jsessionId: '"ajax:99"',
    });
    expect(extractSessionCookies(state).jsessionId).toBe('"ajax:99"');
  });

  it('survives a seal/open round-trip (vault-compatible)', () => {
    const state = buildStorageStateFromPastedCookies({ liAt: 'tok', jsessionId: 'ajax:1' });
    const envelope = seal(JSON.stringify(state), KEY);
    const restored = JSON.parse(open(envelope, KEY));
    expect(extractSessionCookies(restored)).toEqual({ liAt: 'tok', jsessionId: '"ajax:1"' });
  });

  it('rejects a pasted cookie header or name=value pair', () => {
    expect(() => buildStorageStateFromPastedCookies({ liAt: 'li_at=abc', jsessionId: 'ajax:1' })).toThrow(
      VaultError,
    );
    expect(() =>
      buildStorageStateFromPastedCookies({ liAt: 'abc; JSESSIONID=x', jsessionId: 'ajax:1' }),
    ).toThrow(VaultError);
  });

  it('rejects missing cookies', () => {
    expect(() => buildStorageStateFromPastedCookies({ liAt: '', jsessionId: 'ajax:1' })).toThrow(
      /li_at/,
    );
    expect(() => buildStorageStateFromPastedCookies({ liAt: 'tok', jsessionId: '  ' })).toThrow(
      /JSESSIONID/,
    );
  });

  // Guards that COOKIE_VAULT_KEY resolution is unchanged (link path reuses it).
  it('resolveVaultKey still accepts a 32-byte base64 key', () => {
    expect(resolveVaultKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
  });
});
