// session — browser session and cookie-vault lifecycle.

export type {
  LaunchConfigInput,
  ProxyIdentity,
  ResolvedLaunchConfig,
} from './context-factory.js';
export {
  BrowserContextFactory,
  buildLaunchConfig,
} from './context-factory.js';
export type {
  HumanTask,
  HumanTaskSink,
  SessionDeps,
  SessionHealth,
} from './lifecycle.js';
export {
  bootstrap,
  raiseChallenge,
  refresh,
  resume,
  validate,
} from './lifecycle.js';
export type { PastedSession } from './link.js';
export { buildStorageStateFromPastedCookies } from './link.js';
export { createPatchrightLauncher } from './patchright-launcher.js';
export { KNOWN_CITIES, resolveProxyIdentity } from './proxy-identity.js';
export {
  extractSessionCookies,
  loadStorageState,
  open,
  resolveVaultKey,
  saveStorageState,
  seal,
  VaultError,
} from './vault.js';
