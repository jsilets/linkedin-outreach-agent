// Auth for the web API: HTTP Basic (for curl/API) plus a signed cookie session
// (for browsers, including embedded ones that cannot render a Basic-auth prompt).
// Kept separate from main.ts so it can be unit-tested without booting the server.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Cookie name for the signed web session. */
export const AUTH_COOKIE = 'loa_auth';

/** Session lifetime: long enough to be convenient for a single-operator tool. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

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

// --- Cookie session --------------------------------------------------------
// A stateless signed token: `<expiresMs>.<hmac>`, where the HMAC is keyed by the
// configured password. It proves knowledge of the password without resending it,
// carries its own expiry, and is tamper-proof. No server-side session store.

function sign(payload: string, password: string): string {
  return createHmac('sha256', password).update(payload).digest('hex');
}

/** Mint a signed session token for a freshly authenticated user. */
export function issueAuthToken(user: string, password: string, now = Date.now()): string {
  const expiresMs = now + SESSION_MS;
  const payload = `${user}.${expiresMs}`;
  return `${expiresMs}.${sign(payload, password)}`;
}

/** Validate a raw session-token value (the cookie's value). */
export function authTokenValid(
  token: string | undefined,
  user: string,
  password: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresMs = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isFinite(expiresMs) || expiresMs < now) return false;
  return safeEqual(mac, sign(`${user}.${expiresMs}`, password));
}

/** Pull a single cookie value out of a Cookie header. */
export function readCookie(header: unknown, name: string): string | undefined {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** True if the request's Cookie header carries a valid session token. */
export function authCookieOk(cookieHeader: unknown, user: string, password: string): boolean {
  return authTokenValid(readCookie(cookieHeader, AUTH_COOKIE), user, password);
}
