// Backfill each campaign target's currentCompany from its stored headline, using
// the same conservative extractor sourcing now runs automatically. One-off:
// existing targets were enrolled before company auto-classification existed.
//
//   DATABASE_URL=... npm run enrich-company -- --dry-run
//   DATABASE_URL=... npm run enrich-company -- --go
//
// Reads all targets in the two live campaigns, and for any without a company but
// with a headline, extracts and writes currentCompany into external_context.
// Reports coverage. Idempotent: a target that already has a company is skipped.

import { extractCompany } from '@loa/shared';
import { loadConfig } from '../config.js';
import { makePostgresStore } from '../store/index.js';

const CAMPAIGN_IDS = [
  '63f1cd27-57d8-4d96-bc18-31456c94f45a', // FRCS
  '6970997e-b991-4f4f-b0f8-b3c90e77bc51', // reliability
];

async function main(): Promise<void> {
  const go = process.argv.includes('--go');
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const store = makePostgresStore(config.databaseUrl);

  let total = 0;
  let already = 0;
  let set = 0;
  let blank = 0;
  const samples: string[] = [];

  for (const campaignId of CAMPAIGN_IDS) {
    const targets = await store.listTargetsByCampaign(campaignId);
    for (const t of targets) {
      total += 1;
      const ext = (t.externalContext ?? {}) as Record<string, unknown>;
      const existing = typeof ext.currentCompany === 'string' ? ext.currentCompany.trim() : '';
      if (existing) {
        already += 1;
        continue;
      }
      const headline = typeof ext.headline === 'string' ? ext.headline : null;
      const company = extractCompany(headline);
      if (!company) {
        blank += 1;
        continue;
      }
      if (samples.length < 12) samples.push(`${company}  ←  ${(ext.name as string) ?? '?'}`);
      if (go) {
        await store.target.setExternalContext(t.id, {
          ...ext,
          currentCompany: company,
        } as never);
      }
      set += 1;
    }
  }

  console.log(`targets: ${total}`);
  console.log(`  already had a company: ${already}`);
  console.log(`  ${go ? 'set' : 'would set'} a company: ${set}`);
  console.log(`  no confident company (headline omits it): ${blank}`);
  console.log(`  => company coverage after: ${already + set}/${total}`);
  console.log(`\nsample extractions:\n  ${samples.join('\n  ')}`);
  if (!go) console.log('\nDRY RUN — nothing written. Re-run with --go to apply.');

  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
