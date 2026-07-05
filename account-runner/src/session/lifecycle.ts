// Session lifecycle. bootstrap (assisted headful login), resume (reuse profile +
// inject cookies), validate/refresh (session health), and raiseHumanTask on a
// challenge. We never try to defeat a checkpoint; we hand it to a human.

import type {
  BrowserContextPort,
  PagePort,
  StorageStateShape,
} from '../ports.js';
import { BrowserContextFactory } from './context-factory.js';
import type { LaunchConfigInput } from './context-factory.js';
import { loadStorageState, saveStorageState } from './vault.js';
import { SELECTORS } from '../selectors.js';

/** A task escalated to a human operator (e.g. a login or a checkpoint). */
export interface HumanTask {
  kind: 'login' | 'challenge';
  accountId: string;
  reason: string;
  /** Where the human should pick up (URL at time of escalation). */
  atUrl?: string;
  raisedAt: Date;
}

/** Sink the runner calls to escalate a task. Wired to the control plane. */
export type HumanTaskSink = (task: HumanTask) => Promise<void> | void;

/** Result of a session validation check. */
export interface SessionHealth {
  valid: boolean;
  /** Set when a challenge/checkpoint was detected. */
  challenged: boolean;
  atUrl: string;
}

const FEED_URL = 'https://www.linkedin.com/feed/';
const LOGIN_URL = 'https://www.linkedin.com/login';

export interface SessionDeps {
  factory: BrowserContextFactory;
  vaultPath: string;
  accountId: string;
  raiseHumanTask: HumanTaskSink;
}

/**
 * bootstrap: assisted, headful, one-time login seam. Opens a persistent context
 * for a human to log in by hand, escalates a login task, then persists the
 * resulting storage state to the vault. The wait-for-human is injected so tests
 * can resolve it immediately without a real browser.
 */
export async function bootstrap(
  deps: SessionDeps,
  input: LaunchConfigInput,
  waitForHumanLogin: (ctx: BrowserContextPort, page: PagePort) => Promise<void>,
): Promise<StorageStateShape> {
  // Force headful so a human can actually log in.
  const { context } = await deps.factory.launch({ ...input, headless: false });
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await deps.raiseHumanTask({
    kind: 'login',
    accountId: deps.accountId,
    reason: 'Assisted login required to bootstrap this account session.',
    atUrl: page.url(),
    raisedAt: new Date(),
  });
  await waitForHumanLogin(context, page);
  const state = await context.storageState();
  await saveStorageState(deps.vaultPath, state);
  return state;
}

/**
 * resume: reuse the persistent userDataDir and inject vaulted cookies into a
 * fresh context. Returns the live context + page for the executor to drive.
 */
export async function resume(
  deps: SessionDeps,
  input: LaunchConfigInput,
): Promise<{ context: BrowserContextPort; page: PagePort }> {
  const state = await loadStorageState(deps.vaultPath);
  const { context } = await deps.factory.launch(input);
  if (state.cookies.length > 0) {
    await context.addCookies(state.cookies);
  }
  const page = await context.newPage();
  return { context, page };
}

/**
 * validate: navigate to the feed and check whether the session is still logged
 * in and un-challenged. Detects a challenge via the shared selector and, if
 * present, escalates a human task instead of trying to solve it.
 */
export async function validate(
  deps: SessionDeps,
  page: PagePort,
): Promise<SessionHealth> {
  await page.goto(FEED_URL, { waitUntil: 'domcontentloaded' });
  const atUrl = page.url();
  const challenged = (await page.locator(SELECTORS.challengeContainer).count()) > 0;
  if (challenged) {
    await raiseChallenge(deps, atUrl);
    return { valid: false, challenged: true, atUrl };
  }
  // A session bounced to /login (or a checkpoint path) is not valid.
  const redirectedToLogin = atUrl.includes('/login') || atUrl.includes('/checkpoint');
  return { valid: !redirectedToLogin, challenged: false, atUrl };
}

/**
 * refresh: re-validate and, when still healthy, re-persist the current storage
 * state so a rotated cookie is captured. Returns the latest health.
 */
export async function refresh(
  deps: SessionDeps,
  context: BrowserContextPort,
  page: PagePort,
): Promise<SessionHealth> {
  const health = await validate(deps, page);
  if (health.valid) {
    const state = await context.storageState();
    await saveStorageState(deps.vaultPath, state);
  }
  return health;
}

/** Escalate a checkpoint/challenge to a human. Never auto-solved. */
export async function raiseChallenge(deps: SessionDeps, atUrl: string): Promise<void> {
  await deps.raiseHumanTask({
    kind: 'challenge',
    accountId: deps.accountId,
    reason: 'Security checkpoint/challenge detected. Human intervention required.',
    atUrl,
    raisedAt: new Date(),
  });
}
