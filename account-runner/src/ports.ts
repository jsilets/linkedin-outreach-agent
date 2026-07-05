// Local PORT interfaces. The runner defines the minimal surface it needs from
// the browser driver and from the control-plane, so tests can supply fakes and
// the runner never imports another @loa/* package.
//
// The real Page/BrowserContext come from patchright at the launch seam; these
// structural ports are the subset the executor and detector actually touch.

import type { Account, Action, Decision } from '@loa/shared';

/** Minimal locator surface: enough to click, type, read, and count. */
export interface LocatorPort {
  click(options?: { delay?: number }): Promise<void>;
  // Types character-by-character; the delay models human cadence.
  type(text: string, options?: { delay?: number }): Promise<void>;
  fill(text: string): Promise<void>;
  textContent(): Promise<string | null>;
  count(): Promise<number>;
  // Human-style hover before a click.
  hover(): Promise<void>;
  // Wait until the element is present/visible.
  waitFor(options?: { state?: 'visible' | 'attached'; timeout?: number }): Promise<void>;
}

/** Minimal page surface the executor and detector rely on. */
export interface PagePort {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  locator(selector: string): LocatorPort;
  // Returns the number of matches for a selector without throwing.
  $$count?(selector: string): Promise<number>;
  url(): string;
  // Small random settle wait; the executor calls this between steps.
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * AllowToken is the capability the executor demands before touching the page.
 * It is minted by the control-plane SafetyGate (via SafetyPort) after canAct
 * returned { kind: 'allow' }. The runner does not decide policy; it only
 * refuses to act without a valid allow token for the exact action.
 */
export interface AllowToken {
  readonly kind: 'allow';
  /** Id of the action this token authorizes. Must match the action being run. */
  readonly actionId: string;
  /** Account the token was minted for. */
  readonly accountId: string;
  /** Unix ms after which the token is stale and must be refused. */
  readonly expiresAt: number;
  /** Opaque nonce for audit correlation. */
  readonly nonce: string;
}

/**
 * SafetyPort is the seam to the control-plane SafetyGate. The runner asks for a
 * decision and, on allow, an allow-token. The REAL gate lives in @loa/safety;
 * this is only the port the runner consults. Local mirror stays thin.
 */
export interface SafetyPort {
  /** Ask the control plane to authorize an action; returns the raw Decision. */
  authorize(acct: Account, action: Action): Promise<Decision>;
  /** Mint an allow-token for an action the gate has allowed. */
  mintToken(acct: Account, action: Action): Promise<AllowToken>;
}

/** Reason an allow-token was rejected by the executor's pre-flight check. */
export type TokenRejection =
  | 'missing'
  | 'wrong_action'
  | 'wrong_account'
  | 'expired'
  | 'not_allow';

/** Launcher port: the subset of patchright.chromium the factory calls. */
export interface BrowserLauncherPort {
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<BrowserContextPort>;
}

/** Minimal browser-context surface the session layer uses. */
export interface BrowserContextPort {
  newPage(): Promise<PagePort>;
  addCookies(cookies: readonly unknown[]): Promise<void>;
  cookies(): Promise<unknown[]>;
  storageState(options?: { path?: string }): Promise<StorageStateShape>;
  close(): Promise<void>;
}

/** Playwright-compatible storage-state shape (cookies + origin storage). */
export interface StorageStateShape {
  cookies: CookieShape[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/** Subset of a Playwright cookie the vault persists. */
export interface CookieShape {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}
