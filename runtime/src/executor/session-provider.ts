// LiveSessionProvider: the real SessionProvider the AccountRunnerExecutor needs.
// It resumes a vaulted, proxy-bound browser session per account through the
// production patchright launcher, caches the live context+page, and hands the
// page to the executor. One session per account; lazily opened on first use.
//
// This is the injection point the executor's TODO(p0) referred to. It cannot be
// exercised without a seeded session (an assisted login must have run first),
// so the unit tests do not drive it; it is proven in the container.

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
    const ref = target.linkedinUrn.trim();
    if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
    // urn:li:person:ABC123 -> use the trailing id as a public identifier.
    const id = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
    return `https://www.linkedin.com/in/${encodeURIComponent(id)}/`;
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
    const input: LaunchConfigInput = {
      userDataDir: join(this.config.profileDir, accountId),
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
