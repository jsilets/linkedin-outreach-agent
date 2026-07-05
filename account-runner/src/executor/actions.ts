// Human-like DOM actions. Each is a small async function that takes a PagePort
// plus params, asserts the allow token first, then drives the centralized
// selectors with human typing/click delays and randomized between-step gaps.

import type { Action } from '@loa/shared';
import type { AllowToken, PagePort } from '../ports.js';
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

async function humanClick(ctx: ActionContext, selector: string): Promise<void> {
  const loc = ctx.page.locator(selector);
  await loc.waitFor({ state: 'visible' });
  await loc.hover();
  const sleep = ctx.sleep ?? realSleep;
  await sleep(clickDelayMs(ctx.rng));
  await loc.click({ delay: clickDelayMs(ctx.rng) });
}

async function humanType(ctx: ActionContext, selector: string, text: string): Promise<void> {
  const loc = ctx.page.locator(selector);
  await loc.waitFor({ state: 'visible' });
  await loc.click();
  await loc.type(text, { delay: typingDelayMs(ctx.rng) });
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
  await humanClick(ctx, SELECTORS.connectButton);
  if (params.note && params.note.length > 0) {
    await humanClick(ctx, SELECTORS.addNoteButton);
    await humanType(ctx, SELECTORS.noteTextarea, params.note);
  }
  await gap(ctx);
  await humanClick(ctx, SELECTORS.sendInviteButton);
  return { ok: true, detail: params.note ? 'invited with note' : 'invited' };
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
    const text = await bubbles.textContent();
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

/** Withdraw a previously sent invite from the sent-invitations manager. */
export async function withdrawInvite(
  ctx: ActionContext,
  manageUrl: string,
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(manageUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  await humanClick(ctx, SELECTORS.withdrawInviteButton);
  await humanClick(ctx, SELECTORS.confirmWithdrawButton);
  return { ok: true, detail: 'invite withdrawn' };
}

/** React to a post/profile activity. */
export async function react(
  ctx: ActionContext,
  postUrl: string,
): Promise<ActionResultOut> {
  guard(ctx);
  await ctx.page.goto(postUrl, { waitUntil: 'domcontentloaded' });
  await gap(ctx);
  await humanClick(ctx, SELECTORS.reactButton);
  return { ok: true, detail: 'reacted' };
}
