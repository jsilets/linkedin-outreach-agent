// Account linking via pasted session cookies — the HeyReach-style "connect your
// account" path. Instead of the assisted headful login (npm run login), the
// operator pastes their LinkedIn session cookies (li_at + JSESSIONID) captured
// from a logged-in browser, and we build the same Playwright storage state the
// vault stores. This lets an account be linked from a hosted UI (and sealed
// straight into the cloud vault) with no local browser step.
//
// li_at is the auth token; JSESSIONID doubles as the CSRF token for voyager
// calls. Two cookies are the minimum viable session; more can be added later for
// robustness. Secrets are never logged.

import type { CookieShape, StorageStateShape } from '../ports.js';
import { VaultError } from './vault.js';

/** The cookies an operator pastes from a logged-in LinkedIn browser. */
export interface PastedSession {
  /** The li_at cookie VALUE (an opaque token). */
  liAt: string;
  /** The JSESSIONID cookie value (e.g. ajax:1234...; quotes optional on input). */
  jsessionId: string;
}

/** One year out, in unix seconds — LinkedIn's li_at lives roughly this long. */
function oneYearFromNow(): number {
  return Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
}

function linkedinCookie(name: string, value: string, domain: string): CookieShape {
  return {
    name,
    value,
    domain,
    path: '/',
    expires: oneYearFromNow(),
    // li_at is httpOnly in the browser; JSESSIONID is JS-readable (we read it in
    // the page to build the csrf-token header), so it must NOT be httpOnly.
    httpOnly: name === 'li_at',
    secure: true,
    sameSite: 'None',
  };
}

/**
 * Build a Playwright storage state from pasted session cookies. Validates the
 * inputs look like cookie VALUES (not a whole `name=value; …` header) and
 * normalizes JSESSIONID to the double-quoted form LinkedIn stores it in.
 * Throws VaultError on obviously-malformed input.
 */
export function buildStorageStateFromPastedCookies(input: PastedSession): StorageStateShape {
  const liAt = input.liAt?.trim() ?? '';
  let jsession = input.jsessionId?.trim() ?? '';

  if (!liAt) throw new VaultError('li_at cookie is required');
  if (!jsession) throw new VaultError('JSESSIONID cookie is required');

  // Guard against pasting the whole cookie header or a `name=value` pair.
  if (/[;\s]/.test(liAt) || liAt.includes('=')) {
    throw new VaultError('li_at should be the cookie VALUE only (no "li_at=", no ";", no spaces)');
  }

  // LinkedIn stores JSESSIONID WITH surrounding double-quotes (e.g. "ajax:123").
  // Accept it with or without quotes and normalize to the quoted form; the csrf
  // header derivation strips the quotes back off at request time.
  const bare = jsession.replace(/^"+|"+$/g, '');
  if (!bare) throw new VaultError('JSESSIONID is empty after trimming quotes');
  if (/[;\s]/.test(bare)) {
    throw new VaultError('JSESSIONID should be the cookie VALUE only (no ";", no spaces)');
  }
  jsession = `"${bare}"`;

  return {
    cookies: [
      // li_at is valid across linkedin.com; JSESSIONID is scoped to www.
      linkedinCookie('li_at', liAt, '.linkedin.com'),
      linkedinCookie('JSESSIONID', jsession, '.www.linkedin.com'),
    ],
    origins: [],
  };
}
