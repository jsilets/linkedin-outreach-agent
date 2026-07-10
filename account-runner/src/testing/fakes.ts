// Test-only fakes for the browser ports. Not exported from the package index.
// A FakePage records every locator selector touched and every action taken, so
// tests can assert the executor drove the right centralized selectors without a
// real browser.

import type {
  BrowserContextPort,
  BrowserLauncherPort,
  CookieShape,
  InterceptedResponse,
  LocatorPort,
  PagePort,
  StorageStateShape,
} from '../ports.js';

/** Records interactions with a single locator. */
export interface LocatorLog {
  selector: string;
  clicks: number;
  typed: string[];
  filled: string[];
  hovers: number;
  focuses: number;
  waits: number;
}

export class FakeLocator implements LocatorPort {
  constructor(
    private readonly log: LocatorLog,
    private readonly countValue: () => number,
    private readonly text: () => string | null,
  ) {}

  async click(): Promise<void> {
    this.log.clicks += 1;
  }
  async type(text: string): Promise<void> {
    this.log.typed.push(text);
  }
  async fill(text: string): Promise<void> {
    this.log.filled.push(text);
  }
  async textContent(): Promise<string | null> {
    return this.text();
  }
  async count(): Promise<number> {
    return this.countValue();
  }
  first(): LocatorPort {
    // Same underlying log, so click/type assertions still see this locator.
    return this;
  }
  nth(): LocatorPort {
    // The fake does not model per-index DOM; every index shares this log so
    // click/type assertions still register. Per-candidate discrimination is
    // covered by live verification, not unit tests.
    return this;
  }
  async hover(): Promise<void> {
    this.log.hovers += 1;
  }
  async focus(): Promise<void> {
    this.log.focuses += 1;
  }
  async waitFor(): Promise<void> {
    this.log.waits += 1;
  }
}

export interface FakePageOptions {
  /** Per-selector element counts, default 1 when a selector is queried. */
  counts?: Record<string, number>;
  /** Per-selector textContent responses. */
  texts?: Record<string, string>;
  /** URL the page reports; updated by goto. */
  url?: string;
}

export class FakePage implements PagePort {
  readonly gotos: string[] = [];
  readonly locators = new Map<string, LocatorLog>();
  /** Every urlSubstring a caller waited on, in order. */
  readonly responseWaits: string[] = [];
  // Canned responses keyed by urlSubstring. Each key holds a FIFO queue so a
  // paginating caller that waits on the same substring repeatedly gets the
  // successive pages a test preloaded.
  private readonly cannedResponses = new Map<string, InterceptedResponse[]>();
  private currentUrl: string;
  constructor(private readonly opts: FakePageOptions = {}) {
    this.currentUrl = opts.url ?? 'https://www.linkedin.com/feed/';
  }

  /**
   * Preload a canned JSON payload returned the next time a caller waits on a
   * response whose URL contains urlSubstring. Call once per expected page to
   * model pagination; the last preloaded payload is reused once the queue drains.
   */
  preloadResponse(urlSubstring: string, json: unknown, status = 200): void {
    const queue = this.cannedResponses.get(urlSubstring) ?? [];
    queue.push({
      url: `https://www.linkedin.com/${urlSubstring}`,
      status,
      json: async () => json,
    });
    this.cannedResponses.set(urlSubstring, queue);
  }

  async waitForResponse(urlSubstring: string | string[]): Promise<InterceptedResponse> {
    // Normalize the array form to a single lookup key so preloadResponse and the
    // waiter agree; the array's first substring is the cluster query marker.
    const key = Array.isArray(urlSubstring) ? (urlSubstring[0] ?? '') : urlSubstring;
    this.responseWaits.push(key);
    const queue = this.cannedResponses.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`no canned response preloaded for "${key}"`);
    }
    // Keep the last one so an over-eager pagination loop does not throw; the
    // loop stops on its own once a page returns no new items.
    return queue.length > 1 ? (queue.shift() as InterceptedResponse) : queue[0];
  }

  async goto(url: string): Promise<unknown> {
    this.gotos.push(url);
    this.currentUrl = url;
    return null;
  }

  locator(selector: string): LocatorPort {
    let log = this.locators.get(selector);
    if (!log) {
      log = { selector, clicks: 0, typed: [], filled: [], hovers: 0, focuses: 0, waits: 0 };
      this.locators.set(selector, log);
    }
    const count = this.opts.counts?.[selector] ?? 1;
    const text = this.opts.texts?.[selector] ?? null;
    return new FakeLocator(log, () => count, () => text);
  }

  url(): string {
    return this.currentUrl;
  }

  async waitForTimeout(): Promise<void> {
    // no-op in tests
  }

  /** Text entered via keyboard.insertText, with Shift+Enter recorded as '\n', so
   * a test can assert the composed message including its paragraph breaks. */
  composed = '';
  readonly keysPressed: string[] = [];
  async insertText(text: string): Promise<void> {
    this.composed += text;
  }
  async pressKey(key: string): Promise<void> {
    this.keysPressed.push(key);
    // Only Shift+Enter inserts a newline into the body; a bare Enter is a submit
    // (the Send button activation), not composed text.
    if (/shift\+enter/i.test(key)) this.composed += '\n';
  }

  /** Convenience: was a selector focused at least once? */
  focused(selector: string): boolean {
    return (this.locators.get(selector)?.focuses ?? 0) > 0;
  }

  /** Canned Voyager response; set by a test that exercises a direct API call. */
  cannedVoyager?: { status: number; body: unknown };

  async voyagerGet(): Promise<{ status: number; body: unknown }> {
    return this.cannedVoyager ?? { status: 200, body: {} };
  }

  /** Convenience: was a selector clicked at least once? */
  clicked(selector: string): boolean {
    return (this.locators.get(selector)?.clicks ?? 0) > 0;
  }

  /** Convenience: text typed into a selector. */
  typedInto(selector: string): string[] {
    return this.locators.get(selector)?.typed ?? [];
  }

  /** Convenience: text filled into a selector (fill replaces, e.g. clearing). */
  filledInto(selector: string): string[] {
    return this.locators.get(selector)?.filled ?? [];
  }
}

/** A no-op sleeper for tests. */
export const noSleep = async (): Promise<void> => {};

/** Deterministic RNG returning a fixed value for stable pacing. */
export const fixedRng = (v = 0.5) => () => v;

/** A fake persistent context + launcher for session tests. */
export class FakeContext implements BrowserContextPort {
  addedCookies: readonly unknown[] = [];
  closed = false;
  constructor(
    private readonly page: FakePage,
    private readonly state: StorageStateShape,
  ) {}
  async newPage(): Promise<PagePort> {
    return this.page;
  }
  async addCookies(cookies: readonly unknown[]): Promise<void> {
    this.addedCookies = cookies;
  }
  async cookies(): Promise<unknown[]> {
    return [...this.state.cookies];
  }
  async storageState(): Promise<StorageStateShape> {
    return this.state;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeLauncher implements BrowserLauncherPort {
  lastDir?: string;
  lastOptions?: Record<string, unknown>;
  constructor(private readonly context: FakeContext) {}
  async launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<BrowserContextPort> {
    this.lastDir = userDataDir;
    this.lastOptions = options;
    return this.context;
  }
}

export function makeCookies(): CookieShape[] {
  return [
    {
      name: 'li_at',
      value: 'v',
      domain: '.linkedin.com',
      path: '/',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ];
}
