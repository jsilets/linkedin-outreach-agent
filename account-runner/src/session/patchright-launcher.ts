// Real BrowserLauncherPort backed by patchright, the maintained stealth
// Playwright drop-in. This is the production launcher the BrowserContextFactory
// uses; tests use FakeLauncher instead. Everything the runner touches is a
// subset of the Playwright API, so these adapters are thin pass-throughs that
// pin the exact surface declared in ports.ts and keep patchright's types from
// leaking past this file.
//
// This is the one piece that genuinely requires a browser: it cannot be
// exercised by the unit tests (no binaries in dev), so it is verified by
// launching Chromium in the container. Keep it dumb — every method here should
// be a direct forward to the underlying patchright object.

import { chromium } from 'patchright';
import type {
  BrowserContextPort,
  BrowserLauncherPort,
  InterceptedResponse,
  LocatorPort,
  PagePort,
  StorageStateShape,
} from '../ports.js';

// The voyagerGet callback below runs in the browser, not in Node, so `document`
// is provided by Chromium at runtime. The runtime tsconfig omits the DOM lib
// (this is a Node package), so declare the one browser global it touches as
// ambient to keep this file typechecking without pulling in all of lib.dom.
declare const document: { cookie: string };

// Derive patchright's concrete types from the driver itself so we never import
// its named types (which vary across versions) and never fall out of sync.
type PwContext = Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
type PwPage = Awaited<ReturnType<PwContext['newPage']>>;
type PwLocator = ReturnType<PwPage['locator']>;
type GotoOptions = NonNullable<Parameters<PwPage['goto']>[1]>;
type LaunchOptions = Parameters<typeof chromium.launchPersistentContext>[1];

function adaptLocator(loc: PwLocator): LocatorPort {
  return {
    click: (options) => loc.click(options),
    type: (text, options) => loc.type(text, options),
    fill: (text) => loc.fill(text),
    textContent: () => loc.textContent(),
    getAttribute: (name) => loc.getAttribute(name),
    count: () => loc.count(),
    first: () => adaptLocator(loc.first()),
    nth: (index) => adaptLocator(loc.nth(index)),
    hover: () => loc.hover(),
    focus: () => loc.focus(),
    waitFor: (options) => loc.waitFor(options),
  };
}

function adaptPage(page: PwPage): PagePort {
  return {
    // The port types waitUntil as a plain string; patchright narrows it to a
    // union. The call sites only ever pass valid values, so cast the options.
    goto: (url, options) => page.goto(url, options as GotoOptions),
    locator: (selector) => adaptLocator(page.locator(selector)),
    $$count: (selector) => page.locator(selector).count(),
    url: () => page.url(),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    insertText: (text) => page.keyboard.insertText(text),
    pressKey: (key) => page.keyboard.press(key),
    waitForResponse: async (urlSubstring, opts) => {
      const needles = Array.isArray(urlSubstring) ? urlSubstring : [urlSubstring];
      const res = await page.waitForResponse(
        (r) => {
          const u = r.url();
          return needles.every((n) => u.includes(n));
        },
        { timeout: opts?.timeoutMs ?? 15_000 },
      );
      const adapted: InterceptedResponse = {
        url: res.url(),
        status: res.status(),
        json: () => res.json() as Promise<unknown>,
      };
      return adapted;
    },
    voyagerGet: (pathWithQuery, opts) =>
      page.evaluate(
        async ({ path, accept }: { path: string; accept: string }) => {
          // JSESSIONID is stored WITH surrounding double-quotes; the Csrf-Token
          // header wants the value WITHOUT them (e.g. ajax:1234...).
          const m = document.cookie.match(/JSESSIONID=("?)([^;"]+)\1/);
          const csrf = m?.[2] ?? '';
          const headers: Record<string, string> = {
            'csrf-token': csrf,
            'x-restli-protocol-version': '2.0.0',
          };
          if (accept) headers.accept = accept;
          const resp = await fetch(path, { credentials: 'include', headers });
          let body: unknown = null;
          try {
            body = await resp.json();
          } catch {
            body = null;
          }
          return { status: resp.status, body };
        },
        { path: pathWithQuery, accept: opts?.accept ?? '' },
      ),
    voyagerPost: (pathWithQuery, body, opts) =>
      page.evaluate(
        async ({ path, accept, payload }: { path: string; accept: string; payload: string }) => {
          const m = document.cookie.match(/JSESSIONID=("?)([^;"]+)\1/);
          const csrf = m?.[2] ?? '';
          const headers: Record<string, string> = {
            'csrf-token': csrf,
            'x-restli-protocol-version': '2.0.0',
            'content-type': 'application/json',
          };
          if (accept) headers.accept = accept;
          const resp = await fetch(path, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: payload,
          });
          // An action POST often returns 200 with an empty body; tolerate it.
          let respBody: unknown = null;
          try {
            respBody = await resp.json();
          } catch {
            respBody = null;
          }
          return { status: resp.status, body: respBody };
        },
        { path: pathWithQuery, accept: opts?.accept ?? '', payload: JSON.stringify(body ?? {}) },
      ),
  };
}

function adaptContext(ctx: PwContext): BrowserContextPort {
  return {
    newPage: async () => adaptPage(await ctx.newPage()),
    // The port types cookies as unknown[]; patchright wants its Cookie[] shape.
    // The vault only round-trips these, so the cast is safe.
    addCookies: (cookies) => ctx.addCookies(cookies as Parameters<PwContext['addCookies']>[0]),
    cookies: () => ctx.cookies(),
    storageState: (options) => ctx.storageState(options) as Promise<StorageStateShape>,
    close: () => ctx.close(),
  };
}

/**
 * Build the production launcher. The BrowserContextFactory is constructed with
 * this in a live deployment and with FakeLauncher in tests.
 */
export function createPatchrightLauncher(): BrowserLauncherPort {
  return {
    async launchPersistentContext(
      userDataDir: string,
      options: Record<string, unknown>,
    ): Promise<BrowserContextPort> {
      const ctx = await chromium.launchPersistentContext(userDataDir, options as LaunchOptions);
      return adaptContext(ctx);
    },
  };
}
