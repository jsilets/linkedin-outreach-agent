// @loa/account-runner — the per-account browser body.
//
// Three responsibilities, one per sub-module:
//   session/   session lifecycle + encrypted cookie vault + context factory
//   executor/  human-like DOM actions, gated on a control-plane allow token
//   detector/  restriction-signal detection emitting @loa/shared Signal objects
//   safety/    thin LOCAL pre-flight mirror (advisory; real gate is the control plane)
//
// Domain types come only from @loa/shared. The browser driver is patchright
// (the maintained stealth Playwright drop-in); the runner talks to it through
// the local PORT interfaces in ports.ts so it stays testable without a browser.

export * from './detector/index.js';
export * from './executor/index.js';
export type { Sleeper } from './human.js';
export {
  actionGapMs,
  clickDelayMs,
  randInt,
  realSleep,
  typingDelayMs,
} from './human.js';
export * from './ports.js';
export type { PreflightResult } from './safety/index.js';
export { preflight } from './safety/index.js';
export type { SelectorKey } from './selectors.js';
export { SELECTORS } from './selectors.js';
export * from './session/index.js';
export type { SentInvitation } from './voyager/sent-invitations.js';
export {
  invitationIdFromUrn,
  normalizeSentInvitationsResponse,
  readSentInvitations,
  sentInvitationsPath,
  WITHDRAW_INVITATION_BODY,
  withdrawInvitationPath,
} from './voyager/sent-invitations.js';
