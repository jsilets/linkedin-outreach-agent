// The composer addresses a recipient by typing their name into LinkedIn's
// typeahead and clicking the matching card. FakePage cannot cover that: its
// nth() returns the same locator for every index, so every card shares one text
// and the picker can never choose wrongly. These tests use a page model that
// DOES discriminate per index, which is the only way to exercise the pick.

import type { Action } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import type { AllowToken, LocatorPort, PagePort } from '../ports.js';
import { SELECTORS } from '../selectors.js';
import { fixedRng, noSleep } from '../testing/fakes.js';
import type { ActionContext } from './actions.js';
import { message } from './index.js';

const NOW = 1_000_000;
const ACCOUNT_ID = 'acct-1';

interface Card {
  /** Visible card text, as LinkedIn renders it. */
  text: string;
  /** Profile links the thread renders once THIS card is opened. */
  threadHrefs: string[];
  /** URL the composer lands on after clicking THIS card (default: bare thread/new). */
  postClickUrl?: string;
}

/** Evaluate the a[href*=...] / a[href$=...] shapes the guard builds. */
function countHrefMatches(selector: string, hrefs: string[]): number {
  const tests = [...selector.matchAll(/href(\*|\$)="([^"]+)"/g)];
  if (tests.length === 0) return 1;
  let n = 0;
  for (const href of hrefs) {
    for (const [, op, val] of tests) {
      if (op === '*' ? href.includes(val!) : href.endsWith(val!)) n++;
    }
  }
  return n;
}

/** A page whose typeahead holds distinct cards and whose thread renders the
 * opened card's hrefs, so the picker and the identity guard are both real. */
class CardsPage implements PagePort {
  clickedCardIndex = -1;
  typedName = '';
  composed = '';
  sent = false;

  constructor(private readonly cards: Card[]) {}

  private get openHrefs(): string[] {
    return this.cards[this.clickedCardIndex]?.threadHrefs ?? [];
  }

  async goto(): Promise<unknown> {
    return null;
  }
  url(): string {
    return (
      this.cards[this.clickedCardIndex]?.postClickUrl ??
      'https://www.linkedin.com/messaging/thread/new/'
    );
  }
  async waitForTimeout(): Promise<void> {}
  async waitForResponse(): Promise<never> {
    throw new Error('unused');
  }
  async voyagerGet(): Promise<{ status: number; body: unknown }> {
    return { status: 200, body: {} };
  }
  async insertText(text: string): Promise<void> {
    this.composed += text;
  }
  async pressKey(key: string): Promise<void> {
    if (key === 'Enter') this.sent = true;
  }

  locator(selector: string): LocatorPort {
    const isCard = selector === SELECTORS.composerResultCard;
    const isField = selector === SELECTORS.composerRecipientField;
    const isAnchorProbe = selector.startsWith('a[href');
    const self = this;
    const at = (index: number): LocatorPort => ({
      async click() {
        if (isCard) self.clickedCardIndex = index;
      },
      async type(text: string) {
        if (isField) self.typedName += text;
      },
      async fill(text: string) {
        self.composed = text;
      },
      async textContent() {
        return isCard ? (self.cards[index]?.text ?? null) : null;
      },
      async getAttribute(name: string) {
        return isAnchorProbe && name === 'href' ? (self.openHrefs[index] ?? null) : null;
      },
      async count() {
        if (isCard) return self.cards.length;
        if (isAnchorProbe && selector === 'a[href*="/in/"]') return self.openHrefs.length;
        if (isAnchorProbe) return countHrefMatches(selector, self.openHrefs);
        return 1;
      },
      first: () => at(0),
      nth: (i: number) => at(i),
      async hover() {},
      async focus() {},
      async waitFor() {
        if (isCard && self.cards.length === 0) throw new Error('timeout');
        if (isAnchorProbe && countHrefMatches(selector, self.openHrefs) === 0) {
          throw new Error('timeout');
        }
      },
    });
    return at(0);
  }
}

function makeAction(): Action {
  return {
    id: 'action-1',
    type: 'message',
    scheduledAt: new Date(NOW),
    executedAt: null,
    result: 'pending',
    dedupKey: 'acct-1:target-1:message',
    accountId: ACCOUNT_ID,
    targetId: 'target-1',
    campaignId: 'camp-1',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function ctx(page: CardsPage): ActionContext {
  const action = makeAction();
  const token: AllowToken = {
    kind: 'allow',
    actionId: action.id,
    accountId: ACCOUNT_ID,
    expiresAt: NOW + 60_000,
    nonce: 'n1',
  };
  return {
    page,
    token,
    action,
    accountId: ACCOUNT_ID,
    sleep: noSleep,
    rng: fixedRng(),
    now: () => NOW,
  };
}

const card = (name: string, hrefs: string[]): Card => ({
  text: `Status is reachable ${name} • 1st Head of EV`,
  threadHrefs: hrefs,
});

describe('message(): truncated recipient names', () => {
  it('refuses a LinkedIn-truncated name without touching the typeahead', async () => {
    // "R S." is what LinkedIn shows for an out-of-network person. It is not a
    // name we can search, so the send must stop before it types anything.
    const page = new CardsPage([card('R Sandoval', ['https://www.linkedin.com/in/r-sandoval/'])]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/r-sandoval',
      recipientName: 'R S.',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/truncated stub/i);
    expect(page.typedName).toBe(''); // never addressed the composer
    expect(page.composed).toBe('');
    expect(page.sent).toBe(false);
  });

  it('never picks a stranger whose name merely contains the recipient name', async () => {
    // Guard the picker directly: "r s." is a substring of "peter s. nolan", so
    // a raw includes() would open a stranger's thread. Bypass the truncation
    // refusal by asserting the boundary rule on a short-but-untruncated name.
    const page = new CardsPage([
      card('Peter S Nolan', ['https://www.linkedin.com/in/peter-s-nolan/']),
      card('R S Sandoval', ['https://www.linkedin.com/in/r-sandoval/']),
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/r-sandoval',
      recipientName: 'R S Sandoval',
      body: 'Hi there',
    });
    expect(res.ok).toBe(true);
    expect(page.clickedCardIndex).toBe(1); // NOT Peter
  });

  it('still sends to a real full name (control)', async () => {
    const page = new CardsPage([
      card('Nadia Okonkwo', ['https://www.linkedin.com/in/nadia-okonkwo/']),
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/nadia-okonkwo',
      recipientName: 'Nadia Okonkwo',
      body: 'Hi there',
    });
    expect(res.ok).toBe(true);
    expect(page.sent).toBe(true);
  });

  it('strips a credential suffix rather than treating it as truncation', async () => {
    const page = new CardsPage([
      card('Priya Raman', ['https://www.linkedin.com/in/priya-raman/']),
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/priya-raman',
      recipientName: 'Priya Raman, P.Eng.',
      body: 'Hi there',
    });
    expect(res.ok).toBe(true);
    expect(page.typedName).toBe('Priya Raman');
  });
});

describe('message(): refusal diagnostics', () => {
  it('quotes the profile hrefs the page actually offered when the guard refuses', async () => {
    // The thread opened, but its anchor carries a query string, so the guard's
    // /in/<id>/ and /in/<id>$ forms both miss. The refusal must report what it
    // saw — otherwise the next reader can only guess at the href format.
    const page = new CardsPage([
      card('A.J. Whitfield', [
        'https://www.linkedin.com/in/a-j-whitfield-1234?miniProfileUrn=urn%3Ali%3Afsd_profile%3AACoAAExample1',
      ]),
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/a-j-whitfield-1234',
      recipientName: 'A.J. Whitfield',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('miniProfileUrn'); // the real href is in the detail
    expect(res.detail).toMatch(/wanted .*a-j-whitfield-1234/);
    expect(page.sent).toBe(false);
  });

  it('says so plainly when the page offered no profile links at all', async () => {
    const page = new CardsPage([card('Jane Doe', [])]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/jane',
      recipientName: 'Jane Doe',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('no /in/ links');
  });
});

describe('message(): 1st-degree gate and post-click URL identity', () => {
  it('refuses when the only name-matching card is not 1st-degree', async () => {
    const page = new CardsPage([
      { text: 'Status is reachable Jane Doe • 3rd+ Head of EV', threadHrefs: [] },
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/jane',
      recipientName: 'Jane Doe',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no 1st-degree typeahead card matched/);
    expect(res.detail).toContain('jane doe • 3rd+'); // the offered card is in the diagnostic
    expect(page.composed).toBe(''); // never typed a message
    expect(page.sent).toBe(false);
  });

  it('refuses the live Dana Fairbourn near-miss: a 3rd+ near-namesake InMail card', async () => {
    // Live 2026-07-15: searching "Dana Fairbourn" (1st) offered only "Dana
    // Fairbourne" (3rd+, one extra letter), whose click opens a Premium InMail
    // compose to the WRONG person. The 1st-degree gate must stop it before the click.
    const page = new CardsPage([
      {
        text: 'Status is offline Dana Fairbourne • 3rd+ Senior Customer Systems Engineer',
        threadHrefs: [],
        postClickUrl:
          'https://www.linkedin.com/messaging/thread/new/?composeOptionType=PREMIUM_INMAIL&recipients=List(urn%3Ali%3Afsd_profile%3AACoAAStranger)',
      },
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/dana-fairbourn',
      recipientName: 'Dana Fairbourn',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no 1st-degree typeahead card matched/);
    expect(page.composed).toBe('');
    expect(page.sent).toBe(false);
  });

  it('refuses when a 1st-degree-labelled card still lands on an InMail/upsell URL', async () => {
    const page = new CardsPage([
      {
        text: 'Status is offline Dana Fairbourn • 1st Senior Customer Systems Engineer',
        threadHrefs: [],
        postClickUrl:
          'https://www.linkedin.com/messaging/thread/new/?composeOptionType=PREMIUM_INMAIL&recipients=List(urn%3Ali%3Afsd_profile%3AACoAAStranger)',
      },
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/dana-fairbourn',
      recipientName: 'Dana Fairbourn',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/InMail\/upsell/);
    expect(page.composed).toBe('');
    expect(page.sent).toBe(false);
  });

  it('refuses when the composer URL names a different recipient urn', async () => {
    const page = new CardsPage([
      {
        text: 'Status is reachable Jane Doe • 1st Head of EV',
        threadHrefs: [],
        postClickUrl:
          'https://www.linkedin.com/messaging/thread/new/?isTYAHFlow=true&recipients=List(urn%3Ali%3Afsd_profile%3AWRONGID)',
      },
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/jane',
      recipientName: 'Jane Doe',
      memberId: 'RIGHTID',
      body: 'Hi there',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/DIFFERENT person/);
    expect(page.composed).toBe('');
    expect(page.sent).toBe(false);
  });

  it('sends a new conversation on URL identity alone (no recipient anchor anywhere)', async () => {
    // New-conversation flow: no history, so the thread pane renders no profile
    // card. The recipient urn in the URL is the identity proof.
    const page = new CardsPage([
      {
        text: 'Status is reachable Jane Doe • 1st Head of EV',
        threadHrefs: [],
        postClickUrl:
          'https://www.linkedin.com/messaging/thread/new/?isTYAHFlow=true&recipients=List(urn%3Ali%3Afsd_profile%3ARIGHTID)',
      },
    ]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/jane',
      recipientName: 'Jane Doe',
      memberId: 'RIGHTID',
      body: 'Hi there',
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/url-verified/);
    expect(page.sent).toBe(true);
  });

  it('still sends anchor-verified when the URL carries no recipient urn (control)', async () => {
    const page = new CardsPage([card('Jane Doe', ['https://www.linkedin.com/in/jane/'])]);
    const res = await message(ctx(page), {
      profileUrl: 'https://www.linkedin.com/in/jane',
      recipientName: 'Jane Doe',
      body: 'Hi there',
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/anchor-verified/);
    expect(page.sent).toBe(true);
  });
});
