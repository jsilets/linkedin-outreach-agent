// Centralized LinkedIn DOM selectors. LinkedIn changes its markup often, so
// every selector the runner depends on lives here and nowhere else. When the
// DOM shifts, this is the only file to update.
//
// These are public DOM facts observed on linkedin.com. They are best-effort and
// MUST be re-verified against a live page before trusting them in production.
// Flagged verify-live points are noted inline.

export const SELECTORS = {
  // --- Connect / invite flow ---------------------------------------------
  // LinkedIn A/B-tests this UI per account and renames classes often, so each
  // entry is an OR-chain of fallbacks (Playwright matches any; the executor
  // clicks .first). Patterns cross-checked against the OpenOutreach and Linki
  // open-source runners, then re-verified live via `npm run selector-scan`.
  //
  // Primary top-level "Connect" button, present when the profile offers it.
  connectButton:
    'button[aria-label*="Invite"][aria-label*="connect"], ' +
    'button[aria-label*="Invite"][aria-label*="to connect"], ' +
    'button:has(span:text-is("Connect"))',
  // "More" overflow ("...") button on the profile card. Holds the Connect
  // entry when there is no top-level Connect button (e.g. Follow-by-default
  // profiles). The bare aria-label="More" is what live LinkedIn ships today;
  // scoped to <main> because the global nav and messaging overlay carry their
  // own "More" buttons (live scan: 5 page-wide, 2 inside main). The executor
  // clicks .first — the profile action bar renders first within main.
  moreActionsButton:
    'main button[aria-label="More"], ' +
    'main button[aria-label*="More actions"]',
  // "Connect" entry inside the opened More menu. The dropdown renders as a
  // portal outside the profile card, so this is matched page-wide, not scoped.
  connectInMenu:
    'div[role="button"][aria-label^="Invite"][aria-label*="to connect"], ' +
    '[role="menuitem"]:has-text("Connect"), ' +
    'div[role="button"]:has-text("Connect")',
  // "Add a note" button in the invite modal.
  addNoteButton: 'button[aria-label*="Add a note"]',
  // Note field in the invite modal. Live-observed (2026-07): modern LinkedIn
  // uses a contenteditable div inside the dialog, not a <textarea>; legacy
  // textarea forms kept as fallbacks.
  noteTextarea:
    'div[role="dialog"] div[contenteditable="true"], ' +
    'textarea[name="message"], ' +
    'textarea[id*="custom-message"]',
  // "Send" button in the invite modal (used for the WITH-note path).
  sendInviteButton:
    'button[aria-label*="Send invitation"], ' +
    'button:has-text("Send now"), ' +
    'button[aria-label*="Send"]',
  // Explicit "Send without a note" action. Critical: LinkedIn pre-fills a
  // suggested note ("Hi <Name>, it's great to connect…"), so the note-less
  // path must use THIS (or clear the note field) — never a generic Send, which
  // would ship the canned suggestion. verify-live.
  sendWithoutNoteButton:
    'button[aria-label*="Send without a note"], ' +
    'button[aria-label*="Send without"], ' +
    'button:has-text("Send without a note"), ' +
    'button:has-text("Send now")',
  // Error toast LinkedIn shows when it REFUSES to send an invite (rate limit,
  // recently-removed connection, or transient). Live-observed text: "Sorry,
  // invitation not sent … Please try again." Lets connect() report ok:false
  // instead of a false success.
  inviteErrorToast:
    'div[data-test-artdeco-toast-item-type="error"], ' +
    '[role="alert"]:has-text("not sent"), ' +
    '[class*="toast"]:has-text("not sent")',

  // --- Messaging ----------------------------------------------------------
  // OR-chains: ARIA/role-first (survives class renames), class fragments last.
  // messageButton scoped to <main> so it doesn't match the global-nav messaging
  // launcher. verify-live: all three need a live 1st-degree thread to confirm.
  messageButton:
    'main button[aria-label^="Message"], ' +
    'main a[aria-label^="Message"], ' +
    'main button:has(span:text-is("Message"))',
  messageComposeBox:
    'div[role="textbox"][aria-label*="message" i], ' +
    'div[contenteditable="true"][aria-label*="message" i], ' +
    'div[class*="msg-form__contenteditable"][contenteditable="true"], ' +
    'div.msg-form__contenteditable[contenteditable="true"]',
  messageSendButton:
    'button[type="submit"][aria-label*="Send" i], ' +
    'button.msg-form__send-button, ' +
    'button[class*="msg-form__send"], ' +
    'form.msg-form button[type="submit"]',
  // A single conversation row in the inbox list.
  inboxConversationRow: 'li.msg-conversation-listitem',
  // Message bubbles within an open conversation.
  conversationMessageBubble: 'div.msg-s-event-listitem',

  // --- Follow / react -----------------------------------------------------
  followButton: 'button[aria-label*="Follow"]',
  // Post reaction. Live-verified on the feed (2026-07): the trigger's aria-label
  // contains "React"; a single click applies the default Like, and hovering it
  // opens a flyout whose options are labelled by reaction name (each matched
  // exactly once after hover). Use .first() to pin the main post's trigger.
  reactTrigger: 'button[aria-label*="React"]',
  reactionLike: 'button[aria-label*="Like" i]',
  reactionCelebrate: 'button[aria-label*="Celebrate" i]',
  reactionLove: 'button[aria-label*="Love" i]',
  reactionInsightful: 'button[aria-label*="Insightful" i]',
  reactionFunny: 'button[aria-label*="Funny" i]',
  reactionSupport: 'button[aria-label*="Support" i]',

  // --- Withdraw sent invite ----------------------------------------------
  // On the sent-invitations manager (/mynetwork/invitation-manager/sent/). The
  // executor scopes withdrawInviteButton to the target's row via its profile
  // anchor, so keep it a SINGLE selector (a comma OR-chain would break the row
  // scoping — a descendant prefix binds only the first clause). confirm is
  // scoped to the modal. verify-live: unverified (no pending invite to scan).
  withdrawInviteButton: 'button[aria-label*="Withdraw"]',
  confirmWithdrawButton:
    'div[role="alertdialog"] button[aria-label*="Withdraw"], ' +
    'div.artdeco-modal button[aria-label*="Withdraw"], ' +
    'div[role="dialog"] button:has(span:text-is("Withdraw"))',

  // --- Restriction / challenge signals (feed the detector) ---------------
  // Weekly invite-cap warning popup. Class fragment is a known public fact;
  // verify-live: confirm the class still matches after LinkedIn DOM changes.
  weeklyLimitAlert: '[class*="ip-fuse-limit-alert__warning"]',
  // Generic "you're viewing too many profiles" throttle warning. verify-live.
  viewLimitWarning: '[class*="profile-view-limit"]',
  // Security checkpoint / challenge page markers. verify-live.
  challengeContainer: '#captcha-internal, .challenge-dialog, [data-test-id*="challenge"]',
  // Account-restricted / ban banner. verify-live.
  banBanner: '[class*="restriction"] , [class*="account-restricted"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;
