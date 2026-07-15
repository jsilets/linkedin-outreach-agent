// Read-only DOM capture of the thread/new COMPOSER surface, to answer one
// question: after a recipient's typeahead card is clicked, what identity
// evidence does the page hold? message() currently gates on an
// a[href*="/in/<id>"] anchor; the 2026-07-15 diagnostic showed a page whose
// only /in/ anchors were the logged-in user's own nav chrome, so the anchor
// may simply not exist on this surface. This dump types the recipient's name,
// clicks the matching card (same pick logic as message()), and then dumps the
// cards, every /in/ anchor, the To-field pill, and — the decisive part — every
// place in the DOM (shadow roots included) where the recipient's member id,
// vanity slug, or any urn:li attribute appears. It NEVER types into the
// compose box and NEVER sends.
//
// The runtime must be STOPPED first (it holds the Chrome profile lock):
//   launchctl bootout gui/$(id -u)/com.loa.runtime
//   npm run composer-dump -- <accountId> <recipientName> <vanity> [memberId]
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.loa.runtime.plist

import { join } from 'node:path';
import { chromium } from 'patchright';
import { loadConfig } from '../config.js';

const TYPEAHEAD_KEY_DELAY_MS = 70;

function wordBoundaryMatch(text: string, wanted: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(wanted, from);
    if (i === -1) return false;
    const before = i === 0 ? '' : text[i - 1]!;
    if (!/[a-z]/.test(before)) return true;
    from = i + 1;
  }
}

async function main(): Promise<void> {
  const [accountId, recipientName, vanity, memberId] = process.argv.slice(2);
  if (!accountId || !recipientName || !vanity) {
    console.error('usage: composer-dump <accountId> <recipientName> <vanity> [memberId]');
    process.exit(2);
  }
  const config = loadConfig();
  const userDataDir = join(config.profileDir, accountId);
  // LOA_DUMP_HEADLESS=true reproduces the runtime's real launch mode (it runs
  // headless; a headed probe can render differently and mask the bug).
  // LOA_DUMP_VIEWPORT="1440x900" tests whether a rendering difference is
  // viewport-height dependent (headless defaults to 1280x720).
  const vp = process.env.LOA_DUMP_VIEWPORT?.match(/^(\d+)x(\d+)$/);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.LOA_DUMP_HEADLESS === 'true',
    channel: 'chromium',
    ...(vp ? { viewport: { width: Number(vp[1]), height: Number(vp[2]) } } : {}),
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://www.linkedin.com/messaging/thread/new/', {
      waitUntil: 'domcontentloaded',
    });
    console.log('[dump] url after goto:', page.url());

    const fieldSel =
      'input.msg-connections-typeahead__search-field, ' +
      'input[placeholder*="Type a name" i][role="combobox"]';
    const field = page.locator(fieldSel).first();
    await field.waitFor({ state: 'visible', timeout: 15000 });
    await field.click();
    const searchName = (recipientName.split(',')[0] ?? recipientName).trim();
    await field.type(searchName, { delay: TYPEAHEAD_KEY_DELAY_MS });
    await page.waitForTimeout(3000);

    // --- 1. The typeahead cards, verbatim -----------------------------------
    const cardSel =
      '[role="option"][data-view-name="messaging-type-ahead-card"], ' +
      '.msg-connections-typeahead__search-result[data-view-name="messaging-type-ahead-card"]';
    const cards = page.locator(cardSel);
    await cards
      .first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .catch(() => {});
    const count = await cards.count();
    console.log(`\n[cards] count=${count}`);
    const texts: string[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = cards.nth(i);
      const text = ((await el.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
      texts.push(text.toLowerCase());
      const attrs = await el
        .evaluate(
          `(function(e){var o={};for(var i=0;i<e.attributes.length;i++){var a=e.attributes[i];o[a.name]=a.value.slice(0,120);}return o;})`,
        )
        .catch(() => ({}));
      const innerLinks = await el
        .locator('a')
        .evaluateAll(
          `(function(els){return els.map(function(a){return a.getAttribute('href');});})`,
        )
        .catch(() => []);
      console.log(`  #${i} text="${text.slice(0, 100)}"`);
      console.log(`     attrs=${JSON.stringify(attrs)}`);
      console.log(`     links=${JSON.stringify(innerLinks)}`);
    }

    // --- 2. Pick with message()'s exact logic and click ----------------------
    const wanted = searchName.toLowerCase();
    let picked = -1;
    let firstNameMatch = -1;
    for (let i = 0; i < Math.min(count, 10); i++) {
      const text = texts[i] ?? '';
      if (!wordBoundaryMatch(text, wanted)) continue;
      if (firstNameMatch === -1) firstNameMatch = i;
      if (/•\s*1st\b/.test(text) || /\b1st\b/.test(text)) {
        picked = i;
        break;
      }
    }
    if (picked === -1) picked = firstNameMatch;
    console.log(`\n[pick] picked=${picked} (firstNameMatch=${firstNameMatch})`);
    if (picked === -1) {
      console.log('[pick] no card matched — message() would refuse here. Stopping.');
      return;
    }
    await cards.nth(picked).click();
    await page.waitForTimeout(4500);
    console.log('[post-click] url:', page.url());

    // --- 3. Every /in/ anchor on the page, with its ancestry -----------------
    const anchors = page.locator('a[href*="/in/"]');
    const aCount = await anchors.count();
    console.log(`\n[anchors a[href*="/in/"]] count=${aCount}`);
    for (let i = 0; i < Math.min(aCount, 20); i++) {
      const el = anchors.nth(i);
      const href = await el.getAttribute('href').catch(() => null);
      const chain = await el
        .evaluate(
          `(function(e){var parts=[];var n=e;for(var d=0;d<8&&n;d++){var cls=typeof n.className==='string'?n.className.trim().split(/\\s+/)[0]:'';parts.push(cls||n.tagName.toLowerCase());n=n.parentElement;}return parts.join(' < ');})`,
        )
        .catch(() => '?');
      console.log(`  ${href}\n     in: ${chain}`);
    }

    // --- 3b. If the recipient anchor is missing (headless renders no
    //         msg-s-profile-card), try to force the lazy card to mount by
    //         scrolling the history to the top — first via focus+Home (works
    //         through the existing PagePort), then via a direct scrollTop=0. ---
    const recipientAnchor =
      `a[href*="/in/${vanity}/"], a[href$="/in/${vanity}"]` +
      (memberId ? `, a[href*="/in/${memberId}/"], a[href$="/in/${memberId}"]` : '');
    const anchorCount = () => page.locator(recipientAnchor).count();
    console.log(`\n[recipient-anchor] present after click: ${await anchorCount()}`);
    if ((await anchorCount()) === 0) {
      const list = page.locator('.msg-s-message-list').first();
      await list.focus().catch(() => {});
      await page.keyboard.press('Home').catch(() => {});
      await page.waitForTimeout(2000);
      console.log(`[recipient-anchor] after focus+Home: ${await anchorCount()}`);
      if ((await anchorCount()) === 0) {
        await list.evaluate(`(function(el){el.scrollTop = 0;})`).catch(() => {});
        await page.waitForTimeout(2500);
        console.log(`[recipient-anchor] after scrollTop=0: ${await anchorCount()}`);
        const cardCount = await page.locator('.msg-s-profile-card').count();
        console.log(`[recipient-anchor] msg-s-profile-card count now: ${cardCount}`);
      }
    }

    // --- 4. The To-field pill and thread header ------------------------------
    for (const [label, sel] of [
      ['pills', '[class*="pill"]'],
      ['selected-recipients', '[class*="msg-connections-typeahead"] [class*="entity"]'],
      ['thread-headers', 'h2, [class*="msg-entity-lockup"], [class*="thread"] header'],
      ['compose-boxes', 'div[contenteditable="true"]'],
      ['thread-containers', '[class*="msg-convo-wrapper"], [class*="msg-thread"]'],
    ] as const) {
      const loc = page.locator(sel);
      const c = await loc.count().catch(() => -1);
      console.log(`\n[${label}] count=${c}`);
      for (let i = 0; i < Math.min(c, 6); i++) {
        const el = loc.nth(i);
        const text = ((await el.textContent().catch(() => '')) ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 90);
        const attrs = await el
          .evaluate(
            `(function(e){var o={};for(var i=0;i<e.attributes.length;i++){var a=e.attributes[i];if(a.name!=='class'||a.value.length<120){o[a.name]=a.value.slice(0,150);}}return o;})`,
          )
          .catch(() => ({}));
        console.log(`  #${i} text="${text}" attrs=${JSON.stringify(attrs)}`);
      }
    }

    // --- 5. THE DECISIVE PART: where (if anywhere) does the recipient's
    //        identity live in the DOM? Recursive walk, shadow roots included. --
    const needles = [vanity, ...(memberId ? [memberId] : [])];
    const hits = await page
      .evaluate(
        `(function(){
      var needles = ${JSON.stringify(needles)};
      var hits = [];
      function path(e){var p=[];var n=e;for(var d=0;d<6&&n;d++){var c=typeof n.className==='string'?n.className.trim().split(/\\s+/)[0]:'';p.push(c||n.tagName.toLowerCase());n=n.parentElement||(n.getRootNode&&n.getRootNode().host)||null;}return p.join(' < ');}
      function walk(root){
        var it = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var i=0;i<it.length;i++){
          var el = it[i];
          for (var j=0;j<el.attributes.length;j++){
            var a = el.attributes[j];
            for (var k=0;k<needles.length;k++){
              if (a.value.indexOf(needles[k])!==-1){
                hits.push({needle:needles[k],attr:a.name,value:a.value.slice(0,200),tag:el.tagName.toLowerCase(),path:path(el)});
              }
            }
            if (a.value.indexOf('urn:li:')!==-1 && hits.length<80){
              hits.push({needle:'urn:li:*',attr:a.name,value:a.value.slice(0,200),tag:el.tagName.toLowerCase(),path:path(el)});
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      }
      walk(document);
      return hits.slice(0,80);
    })()`,
      )
      .catch((e: unknown) => `EVAL ERR ${String(e)}`);
    console.log('\n[identity-needles] looking for:', JSON.stringify(needles));
    console.log(JSON.stringify(hits, null, 2));

    console.log('\n[dump] done — nothing was typed into the compose box, nothing sent.');
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
