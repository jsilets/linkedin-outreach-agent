// executor — performs LinkedIn actions in the browser, gated on an allow token.

export type { ActionContext, ActionResultOut, ReactionType } from './actions.js';

export {
  connect,
  follow,
  getConversation,
  message,
  react,
  readInbox,
  visitProfile,
  withdrawInvite,
} from './actions.js';
export {
  assertAllowed,
  checkToken,
  NotAllowedError,
} from './gate.js';
