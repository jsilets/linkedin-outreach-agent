import { describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE,
  authCookieOk,
  authTokenValid,
  basicAuthOk,
  issueAuthToken,
  readCookie,
} from './auth.js';

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

describe('basicAuthOk', () => {
  it('accepts matching credentials', () => {
    expect(basicAuthOk(basicHeader('op', 's3cret'), 'op', 's3cret')).toBe(true);
  });

  it('accepts a password containing a colon', () => {
    expect(basicAuthOk(basicHeader('op', 'a:b:c'), 'op', 'a:b:c')).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(basicAuthOk(basicHeader('op', 'wrong'), 'op', 's3cret')).toBe(false);
  });

  it('rejects a wrong user', () => {
    expect(basicAuthOk(basicHeader('nope', 's3cret'), 'op', 's3cret')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(basicAuthOk(undefined, 'op', 's3cret')).toBe(false);
  });

  it('rejects a non-Basic scheme', () => {
    expect(basicAuthOk('Bearer token', 'op', 's3cret')).toBe(false);
  });
});

describe('session cookie', () => {
  const now = 1_000_000_000_000;

  it('issues a token that validates for the same user/password', () => {
    const token = issueAuthToken('op', 's3cret', now);
    expect(authTokenValid(token, 'op', 's3cret', now + 1000)).toBe(true);
  });

  it('rejects a token signed with a different password', () => {
    const token = issueAuthToken('op', 's3cret', now);
    expect(authTokenValid(token, 'op', 'other', now + 1000)).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = issueAuthToken('op', 's3cret', now);
    const wayLater = now + 40 * 24 * 60 * 60 * 1000;
    expect(authTokenValid(token, 'op', 's3cret', wayLater)).toBe(false);
  });

  it('rejects a tampered expiry', () => {
    const token = issueAuthToken('op', 's3cret', now);
    const tampered = `${now + 999 * 24 * 60 * 60 * 1000}.${token.split('.')[1]}`;
    expect(authTokenValid(tampered, 'op', 's3cret', now + 1000)).toBe(false);
  });

  it('rejects missing/garbage tokens', () => {
    expect(authTokenValid(undefined, 'op', 's3cret', now)).toBe(false);
    expect(authTokenValid('nonsense', 'op', 's3cret', now)).toBe(false);
  });

  it('reads the token out of a Cookie header and validates it end to end', () => {
    // authCookieOk uses the real clock, so mint with the real clock too.
    const token = issueAuthToken('op', 's3cret');
    const header = `other=1; ${AUTH_COOKIE}=${token}; x=y`;
    expect(readCookie(header, AUTH_COOKIE)).toBe(token);
    expect(authCookieOk(header, 'op', 's3cret')).toBe(true);
  });

  it('rejects when the cookie is absent', () => {
    expect(authCookieOk('foo=bar', 'op', 's3cret')).toBe(false);
  });
});
