// session — browser session and cookie-vault lifecycle.

export {
  VaultError,
  resolveVaultKey,
  seal,
  open,
  saveStorageState,
  loadStorageState,
  extractSessionCookies,
} from './vault.js';

export {
  BrowserContextFactory,
  buildLaunchConfig,
} from './context-factory.js';
export type {
  ProxyIdentity,
  LaunchConfigInput,
  ResolvedLaunchConfig,
} from './context-factory.js';

export {
  bootstrap,
  resume,
  validate,
  refresh,
  raiseChallenge,
} from './lifecycle.js';
export type {
  HumanTask,
  HumanTaskSink,
  SessionHealth,
  SessionDeps,
} from './lifecycle.js';
