// LiveSessionProvider: the real SessionProvider the AccountRunnerExecutor needs.
// It resumes a vaulted, proxy-bound browser session per account through the
// production patchright launcher, caches the live context+page, and hands the
// page to the executor. One session per account; lazily opened on first use.
//
// This is the injection point the executor's TODO(p0) referred to. It cannot be
// exercised without a seeded session (an assisted login must have run first),
// so the unit tests do not drive it; it is proven in the container.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BrowserContextFactory,
  createPatchrightLauncher,
  resume,
  type BrowserContextPort,
  type LaunchConfigInput,
  type PagePort,
  type ProxyIdentity,
  type SessionDeps,
} from '@loa/account-runner';
import type { Target } from '@loa/shared';
import type { SessionProvider } from './account-runner-executor.js';

export interface LiveSessionProviderConfig {
  /** Persistent browser-profile root; one subdir per account. */
  profileDir: string;
  /** Encrypted cookie-vault root; one `${accountId}.vault.json` per account. */
  vaultDir: string;
  /**
   * Resolve the proxy + geo identity for an account. Returns undefined when no
   * proxy is configured. A real account MUST have one; see allowNoProxy.
   */
  identityFor?: (accountId: string) => ProxyIdentity | undefined;
  /**
   * Permit opening a session with no proxy. Off in production: launching a real
   * account off its sticky IP poisons the account's trusted baseline. Only true
   * for local spine checks against neutral pages.
   */
  allowNoProxy?: boolean;
}

type LiveSession = { context: BrowserContextPort; page: PagePort };

/**
 * Extract a LinkedIn profile id from a member urn, tolerating the wrapped
 * search-result form add_targets stores:
 *   urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:XXX,SEARCH_SRP,DEFAULT)
 * A naive slice on the last ':' yields "XXX,SEARCH_SRP,DEFAULT)" — junk that
 * 404s. Pull the inner fsd_profile / person id explicitly.
 */
function profileIdFromUrn(ref: string): string {
  const fsd = ref.match(/fsd_profile:([A-Za-z0-9_-]+)/);
  if (fsd?.[1]) return fsd[1];
  const person = ref.match(/urn:li:person:([A-Za-z0-9_-]+)/);
  if (person?.[1]) return person[1];
  const tail = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  return tail.match(/[A-Za-z0-9_-]+/)?.[0] ?? tail;
}

/**
 * Resolve the profile URL to navigate for a target. Prefers the /in/ vanity URL
 * captured at sourcing time (target.externalContext.profileUrl) — the reliable,
 * cross-surface key — because the row's linkedinUrn is usually a wrapped
 * search-result urn whose opaque id does NOT resolve as an /in/ slug. Falls back
 * to a URL ref, then to an id extracted from the urn. Exported for unit tests.
 */
export function profileUrlForTarget(target: Target): string {
  const ext = target.externalContext as { profileUrl?: unknown } | null | undefined;
  if (typeof ext?.profileUrl === 'string' && /^https?:\/\//.test(ext.profileUrl)) {
    return ext.profileUrl;
  }
  const ref = target.linkedinUrn.trim();
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  return `https://www.linkedin.com/in/${encodeURIComponent(profileIdFromUrn(ref))}/`;
}

/** Matches a first-name merge token in a step body: {First}, {first_name},
 * {FirstName}, {first name}. Case-insensitive, tolerant of inner spacing. */
const FIRST_NAME_TOKEN = /\{\s*first(?:[\s_-]?name)?\s*\}/gi;

/** Matches a company merge token: {Company}. Case-insensitive. */
const COMPANY_TOKEN = /\{\s*company\s*\}/gi;
/** A company token WITH its leading connector ("at {Company}", "@ {Company}").
 * When the company is unknown we drop the whole clause so "your work at
 * {Company}" degrades to "your work" rather than "your work at". The (?:^|\s)
 * lets it also strip a clause at the very start of the body. */
const COMPANY_WITH_CONNECTOR = /(?:^|\s)(?:at|@)\s+\{\s*company\s*\}/gi;

/** The target's first name from the sourced identity (externalContext.name),
 * or undefined when no usable name was captured. Exported for unit tests. */
export function firstNameFromTarget(target: Target): string | undefined {
  const ext = target.externalContext as { name?: unknown } | null | undefined;
  const name = typeof ext?.name === 'string' ? ext.name.trim() : '';
  if (!name) return undefined;
  const first = name.split(/\s+/)[0];
  return first || undefined;
}

/** The target's current company (externalContext.currentCompany), or undefined
 * when none was captured/classified. Exported for unit tests. */
export function companyFromTarget(target: Target): string | undefined {
  const ext = target.externalContext as { currentCompany?: unknown } | null | undefined;
  const company = typeof ext?.currentCompany === 'string' ? ext.currentCompany.trim() : '';
  return company || undefined;
}

/**
 * Substitute merge tokens in a message body.
 *   {First}   -> the target's first name, or "there" when unknown.
 *   {Company} -> the target's company; when unknown, the token AND a leading
 *                "at "/"@" connector are dropped so the sentence stays clean
 *                ("your work at {Company}" -> "your work"). This is the "honest"
 *                rule: never print a blank or guessed company.
 * Exported for unit tests.
 */
export function personalizeBody(body: string, target: Target): string {
  let out = body;

  FIRST_NAME_TOKEN.lastIndex = 0;
  if (FIRST_NAME_TOKEN.test(out)) {
    const first = firstNameFromTarget(target) ?? 'there';
    out = out.replace(FIRST_NAME_TOKEN, first);
  }

  COMPANY_TOKEN.lastIndex = 0;
  if (COMPANY_TOKEN.test(out)) {
    const company = companyFromTarget(target);
    out = company
      ? out.replace(COMPANY_TOKEN, company)
      : out.replace(COMPANY_WITH_CONNECTOR, '').replace(COMPANY_TOKEN, '');
  }

  return out;
}

export class LiveSessionProvider implements SessionProvider {
  private readonly factory = new BrowserContextFactory(createPatchrightLauncher());
  private readonly sessions = new Map<string, Promise<LiveSession>>();

  constructor(private readonly config: LiveSessionProviderConfig) {}

  async pageFor(accountId: string): Promise<PagePort> {
    let pending = this.sessions.get(accountId);
    if (!pending) {
      pending = this.open(accountId);
      this.sessions.set(accountId, pending);
      // If the open fails, drop the cached rejection so a later call can retry.
      pending.catch(() => this.sessions.delete(accountId));
    }
    return (await pending).page;
  }

  profileUrlFor(target: Target): string {
    return profileUrlForTarget(target);
  }

  /** Close every open session. Called on runtime shutdown. */
  async close(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      open.map(async (p) => {
        const s = await p;
        await s.context.close();
      }),
    );
  }

  private async open(accountId: string): Promise<LiveSession> {
    const identity = this.config.identityFor?.(accountId);
    if (!identity && !this.config.allowNoProxy) {
      throw new Error(
        `no proxy identity for account ${accountId}; refusing to launch a real ` +
          `account without its sticky proxy (set LOA_ALLOW_NO_PROXY=true only for ` +
          `local checks against neutral pages)`,
      );
    }
    const userDataDir = join(this.config.profileDir, accountId);
    // Chromium writes a SingletonLock into the profile to stop two instances
    // sharing it. A container restart kills the browser without clearing it, and
    // the profile lives on a persistent volume, so the stale lock (a symlink to
    // the old container's hostname/pid) makes the next launch abort with "browser
    // has been closed". Clear the singleton guards first — safe when no live
    // Chromium holds the profile, which is always true in a freshly started
    // process (the in-memory session cache is empty).
    await clearSingletonLocks(userDataDir);
    const input: LaunchConfigInput = {
      userDataDir,
      ...(identity ? { identity } : {}),
    };
    const deps: SessionDeps = {
      factory: this.factory,
      vaultPath: join(this.config.vaultDir, `${accountId}.vault.json`),
      accountId,
      // The executor path assumes a valid, already-seeded session; escalation on
      // a mid-run challenge is the driving session's job, not the provider's.
      raiseHumanTask: () => {},
    };
    return resume(deps, input);
  }
}

/**
 * Remove Chromium's single-instance guard files from a profile dir. After an
 * unclean shutdown (a container kill) these are left behind, and on a persistent
 * volume the stale SingletonLock symlink points at a dead/foreign host, which
 * makes the next launchPersistentContext abort. Safe to remove when no live
 * Chromium holds the profile. Missing files and unlink races are ignored.
 */
export async function clearSingletonLocks(userDataDir: string): Promise<void> {
  await Promise.all(
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) =>
      rm(join(userDataDir, name), { force: true }).catch(() => {}),
    ),
  );
}
