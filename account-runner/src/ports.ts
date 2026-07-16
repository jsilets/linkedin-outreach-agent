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
  // An element attribute, or null when absent. Used by refusal diagnostics to
  // record the href a guard actually saw, rather than only the one it wanted.
  getAttribute(name: string): Promise<string | null>;
  count(): Promise<number>;
  // Narrow an OR-chain / multi-match locator to its first element, so a click
  // does not trip Playwright strict mode when several elements match.
  first(): LocatorPort;
  // Narrow to the nth match (0-based); used to try each candidate in turn when
  // a selector matches several elements and only one is the right target.
  nth(index: number): LocatorPort;
  // Human-style hover before a click.
  hover(): Promise<void>;
  // DOM focus. Unlike click(), needs no viewport hit-test, so it reaches an
  // editable that renders outside the viewport (e.g. the message composer
  // overlay). Typing then lands on the focused element.
  focus(): Promise<void>;
  // Wait until the element is present/visible.
  waitFor(options?: { state?: 'visible' | 'attached'; timeout?: number }): Promise<void>;
}

/**
 * A response the page already fetched, surfaced to the runner so lead-sourcing
 * can read the JSON the page's own XHR pulled (Voyager search) instead of
 * scraping the DOM or issuing a separate API call. Structural subset of a
 * Playwright Response.
 */
export interface InterceptedResponse {
  url: string;
  status: number;
  json(): Promise<unknown>;
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
  /**
   * Resolve with the first response whose URL contains urlSubstring — or, when
   * an array is given, contains ALL of the substrings. The array form is how
   * people-search pins the real results cluster (voyagerSearchDashClusters +
   * SEARCH_SRP) past decoy clusters the page also fires (MYNETWORK_CURATION_HUB).
   * The waiter must be armed BEFORE the navigation/interaction that triggers the
   * request, so the caller races this against goto() rather than awaiting goto()
   * first. Rejects on timeout (default 15s).
   */
  waitForResponse(
    urlSubstring: string | string[],
    opts?: { timeoutMs?: number },
  ): Promise<InterceptedResponse>;
  /**
   * Issue an authenticated same-origin GET to the LinkedIn Voyager API from the
   * page's own fetch context, so the session cookies attach automatically. Adds
   * the Csrf-Token (derived in-page from the JSESSIONID cookie) and
   * X-Restli-Protocol-Version headers the API requires. `pathWithQuery` is the
   * origin-relative path, e.g. "/voyager/api/graphql?variables=(...)&queryId=...".
   * This is how people-search runs — a direct call, which is deterministic,
   * versus intercepting the flagship page's XHRs (the results page is SSR'd and
   * does not reliably fire a client-side search XHR on navigation). The page
   * must already be on https://www.linkedin.com for the cookies to attach.
   */
  voyagerGet(
    pathWithQuery: string,
    opts?: { accept?: string },
  ): Promise<{ status: number; body: unknown }>;
  /**
   * Issue an authenticated same-origin POST to the LinkedIn Voyager API from the
   * page's own fetch context — the write twin of voyagerGet, for action POSTs
   * like withdraw. Sends the same Csrf-Token + X-Restli-Protocol-Version headers,
   * content-type application/json, and the JSON `body`. A successful action may
   * return HTTP 200 with an EMPTY body, so the parsed body is null on non-JSON.
   * Optional so lightweight test fakes need not implement it; callers must check
   * for its presence and fall back (or refuse) when it is absent.
   */
  voyagerPost?(
    pathWithQuery: string,
    body: unknown,
    opts?: { accept?: string },
  ): Promise<{ status: number; body: unknown }>;
  /**
   * Insert text at the focused element's caret (paste-like: one input event, no
   * per-key events, no viewport hit-test). Reaches an editor that renders
   * outside the viewport, where click+type stalls. Optional so lightweight test
   * fakes need not implement it; callers fall back to fill() when absent.
   */
  insertText?(text: string): Promise<void>;
  /**
   * Press a key or chord on the focused element, e.g. "Shift+Enter" for a
   * newline that does NOT submit the message (plain Enter sends). Optional; see
   * insertText.
   */
  pressKey?(key: string): Promise<void>;
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
export type TokenRejection = 'missing' | 'wrong_action' | 'wrong_account' | 'expired' | 'not_allow';

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
