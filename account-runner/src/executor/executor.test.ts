import { describe, it, expect } from 'vitest';
import type { Action } from '@loa/shared';
import type { AllowToken } from '../ports.js';
import { SELECTORS } from '../selectors.js';
import { FakePage, noSleep, fixedRng } from '../testing/fakes.js';
import {
  connect,
  message,
  follow,
  react,
  readInbox,
  withdrawInvite,
  NotAllowedError,
  checkToken,
} from './index.js';
import type { ActionContext } from './actions.js';

const ACCOUNT_ID = 'acct-1';
const NOW = 1_000_000;

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'action-1',
    type: 'connect',
    scheduledAt: new Date(NOW),
    executedAt: null,
    result: 'pending',
    dedupKey: 'acct-1:target-1:connect',
    accountId: ACCOUNT_ID,
    targetId: 'target-1',
    campaignId: 'camp-1',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function validToken(action: Action): AllowToken {
  return {
    kind: 'allow',
    actionId: action.id,
    accountId: ACCOUNT_ID,
    expiresAt: NOW + 60_000,
    nonce: 'n1',
  };
}

function ctx(page: FakePage, action: Action, token: AllowToken | null): ActionContext {
  return {
    page,
    // deliberately allow null through so the guard is exercised
    token: token as AllowToken,
    action,
    accountId: ACCOUNT_ID,
    sleep: noSleep,
    rng: fixedRng(),
    now: () => NOW,
  };
}

describe('allow-token gate', () => {
  it('checkToken accepts a matching, unexpired allow token', () => {
    const action = makeAction();
    expect(checkToken(validToken(action), action, ACCOUNT_ID, NOW)).toBeNull();
  });

  it('rejects a missing token', () => {
    const action = makeAction();
    expect(checkToken(null, action, ACCOUNT_ID, NOW)).toBe('missing');
  });

  it('rejects a token for the wrong action', () => {
    const action = makeAction();
    const t = { ...validToken(action), actionId: 'other' };
    expect(checkToken(t, action, ACCOUNT_ID, NOW)).toBe('wrong_action');
  });

  it('rejects a token for the wrong account', () => {
    const action = makeAction();
    const t = { ...validToken(action), accountId: 'other' };
    expect(checkToken(t, action, ACCOUNT_ID, NOW)).toBe('wrong_account');
  });

  it('rejects an expired token', () => {
    const action = makeAction();
    const t = { ...validToken(action), expiresAt: NOW - 1 };
    expect(checkToken(t, action, ACCOUNT_ID, NOW)).toBe('expired');
  });
});

describe('executor refuses without an allow', () => {
  it('connect throws NotAllowedError and never touches the page', async () => {
    const page = new FakePage();
    const action = makeAction();
    await expect(
      connect(ctx(page, action, null), { profileUrl: 'https://x/in/p' }),
    ).rejects.toBeInstanceOf(NotAllowedError);
    // no navigation, no clicks happened
    expect(page.gotos).toHaveLength(0);
    expect(page.clicked(SELECTORS.connectButton)).toBe(false);
  });

  it('message throws when the token is expired', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'message' });
    const expired: AllowToken = { ...validToken(action), expiresAt: NOW - 1 };
    await expect(
      message(ctx(page, action, expired), { profileUrl: 'https://x', body: 'hi' }),
    ).rejects.toBeInstanceOf(NotAllowedError);
    expect(page.gotos).toHaveLength(0);
  });
});

describe('executor acts when allowed', () => {
  it('connect with a note drives the centralized selectors', async () => {
    const page = new FakePage({
      counts: {
        [SELECTORS.inviteErrorToast]: 0,
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.emailRequiredModal]: 0,
      },
    });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/jane/',
      note: 'Hi Jane, great to connect.',
    });
    expect(res.ok).toBe(true);
    expect(page.gotos).toContain('https://www.linkedin.com/in/jane/');
    expect(page.clicked(SELECTORS.connectButton)).toBe(true);
    expect(page.clicked(SELECTORS.addNoteButton)).toBe(true);
    expect(page.typedInto(SELECTORS.noteTextarea)).toContain('Hi Jane, great to connect.');
    expect(page.clicked(SELECTORS.sendInviteButton)).toBe(true);
  });

  it('connect without a note skips the note selectors', async () => {
    const page = new FakePage({
      counts: {
        [SELECTORS.inviteErrorToast]: 0,
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.emailRequiredModal]: 0,
      },
    });
    const action = makeAction();
    await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/bob/',
    });
    expect(page.clicked(SELECTORS.connectButton)).toBe(true);
    expect(page.clicked(SELECTORS.addNoteButton)).toBe(false);
  });

  it('connect falls back to the More menu when no top-level Connect button', async () => {
    // Follow-by-default profile: the direct Connect button is absent, so the
    // executor must open "More" and click Connect from the dropdown.
    const page = new FakePage({
      counts: {
        [SELECTORS.connectButton]: 0,
        [SELECTORS.inviteErrorToast]: 0,
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.pendingInMenu]: 0,
        [SELECTORS.emailRequiredModal]: 0,
      },
    });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/carol/',
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('more-menu');
    expect(page.clicked(SELECTORS.connectButton)).toBe(false);
    expect(page.clicked(SELECTORS.moreActionsButton)).toBe(true);
    expect(page.clicked(SELECTORS.connectInMenu)).toBe(true);
    // Note-less send must go through "Send without a note", never a generic Send.
    expect(page.clicked(SELECTORS.sendWithoutNoteButton)).toBe(true);
    expect(page.clicked(SELECTORS.sendInviteButton)).toBe(false);
  });

  it('connect reports ok:false when LinkedIn refuses the invite', async () => {
    // The send click succeeds but LinkedIn shows an error toast ("invitation
    // not sent"). connect() must report failure, not a false success.
    const page = new FakePage({
      counts: {
        [SELECTORS.inviteErrorToast]: 1,
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.emailRequiredModal]: 0,
      },
    });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/erin/',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('refused by LinkedIn');
  });

  it('connect flags email-gated invites instead of hanging or false-success', async () => {
    // Some members require the recipient's email before LinkedIn will send. The
    // invite modal shows an email input; connect() must flag it (ok:false,
    // "needs recipient email") rather than time out on a Send that never enables
    // or report a false success.
    const page = new FakePage({
      counts: {
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.emailRequiredModal]: 1,
      },
    });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/heidi/',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/email/i);
    // It must not have sent anything.
    expect(page.clicked(SELECTORS.sendWithoutNoteButton)).toBe(false);
    expect(page.clicked(SELECTORS.sendInviteButton)).toBe(false);
  });

  it('connect stops without inviting when the profile is already pending', async () => {
    // The action bar shows "Pending" instead of Connect. connect() must detect
    // it up front and never click a Connect (which, on such a profile, would be
    // a recommendation card in the sidebar).
    const page = new FakePage({ counts: { [SELECTORS.pendingIndicator]: 1 } });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/frank/',
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('already pending');
    expect(page.clicked(SELECTORS.connectButton)).toBe(false);
    expect(page.clicked(SELECTORS.connectInMenu)).toBe(false);
    expect(page.clicked(SELECTORS.sendWithoutNoteButton)).toBe(false);
  });

  it('connect detects a pending invite inside the More menu', async () => {
    // No top-level Connect; opening More reveals "Pending", not Connect.
    const page = new FakePage({
      counts: {
        [SELECTORS.connectButton]: 0,
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.pendingInMenu]: 1,
      },
    });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/grace/',
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('already pending');
    expect(page.clicked(SELECTORS.moreActionsButton)).toBe(true);
    expect(page.clicked(SELECTORS.connectInMenu)).toBe(false);
  });

  it('connect skips cleanly (ok:false) when no Connect exists inline or in the More menu', async () => {
    // Follow-by-default / Follow-only: no direct Connect button and the More
    // menu never reveals connectInMenu. connect() must skip with ok:false rather
    // than throw or click a wrong menu item, so a run continues past it.
    const page = new FakePage({
      counts: {
        [SELECTORS.connectButton]: 0,
        [SELECTORS.moreActionsButton]: 2,
        [SELECTORS.connectInMenu]: 0,
        [SELECTORS.pendingIndicator]: 0,
        [SELECTORS.pendingInMenu]: 0,
      },
    });
    const action = makeAction();
    const res = await connect(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/dave/',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/Follow-by-default|no invite sent/i);
    expect(page.clicked(SELECTORS.sendInviteButton)).toBe(false);
    expect(page.clicked(SELECTORS.connectInMenu)).toBe(false);
  });

  it('message types into the compose box and sends', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'message' });
    await message(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/in/jane/',
      body: 'Thanks for connecting!',
    });
    expect(page.typedInto(SELECTORS.messageComposeBox)).toContain('Thanks for connecting!');
    expect(page.clicked(SELECTORS.messageSendButton)).toBe(true);
  });

  it('react LIKE single-clicks the trigger, no flyout', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'react' });
    const res = await react(
      ctx(page, action, validToken(action)),
      'https://www.linkedin.com/feed/update/urn:li:activity:123/',
    );
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('LIKE');
    expect(page.clicked(SELECTORS.reactTrigger)).toBe(true);
    expect(page.clicked(SELECTORS.reactionCelebrate)).toBe(false);
  });

  it('react PRAISE hovers the trigger then clicks the Celebrate option', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'react' });
    const res = await react(
      ctx(page, action, validToken(action)),
      'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      'PRAISE',
    );
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('PRAISE');
    expect(page.clicked(SELECTORS.reactionCelebrate)).toBe(true);
  });

  it('follow clicks the follow button', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'follow' });
    await follow(ctx(page, action, validToken(action)), 'https://x/in/p');
    expect(page.clicked(SELECTORS.followButton)).toBe(true);
  });

  it('readInbox returns the conversation count', async () => {
    const page = new FakePage({ counts: { [SELECTORS.inboxConversationRow]: 4 } });
    const action = makeAction({ type: 'message' });
    const res = await readInbox(ctx(page, action, validToken(action)));
    expect(res.count).toBe(4);
  });
});

describe('withdrawInvite targets a specific pending invite', () => {
  const vanity = 'jane-doe-123';
  const profileUrl = `https://www.linkedin.com/in/${vanity}/`;
  // Must mirror withdrawButtonForVanity() exactly.
  const rowSel =
    `li:has(a[href*="/in/${vanity}"]) ${SELECTORS.withdrawInviteButton}, ` +
    `div[class*="invitation-card"]:has(a[href*="/in/${vanity}"]) ${SELECTORS.withdrawInviteButton}`;
  const SENT = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';

  it('refuses without an allow token and never navigates', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'withdraw_invite' });
    await expect(
      withdrawInvite(ctx(page, action, null), { profileUrl }),
    ).rejects.toBeInstanceOf(NotAllowedError);
    expect(page.gotos).toHaveLength(0);
  });

  it('returns ok:false for a URL with no /in/ vanity and never navigates', async () => {
    const page = new FakePage();
    const action = makeAction({ type: 'withdraw_invite' });
    const res = await withdrawInvite(ctx(page, action, validToken(action)), {
      profileUrl: 'https://www.linkedin.com/company/acme/',
    });
    expect(res.ok).toBe(false);
    expect(page.gotos).toHaveLength(0);
  });

  it('returns ok:false without confirming when no matching row exists', async () => {
    const page = new FakePage({ counts: { [rowSel]: 0 } });
    const action = makeAction({ type: 'withdraw_invite' });
    const res = await withdrawInvite(ctx(page, action, validToken(action)), { profileUrl });
    expect(res.ok).toBe(false);
    expect(page.gotos).toContain(SENT);
    expect(page.clicked(SELECTORS.confirmWithdrawButton)).toBe(false);
  });

  it('clicks the targeted row withdraw then the confirm dialog', async () => {
    const page = new FakePage({ counts: { [rowSel]: 1 } });
    const action = makeAction({ type: 'withdraw_invite' });
    const res = await withdrawInvite(ctx(page, action, validToken(action)), { profileUrl });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain(vanity);
    expect(page.clicked(rowSel)).toBe(true);
    expect(page.clicked(SELECTORS.confirmWithdrawButton)).toBe(true);
  });
});
