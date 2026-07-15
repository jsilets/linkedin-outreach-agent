// Human-like DOM actions. Each is a small async function that takes a PagePort
// plus params, asserts the allow token first, then drives the centralized
// selectors with human typing/click delays and randomized between-step gaps.

import type { Action } from '@loa/shared';
import { isTruncatedName } from '@loa/shared';
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

// The recipient composer opens on a dedicated, lightweight surface. Bounds:
// field appears after the messaging app hydrates; result cards a beat after
// typing; the thread (with its recipient anchor) a beat after selecting a card.
const COMPOSER_FIELD_TIMEOUT_MS = 15000;
const TYPEAHEAD_RESULT_TIMEOUT_MS = 8000;
const THREAD_OPEN_TIMEOUT_MS = 10000;
// Per-key delay while typing the recipient name: the typeahead fires on
// keystroke input events, so this must be a real character-by-character type
// (a paste-like insert does not populate suggestions).
const TYPEAHEAD_KEY_DELAY_MS = 70;

/** How many profile links a refusal will quote, and how much of each. Enough to
 * identify the href format; bounded so a failure detail stays a line, not a dump. */
const DIAG_HREF_LIMIT = 5;
const DIAG_HREF_MAX_LEN = 120;

/**
 * The /in/ profile links actually present on the page, for a refusal detail.
 *
 * The wrong-recipient guard can only say which id it wanted; without this, every
 * refusal is a hypothesis about what the page rendered — a query-string href, a
 * member-id href, or genuinely nothing. Quoting what we saw makes the next
 * failure self-diagnosing. Best-effort: a diagnostic must never turn a clean
 * refusal into a throw.
 */
async function profileHrefsOnPage(ctx: ActionContext): Promise<string[]> {
  try {
    const links = ctx.page.locator('a[href*="/in/"]');
    const n = Math.min(await links.count(), DIAG_HREF_LIMIT);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const href = await links.nth(i).getAttribute('href');
      if (href) out.push(href.slice(0, DIAG_HREF_MAX_LEN));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Whether `text` contains `wanted` starting at a word boundary.
 *
 * A raw substring test is wrong here: the typeahead card text is matched against
 * the recipient's name, and a short name substring-matches a stranger — "r s."
 * is inside "pete(r s.)johnson". Requiring the match to begin at a non-letter (or
 * at the start) keeps "r sandoval" matching its own card while refusing to see a
 * recipient inside someone else's surname. Both sides arrive lowercased.
 */
function containsNameAtWordBoundary(text: string, wanted: string): boolean {
  if (!wanted) return false;
  let from = 0;
  for (;;) {
    const i = text.indexOf(wanted, from);
    if (i === -1) return false;
    const before = i === 0 ? '' : text[i - 1]!;
    if (!/[a-z]/.test(before)) return true;
    from = i + 1;
  }
}

/** Build a selector that scopes `inner` to whichever thread container provably
 * links to the recipient (`:has(anchor)`), across every container/inner OR-part.
 * This keeps the compose box + Send bound to the ONE thread for this recipient,
 * so a stray minimized overlay for someone else can never receive the send. */
function scopeToThread(container: string, anchor: string, inner: string): string {
  const parts: string[] = [];
  for (const c of container.split(',').map((s) => s.trim())) {
    for (const i of inner.split(',').map((s) => s.trim())) {
      parts.push(`${c}:has(${anchor}) ${i}`);
    }
  }
  return parts.join(', ');
}

/**
 * Send a direct message to `recipientName` at `profileUrl`.
 *
 * Sends through the dedicated new-message composer (thread/new) + recipient
 * typeahead, NOT the profile page. The profile-page Message button hydrates
 * after `domcontentloaded`, so clicking it immediately races the render — the
 * source of both the "Message button timeout" and half-hydrated wrong-recipient
 * refusals seen in production. The composer is a stable surface.
 *
 * SAFETY: the typeahead cards carry no stable id, so the picked card is a
 * best-effort name match; the REAL guard is the post-select identity check — the
 * opened thread must link to THIS recipient's /in/ profile (their vanity or the
 * opaque member id from the urn). If it does not, we REFUSE (ok:false) rather
 * than risk messaging the wrong person. Compose box + Send are then scoped to
 * that verified thread, and the box is cleared before typing.
 */
export async function message(
  ctx: ActionContext,
  params: { profileUrl: string; recipientName: string; body: string; memberId?: string },
): Promise<ActionResultOut> {
  guard(ctx);
  const publicId = publicIdFromProfileUrl(params.profileUrl);
  if (!publicId) {
    return {
      ok: false,
      detail: `no /in/ id in ${params.profileUrl}; refusing to send (cannot verify recipient)`,
    };
  }
  const name = params.recipientName?.trim();
  if (!name) {
    return {
      ok: false,
      detail: 'no recipient name; refusing to send (cannot address the composer)',
    };
  }
  // A name LinkedIn truncated for a stranger ("R S.") is not a name we can
  // search. Typing it finds nobody, and it is short enough to substring-match a
  // stranger's card ("R S." is inside "Peter S. Johnson"), which would put us one
  // failed identity check away from messaging the wrong person. Refuse before
  // touching the typeahead. The name should have been refreshed from the
  // 1st-degree connections payload at acceptance; if we are here, it was not.
  if (isTruncatedName(name)) {
    return {
      ok: false,
      detail:
        `recipient name "${name}" is a LinkedIn-truncated stub, not a real name; ` +
        'refusing to send (needs a name refresh from the accepted connection)',
    };
  }

  // Drop a trailing credential suffix ("Priya Raman, P.Eng." -> "Priya
  // Raman"): LinkedIn's typeahead search and result cards use the plain name,
  // so the suffix breaks both the query and the card match.
  const searchName = (name.split(',')[0] ?? name).trim() || name;

  // 1. Open the composer and address it via the recipient typeahead.
  await ctx.page.goto('https://www.linkedin.com/messaging/thread/new/', {
    waitUntil: 'domcontentloaded',
  });
  await gap(ctx);
  const field = ctx.page.locator(SELECTORS.composerRecipientField).first();
  try {
    await field.waitFor({ state: 'visible', timeout: COMPOSER_FIELD_TIMEOUT_MS });
  } catch {
    return { ok: false, detail: 'message composer recipient field did not open' };
  }
  await field.click();
  await field.type(searchName, { delay: TYPEAHEAD_KEY_DELAY_MS });
  await gap(ctx);

  // 2. Pick the suggestion card that matches the recipient's name (case-
  //    insensitive) AND is 1st-degree. A message send is only possible to a
  //    1st-degree connection, and the typeahead happily lists near-identical
  //    strangers ("Dana Fairbourne • 3rd+" for "Dana Fairbourn") — clicking one
  //    opens a Premium InMail compose to the WRONG person. Verified live
  //    2026-07-15. No non-1st fallback, ever.
  const cards = ctx.page.locator(SELECTORS.composerResultCard);
  try {
    await cards.first().waitFor({ state: 'visible', timeout: TYPEAHEAD_RESULT_TIMEOUT_MS });
  } catch {
    return { ok: false, detail: `no typeahead result for "${searchName}"; refusing to send` };
  }
  const count = await cards.count();
  const wanted = searchName.toLowerCase();
  const cardTexts: string[] = [];
  let picked = -1;
  for (let i = 0; i < count; i++) {
    const text = ((await cards.nth(i).textContent()) ?? '').toLowerCase();
    cardTexts.push(text.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (picked !== -1) continue;
    if (!containsNameAtWordBoundary(text, wanted)) continue;
    if (/•\s*1st\b/.test(text) || /\b1st\b/.test(text)) picked = i;
  }
  // What the typeahead offered and what we did with it — so a refusal (or a
  // later mis-send report) is self-diagnosing instead of a guessing game.
  const cardsDiag = () =>
    `typeahead offered ${count} card(s): ${cardTexts.map((t, i) => `#${i}"${t}"`).join(' ')}`;
  if (picked === -1) {
    return {
      ok: false,
      detail: `no 1st-degree typeahead card matched "${searchName}"; refusing to send (${cardsDiag()})`,
    };
  }
  await clickLoc(ctx, cards.nth(picked));
  await gap(ctx);

  // 2b. URL identity check. In the NEW-conversation flow LinkedIn puts the
  //     selected recipient's profile urn in the composer URL
  //     (?recipients=List(urn:li:fsd_profile:<id>)) — an identity signal
  //     stronger than any DOM heuristic. When present it must match this
  //     target; when it names an InMail/upsell surface the pick was not a
  //     messageable 1st-degree and we refuse. An EXISTING conversation keeps
  //     a bare thread/new URL, so absence of the param proves nothing.
  const postClickUrl = ctx.page.url();
  const urlRecipient = decodeURIComponent(postClickUrl).match(
    /recipients=List\(urn:li:fsd_profile:([A-Za-z0-9_-]+)\)/,
  )?.[1];
  if (/composeOptionType=PREMIUM_INMAIL|premiumUpsellSlotUrn/i.test(postClickUrl)) {
    return {
      ok: false,
      detail:
        `composer opened an InMail/upsell surface for "${searchName}" — the picked card is ` +
        `not a messageable 1st-degree connection; refusing to send (picked #${picked}; ${cardsDiag()})`,
    };
  }
  const memberId = params.memberId?.trim();
  if (urlRecipient && memberId && urlRecipient !== memberId) {
    return {
      ok: false,
      detail:
        `composer URL names recipient urn ${urlRecipient} but this target is ${memberId} — ` +
        `the typeahead picked a DIFFERENT person; refusing to send (picked #${picked}; ${cardsDiag()})`,
    };
  }
  const urlVerified = Boolean(urlRecipient && memberId && urlRecipient === memberId);

  // 3. WRONG-RECIPIENT GUARD (existing-conversation flow). The opened thread's
  //    top profile card links to the recipient's /in/ profile; require it to
  //    match THIS target (vanity, or the opaque member id from the urn) before
  //    typing a word. Match the anchor with or without a trailing slash so it
  //    cannot match a longer id. The card only renders when the viewport is
  //    tall enough (see the launch-config viewport comment) — if this refuses
  //    with "no recipient link", check the viewport before anything else.
  //    Skipped when the URL already proved the recipient (new-conversation
  //    flow, which renders no history and thus no profile card).
  const anchor =
    `a[href*="/in/${publicId}/"], a[href$="/in/${publicId}"]` +
    (memberId ? `, a[href*="/in/${memberId}/"], a[href$="/in/${memberId}"]` : '');
  if (!urlVerified) {
    try {
      await ctx.page.locator(anchor).first().waitFor({
        state: 'visible',
        timeout: THREAD_OPEN_TIMEOUT_MS,
      });
    } catch {
      // Timed out — fall through to the count gate, which returns the refusal.
    }
    if (!(await isPresent(ctx, anchor))) {
      const saw = await profileHrefsOnPage(ctx);
      return {
        ok: false,
        detail:
          `composer did not open a thread for /in/${publicId}; refusing to send to avoid a ` +
          `wrong recipient (wanted ${memberId ? `/in/${publicId} or /in/${memberId}` : `/in/${publicId}`}; ` +
          `page offered ${saw.length ? saw.join(' ') : 'no /in/ links'}; ` +
          `picked #${picked}; ${cardsDiag()}; url ${postClickUrl.slice(0, 160)})`,
      };
    }
  }

  // 4. Compose + send, scoped to the verified thread. humanType clears the box
  //    first; the Send button activates via focus+Enter (off-viewport safe).
  //    URL-verified new conversations have no recipient anchor to scope with;
  //    there the compose surface is the page's single main pane.
  const container = SELECTORS.messageThreadContainer;
  const scope = (inner: string): string =>
    urlVerified
      ? inner
          .split(',')
          .map((s) => `main ${s.trim()}`)
          .join(', ')
      : scopeToThread(container, anchor, inner);
  await humanType(ctx, scope(SELECTORS.messageComposeBox), params.body);
  await gap(ctx);
  await pressButton(ctx, scope(SELECTORS.messageSendButton));
  return {
    ok: true,
    detail: `message sent (composer, ${urlVerified ? 'url' : 'anchor'}-verified)`,
  };
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
