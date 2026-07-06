// Human-like DOM actions. Each is a small async function that takes a PagePort
// plus params, asserts the allow token first, then drives the centralized
// selectors with human typing/click delays and randomized between-step gaps.

import type { Action } from '@loa/shared';
import type { AllowToken, LocatorPort, PagePort } from '../ports.js';
import { SELECTORS } from '../selectors.js';
import {
  actionGapMs,
  clickDelayMs,
  realSleep,
  typingDelayMs,
  type Sleeper,
} from '../human.js';
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
  await loc.click();
  await loc.type(text, { delay: typingDelayMs(ctx.rng) });
}

/** True if at least one element matches; lets connect() branch without throwing. */
async function isPresent(ctx: ActionContext, selector: string): Promise<boolean> {
  return (await ctx.page.locator(selector).count()) > 0;
}

/**
 * Open the profile's "More" overflow menu that holds Connect. The selector can
 * match several "More" buttons (profile card vs. an activity post), so try each
 * candidate and keep the one whose menu actually exposes a Connect entry rather
 * than blindly clicking the first. Throws if none do.
 */
async function openConnectMenu(ctx: ActionContext): Promise<void> {
  const candidates: LocatorPort = ctx.page.locator(SELECTORS.moreActionsButton);
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    await clickLoc(ctx, candidates.nth(i));
    await gap(ctx);
    if (await isPresent(ctx, SELECTORS.connectInMenu)) return;
  }
  throw new Error('connect: no "More" menu exposed a Connect entry');
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
  await loc.waitFor({ state: 'visible' });
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
  // Two ways in: a top-level Connect button, or — on Follow-by-default
  // profiles that hide it — the "More" overflow menu holding Connect. Probe
  // for the direct button first and fall back to the menu.
  let via: 'direct' | 'more-menu';
  if (await isPresent(ctx, SELECTORS.connectButton)) {
    via = 'direct';
    await humanClick(ctx, SELECTORS.connectButton);
  } else {
    via = 'more-menu';
    await openConnectMenu(ctx);
    await humanClick(ctx, SELECTORS.connectInMenu);
  }
  await gap(ctx);
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

/** Send a direct message in an open/available conversation. */
export async function message(
  ctx: ActionContext,
  params: { profileUrl: string; body: string },
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(params.profileUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  await humanClick(ctx, SELECTORS.messageButton);
  await humanType(ctx, SELECTORS.messageComposeBox, params.body);
  await gap(ctx);
  await humanClick(ctx, SELECTORS.messageSendButton);
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
export async function follow(
  ctx: ActionContext,
  profileUrl: string,
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  await humanClick(ctx, SELECTORS.followButton);
  return { ok: true, detail: 'followed' };
}

const SENT_INVITATIONS_URL =
  'https://www.linkedin.com/mynetwork/invitation-manager/sent/';

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
