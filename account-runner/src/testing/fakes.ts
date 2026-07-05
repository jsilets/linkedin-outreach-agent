// Test-only fakes for the browser ports. Not exported from the package index.
// A FakePage records every locator selector touched and every action taken, so
// tests can assert the executor drove the right centralized selectors without a
// real browser.

import type {
  BrowserContextPort,
  BrowserLauncherPort,
  CookieShape,
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
  async hover(): Promise<void> {
    this.log.hovers += 1;
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
  private currentUrl: string;
  constructor(private readonly opts: FakePageOptions = {}) {
    this.currentUrl = opts.url ?? 'https://www.linkedin.com/feed/';
  }

  async goto(url: string): Promise<unknown> {
    this.gotos.push(url);
    this.currentUrl = url;
    return null;
  }

  locator(selector: string): LocatorPort {
    let log = this.locators.get(selector);
    if (!log) {
      log = { selector, clicks: 0, typed: [], filled: [], hovers: 0, waits: 0 };
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

  /** Convenience: was a selector clicked at least once? */
  clicked(selector: string): boolean {
    return (this.locators.get(selector)?.clicks ?? 0) > 0;
  }

  /** Convenience: text typed into a selector. */
  typedInto(selector: string): string[] {
    return this.locators.get(selector)?.typed ?? [];
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
