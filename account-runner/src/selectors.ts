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
  // Scoped to the profile action bar: inside <main> but NOT inside any <aside>.
  // Critical (live-verified 2026-07): LinkedIn renders "People you may know"
  // recommendation cards inside an <aside> WITHIN <main>, and each card has its
  // own "Connect" button. An unscoped selector matched those and made the flow
  // click a stranger's Connect when the real profile was Follow-by-default or
  // already Pending. Class names are hashed, so anchor on aria-label + the
  // aside exclusion (XPath ancestor axis) rather than any class or the h1
  // (obfuscated profiles ship no <h1>). Matches OpenOutreach's top-card scope.
  connectButton:
    'xpath=//main//*[(self::button or self::a) and not(ancestor::aside) and (' +
    '(contains(@aria-label,"Invite") and contains(@aria-label,"connect")) or ' +
    './/span[normalize-space(.)="Connect"])]',
  // "More" overflow ("...") button on the profile card. Holds the Connect
  // entry when there is no top-level Connect button (e.g. Follow-by-default
  // profiles). Scoped the same way as connectButton (main, never an <aside>
  // recommendation card); the global nav and messaging overlay live outside
  // <main> so they are excluded too. The executor tries each visible match.
  // Live-verified (2026-07-10): the profile-card More button that opens the
  // overflow holding Connect carries the visible TEXT "More" but NO
  // aria-label="More" (an aria-only "More" nearby opens a different menu with no
  // Connect). Match either form; the executor tries each visible candidate and
  // keeps the one whose menu exposes Connect. Exact text "More" avoids feed
  // "…more" expanders.
  moreActionsButton:
    'xpath=//main//button[not(ancestor::aside) and ' +
    '(@aria-label="More" or contains(@aria-label,"More actions") or normalize-space(.)="More")]',
  // "Connect" entry inside the opened More menu. Live-verified (2026-07-10,
  // Follow-by-default profile): the item is an <a role="menuitem"> wrapping a
  // <div aria-label="Invite <Name> to connect">, inside a portal
  // div[role="menu"]. Critically, the "People you may know" recommendation cards
  // ALSO render Connect controls with the same "Invite <someone> to connect"
  // aria-label — but as <button>s OUTSIDE any [role="menu"]. So the primary
  // clause scopes to [role="menu"] to click THIS profile's Connect, never a
  // stranger's card. Text-based and legacy clauses follow as fallbacks.
  connectInMenu:
    '[role="menu"] [role="menuitem"]:has-text("Connect"), ' +
    '[role="menu"] [aria-label*="Invite" i][aria-label*="to connect" i], ' +
    '[role="menuitem"][aria-label*="Invite" i][aria-label*="to connect" i], ' +
    '[role="menuitem"]:has-text("Connect"), ' +
    'div[role="button"][aria-label^="Invite"][aria-label*="to connect"], ' +
    'div[role="button"]:has-text("Connect")',
  // Already-invited signal on the profile action bar: LinkedIn shows a "Pending"
  // control in place of Connect once an invite is outstanding. Live-verified
  // (2026-07-08, authenticated): it is an <a>, NOT a <button>, with
  // aria-label="Pending, click to withdraw invitation sent to <Name>" — an
  // earlier button-only selector missed it entirely. Match anchor OR button.
  // Scoped like connectButton (main, never an <aside> card) so a recommendation
  // card's state never reads as this profile's. connect() checks this FIRST and
  // stops without re-inviting — the fix for "didn't notice the invite was
  // pending".
  pendingIndicator:
    'xpath=//main//*[(self::a or self::button) and not(ancestor::aside) and ' +
    '(contains(@aria-label,"Pending") or normalize-space(.)="Pending")]',
  // "Pending" entry inside the opened More menu (a body-level portal, so matched
  // page-wide like connectInMenu). The menu-path twin of pendingIndicator;
  // mirrors Linki's pending check before it clicks Connect.
  pendingInMenu:
    '[role="menuitem"]:has-text("Pending"), ' +
    'div[role="button"][aria-label*="Pending"]',
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
  // Email-required gate: for some members LinkedIn will not send an invite until
  // you supply the recipient's email ("To verify this member knows you, please
  // enter their email to connect"). The invite modal then shows an email input
  // instead of (or above) the Send controls. We detect this and flag it rather
  // than hanging on a Send that never enables. verify-live.
  emailRequiredModal:
    'div[role="dialog"]:has(input[type="email"]), ' +
    'div[role="dialog"]:has(input[name="email"]), ' +
    'div[role="dialog"]:has-text("enter their email"), ' +
    'div[role="dialog"]:has-text("enter the email"), ' +
    'div[role="dialog"]:has-text("email to connect")',
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
