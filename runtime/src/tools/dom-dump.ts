// Raw-DOM diagnostic: launch the persistent session directly (full page.evaluate
// access, which the PagePort wrapper hides) to capture the exact markup of the
// "Connect" control in a profile's More dropdown, plus its ancestor chain, so we
// can scope connectInMenu to the dropdown and not the recommendation cards.
//
//   LOA_PROFILE_DIR=... npm run -w runtime dom-dump -- <accountId> <profileUrl>

import { join } from 'node:path';
import { chromium } from 'patchright';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const accountId = process.argv[2];
  const profileUrl = process.argv[3];
  if (!accountId || !profileUrl) {
    console.error('usage: dom-dump <accountId> <profileUrl>');
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

    // First, dump every "More" control (text or aria) so we can see how the
    // profile-card More differs from feed/post Mores.
    const moreInfo = await page.evaluate(
      [
        '(function(){',
        "  var els=Array.prototype.slice.call(document.querySelectorAll('main button'));",
        "  return els.filter(function(b){var a=(b.getAttribute('aria-label')||'');var t=(b.textContent||'').replace(/\\s+/g,' ').trim();return a==='More'||/more actions/i.test(a)||t==='More';})",
        "  .slice(0,8).map(function(b){var p=b.parentElement, pp=p?p.parentElement:null;",
        "    function cn(e){return e&&typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,2).join('.'):'';}",
        "    return {aria:b.getAttribute('aria-label'),text:(b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,20),parent:cn(p),grand:cn(pp)};});",
        '})()',
      ].join('\n'),
    );
    console.log('[dom-dump] main "More" buttons:', JSON.stringify(moreInfo));

    // Open the profile-card "More" dropdown and CONFIRM it opened by waiting for
    // its signature items ("Save to PDF" / "Report"). Try each More candidate.
    const moreCands = page.locator('main button:has-text("More"), main button[aria-label*="More" i]');
    const menuOpen = () => page.getByText(/Save to PDF/i).count();
    let opened = false;
    const nCands = await moreCands.count();
    for (let i = 0; i < nCands && !opened; i++) {
      await moreCands.nth(i).click().catch(() => {});
      for (let t = 0; t < 8; t++) {
        await page.waitForTimeout(400);
        if ((await menuOpen()) > 0) { opened = true; break; }
      }
    }
    console.log(`[dom-dump] More dropdown opened: ${opened}`);

    // Passed as a STRING (not a function) to dodge tsx/esbuild's __name wrapper,
    // which is undefined in the page context.
    const js = [
      '(function(){',
      "  function isInvite(el){var a=el.getAttribute('aria-label')||'';return /invite/i.test(a)&&/to connect/i.test(a);}",
      '  function chainOf(start){var chain=[];var n=start;var d=0;while(n&&d<7){',
      "    var cls=(typeof n.className===\"string\"&&n.className.trim())?'.'+n.className.trim().split(/\\s+/).slice(0,3).join('.'):'';",
      "    var role=n.getAttribute?n.getAttribute('role'):null;",
      "    chain.push(n.tagName.toLowerCase()+cls+(role?('[role='+role+']'):''));n=n.parentElement;d++;}return chain;}",
      "  var invites=Array.prototype.slice.call(document.querySelectorAll('[aria-label]')).filter(isInvite);",
      '  var dropdown=Array.prototype.slice.call(document.querySelectorAll(\"*\")).filter(function(el){',
      "    var t=el.textContent||'';return /Report\\s*\\/\\s*Block/i.test(t)&&/Save to PDF/i.test(t)&&el.querySelectorAll('*').length<40;",
      "  }).slice(0,1).map(function(el){return el.outerHTML.replace(/\\s+/g,' ').slice(0,1100);});",
      '  return {inviteCount:invites.length,invites:invites.map(function(el){return {',
      "    tag:el.tagName,aria:el.getAttribute('aria-label'),text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30),chain:chainOf(el)",
      '  };}),dropdownOuter:dropdown};',
      '})()',
    ].join('\n');
    const info = await page.evaluate(js);
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error('[dom-dump] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
