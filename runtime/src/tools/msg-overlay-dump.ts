// Read-only DOM capture of LinkedIn's message-compose OVERLAY, to build selectors
// that scope the compose box + send button to the INTENDED recipient's overlay
// (LinkedIn keeps multiple chat overlays open; a bare .first() can hit the wrong
// one — the wrong-recipient bug). Clicks "Message" but NEVER types or sends.
//
//   LOA_PROFILE_DIR=... npm run -w runtime msg-overlay-dump -- <accountId> <profileUrl>

import { join } from 'node:path';
import { chromium } from 'patchright';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const accountId = process.argv[2];
  const profileUrl = process.argv[3];
  if (!accountId || !profileUrl) {
    console.error('usage: msg-overlay-dump <accountId> <profileUrl>');
    process.exit(2);
  }
  const config = loadConfig();
  const userDataDir = join(config.profileDir, accountId);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    // List ALL message-button candidates first (to see "Message" vs "Message
    // with Premium"), then click a PLAIN one (no "Premium") and report whether
    // the box comes up empty — testing whether the Premium button is what
    // prefills the AI icebreaker.
    const msgSel =
      'main button[aria-label^="Message"], main a[aria-label^="Message"], main button:has-text("Message")';
    const cands = page.locator(msgSel);
    const n = await cands.count();
    console.log('[dump] message button count:', n);
    const arias: string[] = [];
    for (let i = 0; i < n; i++)
      arias.push(
        (await cands
          .nth(i)
          .getAttribute('aria-label')
          .catch(() => null)) ?? '(none)',
      );
    console.log('[dump] message button arias:', JSON.stringify(arias));
    const boxSel = 'div[contenteditable="true"]';
    // Prefer a plain "Message" (exactly, or without "Premium"); fall back to first.
    // Click the TARGET's own button: exact "Message" or "Message with Premium"
    // (the sidebar people-also-viewed buttons carry another person's name).
    let picked = -1;
    for (let i = 0; i < n; i++) {
      const a = arias[i] ?? '';
      if (/^message$/i.test(a) || /^message with premium$/i.test(a)) {
        picked = i;
        break;
      }
    }
    if (picked === -1) picked = 0;
    console.log(`[dump] clicking candidate ${picked} (aria="${arias[picked]}")`);
    await cands
      .nth(picked)
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await cands
      .nth(picked)
      .click()
      .catch((e) => console.log('[dump] click failed:', String(e)));
    await page.waitForTimeout(4000);
    const boxes = page.locator(boxSel);
    if ((await boxes.count()) > 0) {
      const txt =
        (await boxes
          .first()
          .textContent()
          .catch(() => '')) ?? '';
      console.log(
        `[dump] compose box text after plain click: "${txt.replace(/\s+/g, ' ').trim().slice(0, 80)}" (len ${txt.length})`,
      );
    } else {
      console.log('[dump] no compose box after plain click');
    }
    console.log('[dump] url after clicks:', page.url());

    // Enumerate via Playwright locators (they pierce shadow DOM, which the
    // compose overlay uses — page.evaluate/querySelectorAll cannot see it).
    async function listAria(sel: string, label: string): Promise<void> {
      const loc = page.locator(sel);
      const c = await loc.count();
      const out: Array<Record<string, string | null>> = [];
      for (let i = 0; i < Math.min(c, 12); i++) {
        const el = loc.nth(i);
        out.push({
          aria: await el.getAttribute('aria-label').catch(() => null),
          href: await el.getAttribute('href').catch(() => null),
          text:
            (await el.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim().slice(0, 50) ??
            '',
          visible: String(await el.isVisible().catch(() => false)),
        });
      }
      console.log(`\n[${label}] count=${c}`);
      console.log(JSON.stringify(out, null, 2));
    }
    await listAria('div[contenteditable="true"]', 'compose-boxes');
    await listAria(
      'button[aria-label*="Close" i], button[aria-label*="conversation" i]',
      'close-buttons',
    );
    await listAria('button[aria-label*="Send" i], button.msg-form__send-button', 'send-buttons');
    await listAria(
      '[class*="msg-overlay"] a[href*="/in/"], .msg-overlay-conversation-bubble a[href*="/in/"]',
      'overlay-recipient-links',
    );
    await listAria(
      '[class*="msg-overlay-bubble-header"], [class*="msg-overlay-conversation-bubble__title"]',
      'overlay-headers',
    );

    // Exact container classes for overlays that hold a compose box, so the runner
    // can scope box+send to the overlay whose recipient link matches the target.
    for (const sel of [
      '[class*="msg-overlay-conversation-bubble"]',
      '[class*="msg-overlay-bubble"]',
      '[class*="msg-convo-wrapper"]',
    ]) {
      const loc = page.locator(sel);
      const c = await loc.count();
      const rows: string[] = [];
      for (let i = 0; i < Math.min(c, 8); i++) {
        const cn = await loc
          .nth(i)
          .evaluate((el) => (el as { className: string }).className)
          .catch(() => '?');
        const hasBox = (await loc.nth(i).locator('div[contenteditable="true"]').count()) > 0;
        const links = await loc
          .nth(i)
          .locator('a[href*="/in/"]')
          .evaluateAll((els) =>
            els.map((e) =>
              (e as { getAttribute(name: string): string | null }).getAttribute('href'),
            ),
          )
          .catch(() => []);
        rows.push(
          `  #${i} hasBox=${hasBox} links=${JSON.stringify(links)} class="${String(cn).slice(0, 80)}"`,
        );
      }
      console.log(`\n[container ${sel}] count=${c}\n${rows.join('\n')}`);
    }

    // Verify the RECIPIENT-SCOPED selectors work through shadow DOM. These are
    // exactly what the fixed runner will use: scope box + send to the overlay
    // that provably links to the target's profile, so a wrong conversation is
    // impossible.
    const pid = 'ericmccrum';
    const convo = `.msg-overlay-conversation-bubble:has(a[href*="/in/${pid}/"])`;
    for (const [label, sel] of [
      ['scoped convo', convo],
      ['scoped box', `${convo} div.msg-form__contenteditable[contenteditable="true"]`],
      ['scoped box (aria)', `${convo} div[contenteditable="true"][aria-label*="message" i]`],
      ['scoped send', `${convo} button.msg-form__send-button`],
      [
        'wrong-recipient convo (should be 0)',
        `.msg-overlay-conversation-bubble:has(a[href*="/in/nonexistentperson999/"]) div.msg-form__contenteditable`,
      ],
    ] as const) {
      console.log(
        `[scoped] ${label}: count=${await page
          .locator(sel)
          .count()
          .catch((e) => 'ERR ' + e)}`,
      );
    }

    const info = await page.evaluate(`(function(){
      function cls(e){return e&&typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,3).join('.'):'';}
      function up(e,n){var c=[];for(var i=0;i<n&&e;i++){c.push(cls(e)||e.tagName.toLowerCase());e=e.parentElement;}return c;}
      // 1) every contenteditable + its ancestor chain (to find the overlay container)
      var boxes=Array.prototype.slice.call(document.querySelectorAll('div[contenteditable="true"]'));
      var boxInfo=boxes.map(function(b){return {aria:b.getAttribute('aria-label'),cls:cls(b),ancestors:up(b,10)};});
      // 1b) any element whose class mentions msg-form or msg-overlay (to find containers even with no box)
      var msgEls=Array.prototype.slice.call(document.querySelectorAll('[class*="msg-form"],[class*="msg-overlay"],[class*="msg-convo"]'));
      var msgSample=msgEls.slice(0,12).map(function(e){return cls(e);});
      // 2) overlay containers
      var overlays=Array.prototype.slice.call(document.querySelectorAll('[class*="msg-overlay-conversation-bubble"], [class*="msg-overlay"]'));
      var ovInfo=overlays.slice(0,8).map(function(o){
        var links=Array.prototype.slice.call(o.querySelectorAll('a[href*="/in/"]')).map(function(a){return a.getAttribute('href');});
        var names=Array.prototype.slice.call(o.querySelectorAll('h2,[class*="title"]')).map(function(h){return (h.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40);}).filter(Boolean).slice(0,3);
        return {cls:cls(o),ariaLabel:o.getAttribute('aria-label'),profileLinks:links.slice(0,3),titles:names,hasComposeBox:!!o.querySelector('div[contenteditable="true"]')};
      });
      // 3) close-button candidates
      var closes=Array.prototype.slice.call(document.querySelectorAll('button[aria-label*="Close" i], button[class*="close" i]'));
      var closeInfo=closes.slice(0,10).map(function(b){return {aria:b.getAttribute('aria-label'),cls:cls(b)};});
      return {boxCount:boxes.length,boxInfo:boxInfo,msgSample:msgSample,overlays:ovInfo,closeButtons:closeInfo};
    })()`);
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
