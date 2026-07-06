// HTTP Basic auth check for the web API. Kept separate from main.ts so it can
// be unit-tested without booting the server or a database.
import { timingSafeEqual } from 'node:crypto';

// Constant-time equality that never short-circuits on length.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const target = ab.length === bb.length ? bb : ab;
  return timingSafeEqual(ab, target) && ab.length === bb.length;
}

/**
 * True if the `Authorization` header carries Basic credentials matching the
 * configured user/password. Any malformed or absent header returns false.
 */
export function basicAuthOk(header: unknown, user: string, password: string): boolean {
  const match = typeof header === 'string' ? /^Basic\s+(.+)$/i.exec(header.trim()) : null;
  if (!match) return false;
  const [reqUser, ...rest] = Buffer.from(match[1], 'base64').toString('utf8').split(':');
  const reqPassword = rest.join(':');
  return safeEqual(reqUser, user) && safeEqual(reqPassword, password);
}
