// One-off diagnostic: resume a vaulted session, open a profile, and report which
// connect-related selectors currently match the live DOM, plus a dump of the
// action-bar buttons/anchors (visible text) so a stale selector can be fixed
// from evidence. Mirrors selector-scan but focused on the connect flow and with
// candidate selectors beyond the shipped ones.
//
//   COOKIE_VAULT_KEY=... LOA_VAULT_DIR=... LOA_PROFILE_DIR=... LOA_ALLOW_NO_PROXY=true \
//   npm run -w runtime connect-probe -- <accountId> <profileUrl>

import { SELECTORS } from '@loa/account-runner';
import { loadConfig } from '../config.js';
import { LiveSessionProvider } from '../executor/session-provider.js';

const CANDIDATES: Record<string, string> = {
  'SHIPPED connectButton': SELECTORS.connectButton,
  'SHIPPED moreActionsButton': SELECTORS.moreActionsButton,
  'SHIPPED connectInMenu': SELECTORS.connectInMenu,
  'SHIPPED pendingIndicator': SELECTORS.pendingIndicator,
  'page button:has-text(Connect)': 'button:has-text("Connect")',
  'main button:has-text(Connect)': 'main button:has-text("Connect")',
  'main button aria to-connect': 'main button[aria-label*="to connect" i]',
  'page button aria to-connect': 'button[aria-label*="to connect" i]',
  'main a aria to-connect': 'main a[aria-label*="to connect" i]',
  'page button aria Invite': 'button[aria-label*="Invite" i]',
  'main button aria Invite': 'main button[aria-label*="Invite" i]',
  'page button:has-text(More)': 'button:has-text("More")',
  'main button:has-text(More)': 'main button:has-text("More")',
  'button aria More exact': 'button[aria-label="More"]',
  'button aria More actions': 'button[aria-label*="More actions" i]',
  'page a:has-text(Connect)': 'a:has-text("Connect")',
  'main present at all': 'main',
  'primary action bar buttons': 'main div.pv-top-card button, main section button',
};

async function main(): Promise<void> {
  const accountId = process.argv[2];
  const profileUrl = process.argv[3];
  if (!accountId || !profileUrl) {
    console.error('usage: connect-probe <accountId> <profileUrl>');
    process.exit(2);
  }
  const config = loadConfig();
  const provider = new LiveSessionProvider({
    profileDir: config.profileDir,
    vaultDir: config.vaultDir,
    allowNoProxy: config.allowNoProxy,
  });
  try {
    console.log(`[probe] resuming session for ${accountId}`);
    const page = await provider.pageFor(accountId);
    console.log(`[probe] navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500); // let the action bar hydrate
    console.log(`[probe] landed at ${page.url()}\n`);

    console.log('[probe] candidate selector match counts:');
    for (const [label, sel] of Object.entries(CANDIDATES)) {
      let out: string;
      try {
        out = String(await page.locator(sel).count());
      } catch (err) {
        out = `ERR ${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(`  ${label.padEnd(34)} = ${out}`);
    }

    // Dump the visible text of the first N buttons/anchors inside <main> so we
    // can see the real action-bar labels (Connect / Message / More / Follow).
    for (const tag of ['button', 'a']) {
      const loc = page.locator(`main ${tag}`);
      const n = Math.min(await loc.count(), 25);
      console.log(`\n[probe] first ${n} <main ${tag}> visible texts:`);
      for (let i = 0; i < n; i++) {
        const t = (await loc.nth(i).textContent().catch(() => null))?.replace(/\s+/g, ' ').trim();
        if (t) console.log(`  [${i}] "${t.slice(0, 60)}"`);
      }
    }

    // Open the "More" overflow and dump its items, so we can see whether Connect
    // lives in the dropdown (and HOW it is marked up) for Follow-by-default
    // profiles. Try each More candidate until the artdeco dropdown content opens.
    const moreCands = page.locator(SELECTORS.moreActionsButton);
    const moreN = await moreCands.count();
    console.log(`\n[probe] More candidates: ${moreN}. Opening the dropdown...`);
    for (let i = 0; i < moreN; i++) {
      await moreCands.nth(i).click().catch(() => {});
      await page.waitForTimeout(1200);
      if ((await page.locator('.artdeco-dropdown__content').count()) > 0) {
        console.log(`  opened via More candidate #${i}`);
        break;
      }
    }
    console.log(`  .artdeco-dropdown__content present: ${await page.locator('.artdeco-dropdown__content').count()}`);

    console.log('\n[probe] dropdown item selector counts:');
    const ITEM_SELS: Record<string, string> = {
      'artdeco-dropdown__item': '.artdeco-dropdown__item',
      'dropdown__content *': '.artdeco-dropdown__content *',
      'role=menuitem': '[role="menuitem"]',
      'div[role=button]': 'div[role="button"]',
      'button (page)': 'button',
      'item:has(Connect)': '.artdeco-dropdown__item:has-text("Connect")',
      'div[role=button]:has(Connect)': 'div[role="button"]:has-text("Connect")',
      'button:has(Connect)': 'button:has-text("Connect")',
      'li:has(Connect)': 'li:has-text("Connect")',
      'aria Invite+connect': '[aria-label*="Invite" i][aria-label*="connect" i]',
      '*:text-is(Connect)': ':text-is("Connect")',
    };
    for (const [label, sel] of Object.entries(ITEM_SELS)) {
      let c: string;
      try { c = String(await page.locator(sel).count()); } catch (e) { c = `ERR ${e instanceof Error ? e.message : e}`; }
      console.log(`  ${label.padEnd(32)} = ${c}`);
    }

    console.log('\n[probe] .artdeco-dropdown__item texts:');
    const items = page.locator('.artdeco-dropdown__item');
    const in_ = Math.min(await items.count(), 15);
    for (let i = 0; i < in_; i++) {
      const t = (await items.nth(i).textContent().catch(() => null))?.replace(/\s+/g, ' ').trim();
      console.log(`  [${i}] "${(t ?? '').slice(0, 50)}"`);
    }
  } finally {
    await provider.close();
  }
}

main().catch((err) => {
  console.error('[probe] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
