// Centralized LinkedIn DOM selectors. LinkedIn changes its markup often, so
// every selector the runner depends on lives here and nowhere else. When the
// DOM shifts, this is the only file to update.
//
// These are public DOM facts observed on linkedin.com. They are best-effort and
// MUST be re-verified against a live page before trusting them in production.
// Flagged verify-live points are noted inline.

export const SELECTORS = {
  // --- Connect / invite flow ---------------------------------------------
  // Primary "Connect" button on a profile. LinkedIn exposes an aria-label.
  connectButton: 'button[aria-label*="Invite"][aria-label*="connect"]',
  // Fallback connect entry hidden behind the "More" overflow menu.
  moreActionsButton: 'button[aria-label*="More actions"]',
  connectInMenu: 'div[aria-label*="Invite"][role="button"]',
  // "Add a note" button in the invite modal.
  addNoteButton: 'button[aria-label*="Add a note"]',
  // Note textarea in the invite modal.
  noteTextarea: 'textarea[name="message"]',
  // "Send" / "Send invitation" button in the invite modal.
  sendInviteButton: 'button[aria-label*="Send"]',

  // --- Messaging ----------------------------------------------------------
  messageButton: 'button[aria-label*="Message"]',
  messageComposeBox: 'div.msg-form__contenteditable[contenteditable="true"]',
  messageSendButton: 'button.msg-form__send-button',
  // A single conversation row in the inbox list.
  inboxConversationRow: 'li.msg-conversation-listitem',
  // Message bubbles within an open conversation.
  conversationMessageBubble: 'div.msg-s-event-listitem',

  // --- Follow / react -----------------------------------------------------
  followButton: 'button[aria-label*="Follow"]',
  reactButton: 'button[aria-label*="React"]',

  // --- Withdraw sent invite ----------------------------------------------
  // On the sent-invitations manager page.
  withdrawInviteButton: 'button[aria-label*="Withdraw"]',
  confirmWithdrawButton: 'button[aria-label*="Withdraw"][class*="artdeco-button--primary"]',

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
