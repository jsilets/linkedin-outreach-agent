// executor — performs LinkedIn actions in the browser, gated on an allow token.

export {
  NotAllowedError,
  checkToken,
  assertAllowed,
} from './gate.js';

export {
  visitProfile,
  connect,
  message,
  readInbox,
  getConversation,
  follow,
  withdrawInvite,
  react,
} from './actions.js';
export type { ActionContext, ActionResultOut, ReactionType } from './actions.js';
