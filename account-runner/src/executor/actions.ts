// Human-like DOM actions. Each is a small async function that takes a PagePort
// plus params, asserts the allow token first, then drives the centralized
// selectors with human typing/click delays and randomized between-step gaps.

import type { Action } from '@loa/shared';
import { actionGapMs, clickDelayMs, realSleep, type Sleeper } from '../human.js';
import type { AllowToken, LocatorPort, PagePort } from '../ports.js';
import { SELECTORS } from '../selectors.js';
import { assertAllowed } from './gate.js';

/** Shared context every action needs: the page, the authorizing token, ids. */
export interface ActionContext {
  page: PagePort;
  token: AllowToken;
  action: Action;
  accountId: string;
  /** Injectable so tests skip real waits. */
  sleep?: Sleeper;
  /** Injectable RNG for deterministic pacing in tests. */
  rng?: () => number;
  /** Injectable clock for token-expiry checks. */
  now?: () => number;
}

/** Typed result common to every action. */
export interface ActionResultOut {
  ok: boolean;
  detail?: string;
}

// --- internal pacing helpers ---------------------------------------------

async function gap(ctx: ActionContext): Promise<void> {
  const sleep = ctx.sleep ?? realSleep;
  await sleep(actionGapMs(ctx.rng));
}

/** Human-paced click of an already-resolved locator (hover, settle, click). */
async function clickLoc(ctx: ActionContext, loc: LocatorPort): Promise<void> {
  await loc.waitFor({ state: 'visible' });
  await loc.hover();
  const sleep = ctx.sleep ?? realSleep;
  await sleep(clickDelayMs(ctx.rng));
  await loc.click({ delay: clickDelayMs(ctx.rng) });
}

async function humanClick(ctx: ActionContext, selector: string): Promise<void> {
  // .first(): selectors are OR-chains that can match several elements; clicking
  // an unnarrowed multi-match locator trips Playwright strict mode.
  await clickLoc(ctx, ctx.page.locator(selector).first());
}

async function humanType(ctx: ActionContext, selector: string, text: string): Promise<void> {
  const loc = ctx.page.locator(selector).first();
  await loc.waitFor({ state: 'visible' });
  // The message composer (and connect-note box) open in an overlay that can
  // render OUTSIDE the viewport, where a pointer click and per-key type() both
  // stall ("element is outside of the viewport"). focus() needs no viewport.
  await loc.focus();
  // Clear anything already in the box before typing. LinkedIn pre-fills a
  // recent-connection composer with a suggested/AI icebreaker ("Hi X, it's great
  // to connect…"); without this our text would be APPENDED to it. fill('') clears
  // a contenteditable; the keyboard path then inserts our body from empty.
  await loc.fill('');
  const page = ctx.page;
  if (page.insertText && page.pressKey) {
    // Enter the body as discrete lines so blank-line paragraph breaks survive:
    // insert each line, then Shift+Enter for the newline. Plain Enter would SEND
    // the message, so it must be Shift+Enter. insertText is paste-like (one
    // input event, no per-key stall) and dispatches the event LinkedIn's editor
    // needs to enable Send. The between-actions pacer, not per-key cadence, is
    // the anti-burst defense.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.pressKey('Shift+Enter');
      if (lines[i]) await page.insertText(lines[i]!);
    }
  } else {
    // Fallback for fakes/ports without keyboard access: atomic fill (no line
    // breaks, but the input event still enables Send).
    await loc.fill(text);
  }
}

/**
 * Activate a button that may render OUTSIDE the viewport (the message-composer
 * overlay's Send button). A pointer hover/click there fails the viewport
 * actionability check, so focus it and press Enter — a focused button activates
 * on Enter with no viewport requirement. Falls back to a normal click when the
 * page has no keyboard access (lightweight fakes).
 */
async function pressButton(ctx: ActionContext, selector: string): Promise<void> {
  const loc = ctx.page.locator(selector).first();
  await loc.waitFor({ state: 'visible' });
  if (ctx.page.pressKey) {
    await loc.focus();
    await ctx.page.pressKey('Enter');
  } else {
    await clickLoc(ctx, loc);
  }
}

/** True if at least one element matches; lets connect() branch without throwing. */
async function isPresent(ctx: ActionContext, selector: string): Promise<boolean> {
  return (await ctx.page.locator(selector).count()) > 0;
}

/** Prefix every comma-part of a (possibly multi-part) selector with an ancestor
 * scope, confining the whole OR-chain to one container. */
function scopeSelector(scope: string, sel: string): string {
  return sel
    .split(',')
    .map((s) => `${scope} ${s.trim()}`)
    .join(', ');
}

/** The /in/<publicId> slug from a profile URL, or undefined. Used to scope the
 * message composer to the intended recipient's conversation. */
function publicIdFromProfileUrl(url: string): string | undefined {
  const m = url.match(/\/in\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/**
 * Open the profile's "More" overflow menu that holds Connect. The selector can
 * match several "More" buttons (profile card vs. an activity post), so try each
 * candidate and keep the one whose menu actually exposes a Connect entry rather
 * than blindly clicking the first. Throws if none do.
 */
async function openConnectMenu(ctx: ActionContext): Promise<'connect' | 'pending' | 'none'> {
  const candidates: LocatorPort = ctx.page.locator(SELECTORS.moreActionsButton);
  const n = await candidates.count();
  const sleep = ctx.sleep ?? realSleep;
  for (let i = 0; i < n; i++) {
    const cand = candidates.nth(i);
    // Only click candidates that actually become visible; a scoped selector can
    // still match a hidden/stale "More" and clickLoc's default wait would hang.
    const visible = await cand
      .waitFor({ state: 'visible', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (!visible) continue;
    await clickLoc(ctx, cand);
    // The dropdown renders (and animates) AFTER the click, so a single immediate
    // probe races it and reads 0 — the bug that made Follow-by-default profiles
    // fail. Poll for the menu's Pending/Connect entry before moving on. Pending
    // is checked first: an already-invited profile shows it and no Connect.
    for (let t = 0; t < 12; t++) {
      if (await isPresent(ctx, SELECTORS.pendingInMenu)) return 'pending';
      if (await isPresent(ctx, SELECTORS.connectInMenu)) return 'connect';
      await sleep(300);
    }
    // This "More" candidate's menu never exposed Connect; try the next one.
  }
  // No inline Connect AND no Connect in any "More" menu: the profile is
  // Follow-by-default with Connect withheld, or Follow-only. Report 'none' so
  // the caller can skip it cleanly rather than throwing an error.
  return 'none';
}

/**
 * Wait for the profile action bar to expose a terminal connect signal. The bar
 * is client-rendered and attaches AFTER domcontentloaded, so probing it once
 * immediately races hydration: the "More" button can attach a beat before the
 * inline Connect control, so a single early probe reads 0 Connect matches and
 * wrongly falls through to the Follow-by-default (More-menu) path. Poll until an
 * inline Connect control appears, an already-Pending state appears, or the
 * budget of attempts is spent (treated as "no inline Connect" — the caller then
 * tries the More-overflow menu). Attempt-bounded (not wall-clock) so injected
 * no-op sleeps in tests terminate deterministically.
 */
async function waitForConnectSignal(
  ctx: ActionContext,
  timeoutMs: number,
): Promise<'connect' | 'pending' | 'none'> {
  // The "More" button is on essentially every profile; wait for it first so we
  // do not spin the whole budget on a page that is still blank.
  await ctx.page
    .locator(SELECTORS.moreActionsButton)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {});
  const sleep = ctx.sleep ?? realSleep;
  const attempts = Math.max(1, Math.ceil(timeoutMs / 300));
  for (let i = 0; i < attempts; i++) {
    // Pending is checked first: an already-invited profile shows Pending in
    // place of Connect, and we must never re-invite.
    if (await isPresent(ctx, SELECTORS.pendingIndicator)) return 'pending';
    if (await isPresent(ctx, SELECTORS.connectButton)) return 'connect';
    await sleep(300);
  }
  // Diagnostic: record what the live page exposed so a persistent 'none' can be
  // told apart from a stale selector vs. a logged-out / challenged render.
  try {
    const [cBtn, more, pend, mainCount] = await Promise.all([
      ctx.page.locator(SELECTORS.connectButton).count(),
      ctx.page.locator(SELECTORS.moreActionsButton).count(),
      ctx.page.locator(SELECTORS.pendingIndicator).count(),
      ctx.page.locator('main').count(),
    ]);
    console.error(
      `[connect-debug] signal=none url=${ctx.page.url()} connectButton=${cBtn} more=${more} pending=${pend} main=${mainCount}`,
    );
  } catch (err) {
    console.error(
      `[connect-debug] diag failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return 'none';
}

/**
 * Send a connection invite with NO note. LinkedIn pre-fills a suggested note
 * ("Hi <Name>, it's great to connect…"), so a naive Send would ship that canned
 * text as a connection note. Prefer an explicit "Send without a note" button;
 * if the modal only offers a generic Send over a pre-filled note field, clear
 * the field first so nothing canned goes out either way.
 */
async function sendWithoutNote(ctx: ActionContext): Promise<void> {
  // Wait for the "Send without a note" button rather than racing the modal
  // render (an instant presence check can miss it mid-animation). The suggested
  // note is a contenteditable div we simply decline — never typed into here.
  const loc = ctx.page.locator(SELECTORS.sendWithoutNoteButton).first();
  const appeared = await loc
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    // No modal appeared. Some profiles create the invite immediately on Connect
    // with no confirmation modal; if the profile is now Pending the invite went
    // through, so treat that as success rather than a false failure (the old
    // behavior hard-timed-out here and reported a send that had succeeded as an
    // error).
    if (await isPresent(ctx, SELECTORS.pendingIndicator)) return;
    throw new Error('connect: invite modal did not appear and no pending state followed');
  }
  await clickLoc(ctx, loc);
}

function guard(ctx: ActionContext): void {
  assertAllowed(ctx.token, ctx.action, ctx.accountId, ctx.now?.());
}

// --- actions --------------------------------------------------------------

/** Visit a profile by URL. Building block for most other actions. */
export async function visitProfile(
  ctx: ActionContext,
  profileUrl: string,
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  return { ok: true, detail: `visited ${profileUrl}` };
}

/** Send a connection invite, optionally with a note. */
export async function connect(
  ctx: ActionContext,
  params: { profileUrl: string; note?: string },
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(params.profileUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  // The action bar is client-rendered and attaches AFTER domcontentloaded. Poll
  // for a terminal signal (inline Connect, or already-Pending) instead of
  // probing once — a single early probe races hydration and misreads a normal
  // Connect-inline profile as Follow-by-default, then throws in the menu path.
  const signal = await waitForConnectSignal(ctx, 12_000);
  if (signal === 'pending') {
    return { ok: true, detail: 'already pending; no invite sent' };
  }
  // Two ways in: the inline Connect control, or — on Follow-by-default profiles
  // that keep it in the "More" overflow — the menu entry. Fall to the menu only
  // after hydration settled and no inline Connect appeared.
  let via: 'direct' | 'more-menu';
  if (signal === 'connect') {
    via = 'direct';
    await humanClick(ctx, SELECTORS.connectButton);
  } else {
    via = 'more-menu';
    const menu = await openConnectMenu(ctx);
    if (menu === 'pending') {
      return { ok: true, detail: 'already pending; no invite sent (more-menu)' };
    }
    if (menu === 'none') {
      return {
        ok: false,
        detail:
          'no inline Connect and none in the More menu (Follow-by-default/Follow-only); no invite sent',
      };
    }
    await humanClick(ctx, SELECTORS.connectInMenu);
  }
  await gap(ctx);
  // Email-gated invite: for some members LinkedIn demands the recipient's email
  // before it will send, showing an email input in place of the normal Send
  // controls. We do not have their email, so flag it rather than hang on a Send
  // that never enables.
  if (await isPresent(ctx, SELECTORS.emailRequiredModal)) {
    return { ok: false, detail: 'needs recipient email to connect (email-gated); no invite sent' };
  }
  if (params.note && params.note.length > 0) {
    await humanClick(ctx, SELECTORS.addNoteButton);
    await humanType(ctx, SELECTORS.noteTextarea, params.note);
    await gap(ctx);
    await humanClick(ctx, SELECTORS.sendInviteButton);
  } else {
    await gap(ctx);
    await sendWithoutNote(ctx);
  }
  // LinkedIn may refuse the invite (rate limit / recently-removed connection /
  // transient) with an error toast. Surface that as a failure — a click that
  // did not throw is NOT proof the invite was created.
  await ctx.page.waitForTimeout(1500);
  if (await isPresent(ctx, SELECTORS.inviteErrorToast)) {
    const raw = await ctx.page.locator(SELECTORS.inviteErrorToast).first().textContent();
    const msg = raw?.replace(/\s+/g, ' ').trim();
    return { ok: false, detail: `invite refused by LinkedIn: ${msg ?? 'error toast'}` };
  }
  const how = params.note ? 'invited with note' : 'invited';
  return { ok: true, detail: `${how} (${via})` };
}

/**
 * Send a direct message to the person at `profileUrl`.
 *
 * SAFETY: LinkedIn keeps multiple chat overlays open at once, so the compose box
 * and Send button must be scoped to the ONE conversation that provably belongs
 * to this recipient — matched by a link to their /in/<publicId> inside the
 * overlay bubble. If that scoped conversation is not open, we REFUSE to send
 * (ok:false) rather than risk typing into a different person's conversation
 * (which once mis-sent a message to the wrong connection). The composer is also
 * cleared first, because LinkedIn pre-fills a suggested/AI icebreaker.
 */
export async function message(
  ctx: ActionContext,
  params: { profileUrl: string; body: string },
): Promise<ActionResultOut> {
  guard(ctx);
  const publicId = publicIdFromProfileUrl(params.profileUrl);
  if (!publicId) {
    return {
      ok: false,
      detail: `no /in/ id in ${params.profileUrl}; refusing to send (cannot verify recipient)`,
    };
  }
  await ctx.page.goto(params.profileUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  await humanClick(ctx, SELECTORS.messageButton);

  // The overlay bubble for THIS recipient: the conversation bubble that contains
  // a link to their profile. Scoping the box + Send to it makes a wrong-recipient
  // send impossible even when other conversations are open.
  const convo = `${SELECTORS.messageConversationBubble}:has(a[href*="/in/${publicId}/"])`;
  await ctx.page.waitForTimeout(1500);
  if (!(await isPresent(ctx, convo))) {
    return {
      ok: false,
      detail: `recipient conversation for /in/${publicId} did not open; refusing to send to avoid a wrong recipient`,
    };
  }

  await humanType(ctx, scopeSelector(convo, SELECTORS.messageComposeBox), params.body);
  await gap(ctx);
  // The Send button lives in the same off-viewport overlay as the composer, so
  // activate it via focus+Enter rather than a pointer click (see pressButton).
  await pressButton(ctx, scopeSelector(convo, SELECTORS.messageSendButton));
  return { ok: true, detail: 'message sent' };
}

/** Read the inbox conversation list; returns the number of visible threads. */
export async function readInbox(ctx: ActionContext): Promise<ActionResultOut & { count: number }> {
  guard(ctx);
  await ctx.page.goto('https://www.linkedin.com/messaging/', {
    waitUntil: 'domcontentloaded',
  });
  await gap(ctx);
  const count = await ctx.page.locator(SELECTORS.inboxConversationRow).count();
  return { ok: true, count, detail: `${count} conversations` };
}

/** Read a single conversation; returns the message bodies in order. */
export async function getConversation(
  ctx: ActionContext,
  threadUrl: string,
): Promise<ActionResultOut & { messages: string[] }> {
  guard(ctx);
  await ctx.page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  const bubbles = ctx.page.locator(SELECTORS.conversationMessageBubble);
  const n = await bubbles.count();
  const messages: string[] = [];
  for (let i = 0; i < n; i++) {
    const text = await bubbles.nth(i).textContent();
    if (text) messages.push(text.trim());
  }
  return { ok: true, messages, detail: `${messages.length} messages` };
}

/** Follow a profile without connecting. */
export async function follow(ctx: ActionContext, profileUrl: string): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  await humanClick(ctx, SELECTORS.followButton);
  return { ok: true, detail: 'followed' };
}

const SENT_INVITATIONS_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';

/** Lowercased /in/<vanity> slug — the identity key on the sent-invites list. */
function vanityFromUrl(profileUrl: string): string | null {
  const m = profileUrl.match(/\/in\/([^/?#]+)/);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Withdraw button scoped to the row that also holds this profile's anchor, so
 * we never withdraw the globally-first invite. withdrawInviteButton must stay a
 * single selector: the descendant prefix binds only the first OR-chain clause.
 */
function withdrawButtonForVanity(vanity: string): string {
  const btn = SELECTORS.withdrawInviteButton;
  return (
    `li:has(a[href*="/in/${vanity}"]) ${btn}, ` +
    `div[class*="invitation-card"]:has(a[href*="/in/${vanity}"]) ${btn}`
  );
}

/**
 * Withdraw a previously sent invite, targeted by the invitee's profile URL.
 * Navigates to the sent-invitations manager, finds THAT profile's row, and
 * clicks its own Withdraw button, then confirms. Fails safe: returns ok:false
 * without acting if the invite is not among the rendered rows (already
 * accepted / withdrawn), so it never withdraws the wrong person.
 *
 * verify-live + known limit: the sent list is virtualized, so this only sees
 * the initially-rendered rows; reaching lower rows needs a page.evaluate scroll
 * seam the port does not expose yet.
 */
export async function withdrawInvite(
  ctx: ActionContext,
  params: { profileUrl: string },
): Promise<ActionResultOut> {
  guard(ctx);
  const vanity = vanityFromUrl(params.profileUrl);
  if (!vanity) return { ok: false, detail: `no /in/ vanity in ${params.profileUrl}` };
  await ctx.page.goto(SENT_INVITATIONS_URL, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  const rowWithdraw = withdrawButtonForVanity(vanity);
  if (!(await isPresent(ctx, rowWithdraw))) {
    return { ok: false, detail: `no pending invite for ${vanity}` };
  }
  await humanClick(ctx, rowWithdraw);
  await gap(ctx);
  await humanClick(ctx, SELECTORS.confirmWithdrawButton);
  return { ok: true, detail: `invite withdrawn for ${vanity}` };
}

/** LinkedIn reaction types, keyed by the API enum; LIKE is the default. */
export type ReactionType =
  | 'LIKE' // Like
  | 'PRAISE' // Celebrate
  | 'EMPATHY' // Love
  | 'INTEREST' // Insightful
  | 'ENTERTAINMENT' // Funny
  | 'APPRECIATION'; // Support

const REACTION_SELECTOR: Record<ReactionType, string> = {
  LIKE: SELECTORS.reactionLike,
  PRAISE: SELECTORS.reactionCelebrate,
  EMPATHY: SELECTORS.reactionLove,
  INTEREST: SELECTORS.reactionInsightful,
  ENTERTAINMENT: SELECTORS.reactionFunny,
  APPRECIATION: SELECTORS.reactionSupport,
};

/**
 * React to a post. A single click on the trigger applies the default Like; any
 * other reaction needs the trigger hovered to open the flyout, then the option
 * clicked. Scoped to the first trigger, which is the main post (comments render
 * later in the DOM).
 */
export async function react(
  ctx: ActionContext,
  postUrl: string,
  reactionType: ReactionType = 'LIKE',
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(postUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  if (reactionType === 'LIKE') {
    await humanClick(ctx, SELECTORS.reactTrigger);
    return { ok: true, detail: 'reacted (LIKE)' };
  }
  // Non-Like: hover the trigger to open the reactions flyout, then pick.
  const trigger = ctx.page.locator(SELECTORS.reactTrigger).first();
  await trigger.waitFor({ state: 'visible' });
  await trigger.hover();
  await gap(ctx);
  await humanClick(ctx, REACTION_SELECTOR[reactionType]);
  return { ok: true, detail: `reacted (${reactionType})` };
}
