import { describe, expect, it } from 'vitest';
import { basicAuthOk } from './auth.js';

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
