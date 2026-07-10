// Split one sourced lead list into two campaign-specific lists (public-network
// vs everyone else) and enroll each segment into its campaign. One-off operator
// tool: it reads the SAME Postgres the runtime uses, so the running dispatch
// tick picks up the enrolled targets on its next pass.
//
//   DATABASE_URL=... npm run split-and-enroll -- --dry-run
//   DATABASE_URL=... npm run split-and-enroll -- --go
//
// --dry-run prints the full tagged split and writes it to a review file; it
// creates nothing. --go creates the two lists, writes members into them, adds
// the segmented people as campaign targets (folding name/profileUrl/headline
// into external_context so {First} resolves at send time), and enrolls them.
// Idempotent: list member writes and target enroll are unique-keyed, so a second
// --go is safe.

import { writeFile } from 'node:fs/promises';
import { CampaignService, EventLog } from '@loa/orchestrator';
import { loadConfig } from '../config.js';
import { makePostgresStore } from '../store/index.js';
import type { db as shared, Json } from '@loa/shared';

// --- fixed identities for this run (from list_accounts / list_lists / created
//     campaigns). Override any with the matching --flag=value. ---
const DEFAULTS = {
  sourceListId: 'a8c114cc-8ed2-4a45-bf53-71c352babde5',
  accountId: '58db1bd8-9676-4e10-89b8-04035fb39e8d',
  frcsCampaignId: '63f1cd27-57d8-4d96-bc18-31456c94f45a',
  reliabilityCampaignId: '6970997e-b991-4f4f-b0f8-b3c90e77bc51',
  frcsListName: 'GridLink — public networks (FRCS)',
  reliabilityListName: 'GridLink — reliability & maintenance',
};

/** Public charging-network operators / CPOs / site-host networks. A member whose
 * headline names one of these is pitched the first-charge-success (FRCS) angle;
 * everyone else gets the reliability/maintenance angle. Matched on the lowercased
 * headline (company lives in the headline; current_company is null on this list). */
const PUBLIC_NETWORK_MARKERS = [
  'electrify america', 'evgo', 'chargepoint', 'charge point', 'flo ev', 'flo charging',
  ' flo', 'network operations - flo', 'evcs', 'shell recharge', 'blink', 'applegreen',
  'circle k', 'on the run charging', 'greenspot', 'revel', 'evpassport', 'jule',
  'speed charge', 'envirospark', 'invisible urban', 'voltie', 'evstart', 'rocketev',
  'aetherev', 'everged', 'bullet ev', 'swtch', 'tep canada', 'poweron', 'bc hydro',
  'toronto parking', 'ionna', 'ionity', 'francis energy', ' red e', 'mn8', 'supercharger',
  'adventure network', 'waypoint network', 'ev network operations at tesla',
  'charging network operation', 'network operations', 'evse operations at powerflex',
  'alboev', 'albo ev', 'sea 2 sky', '7-eleven',
];

type Segment = 'FRCS' | 'RELIABILITY';

function classify(headline: string | null): Segment {
  const h = (headline ?? '').toLowerCase();
  return PUBLIC_NETWORK_MARKERS.some((m) => h.includes(m)) ? 'FRCS' : 'RELIABILITY';
}

function publicIdFromUrl(url: string | null): string | undefined {
  const m = (url ?? '').match(/\/in\/([^/?#]+)/);
  return m?.[1];
}

function flag(argv: string[], name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = !argv.includes('--go');
  const cfg = {
    sourceListId: flag(argv, 'source-list') ?? DEFAULTS.sourceListId,
    accountId: flag(argv, 'account') ?? DEFAULTS.accountId,
    frcsCampaignId: flag(argv, 'frcs-campaign') ?? DEFAULTS.frcsCampaignId,
    reliabilityCampaignId: flag(argv, 'reliability-campaign') ?? DEFAULTS.reliabilityCampaignId,
  };

  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const store = makePostgresStore(config.databaseUrl);
  const campaigns = new CampaignService(store.campaign, store.target, new EventLog(store.event));

  const members = await store.leadList.listMembers(cfg.sourceListId);
  const frcs = members.filter((m) => classify(m.headline) === 'FRCS');
  const reliability = members.filter((m) => classify(m.headline) === 'RELIABILITY');

  // Review artifact: every member and the segment it landed in.
  const review = [...members]
    .map((m) => `${classify(m.headline)}\t${m.name ?? '(no name)'}\t${m.headline ?? ''}`)
    .sort()
    .join('\n');
  const reviewPath = `/tmp/loa-split-review.tsv`;
  await writeFile(reviewPath, `segment\tname\theadline\n${review}\n`);

  console.log(`source list ${cfg.sourceListId}: ${members.length} members`);
  console.log(`  FRCS (public networks): ${frcs.length}`);
  console.log(`  RELIABILITY (everyone else): ${reliability.length}`);
  console.log(`  full tagged split written to ${reviewPath}`);

  if (dryRun) {
    console.log('\nDRY RUN — no lists created, no targets enrolled. Re-run with --go to apply.');
    await store.close();
    return;
  }

  // --- apply ---
  for (const [segName, seg, campaignId, listName] of [
    ['FRCS', frcs, cfg.frcsCampaignId, DEFAULTS.frcsListName],
    ['RELIABILITY', reliability, cfg.reliabilityCampaignId, DEFAULTS.reliabilityListName],
  ] as Array<[string, shared.LeadListMemberRow[], string, string]>) {
    // 1. Create the campaign-specific list and copy the segment's members in.
    const list = await store.leadList.createList({
      name: listName,
      description: `${segName} segment of source list ${cfg.sourceListId} (${seg.length} members).`,
    });
    const memberRows = seg.map((m) => ({
      listId: list.id,
      linkedinUrn: m.linkedinUrn,
      name: m.name,
      headline: m.headline,
      profileUrl: m.profileUrl,
      degree: m.degree,
      location: m.location,
      currentCompany: m.currentCompany,
    })) as shared.NewLeadListMemberRow[];
    const { inserted } = await store.leadList.insertMembers(memberRows);

    // 2. Add the people as campaign targets, folding identity into external
    //    context (profileUrl drives navigation, name drives {First}).
    const inputs = seg.map((m) => {
      const externalContext: Record<string, string> = {};
      if (m.profileUrl) externalContext.profileUrl = m.profileUrl;
      if (m.name) externalContext.name = m.name;
      if (m.headline) externalContext.headline = m.headline;
      if (m.currentCompany) externalContext.currentCompany = m.currentCompany;
      if (m.location) externalContext.location = m.location;
      if (m.degree) externalContext.degree = m.degree;
      return {
        prospectRef: publicIdFromUrl(m.profileUrl) ?? m.linkedinUrn,
        linkedinUrn: m.linkedinUrn,
        externalContext: externalContext as Json,
      };
    });
    const targets = await campaigns.addTargets(campaignId, inputs);

    // 3. Enroll each target into its campaign sequence.
    let enrolled = 0;
    for (const t of targets) {
      await store.sequence.enrollTarget(campaignId, t.id, cfg.accountId);
      enrolled += 1;
    }
    console.log(
      `${segName}: list ${list.id} (+${inserted} members), ${targets.length} targets, ${enrolled} enrolled into ${campaignId}`,
    );
  }

  await store.close();
  console.log('\nDONE. Enrolled targets are live; the dispatch tick will begin sending connects within caps.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
