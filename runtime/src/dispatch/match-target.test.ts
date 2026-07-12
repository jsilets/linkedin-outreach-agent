// Matching a sourced target against a LinkedIn identity. The load-bearing case
// is the real one: targets sourced via people-search carry the search wrapper
// urn (urn:li:fsd_entityResultViewModel:(...)) and their /in/ url lives in the
// enrichment blob, while an accepted connection / message sender arrives as a
// bare fsd_profile urn plus a /in/ vanity. Both ticks (acceptance, reply) depend
// on this matching, so a wrapper that fails to match means messages never send
// and replies never pull a target out.

import type { db as shared } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import { matchesIdentity, urnTail, vanityOf } from './match-target.js';

type TargetRow = shared.TargetRow;

const MEMBER_ID = 'ACoAAB0p8zUB3cS3LjoOd3qF5CwiVy_hLLCaci4';
const WRAPPER = `urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:${MEMBER_ID},SEARCH_SRP,DEFAULT)`;
const CLEAN = `urn:li:fsd_profile:${MEMBER_ID}`;

function target(overrides: Partial<TargetRow>): TargetRow {
  return {
    id: 't1',
    prospectRef: 'bradley-ewing',
    linkedinUrn: WRAPPER,
    externalContext: {},
    stage: 'invited',
    campaignId: 'c1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TargetRow;
}

describe('urnTail', () => {
  it('extracts the member id from the search wrapper', () => {
    expect(urnTail(WRAPPER)).toBe(MEMBER_ID.toLowerCase());
  });
  it('extracts the member id from a bare fsd_profile urn', () => {
    expect(urnTail(CLEAN)).toBe(MEMBER_ID.toLowerCase());
  });
  it('handles legacy person urns', () => {
    expect(urnTail('urn:li:person:ABC123')).toBe('abc123');
  });
  it('falls back to the last segment for unknown forms', () => {
    expect(urnTail('somebody')).toBe('somebody');
  });
});

describe('vanityOf', () => {
  it('reads the slug from a profile url', () => {
    expect(vanityOf('https://www.linkedin.com/in/bradley-ewing-099a41117')).toBe(
      'bradley-ewing-099a41117',
    );
  });
});

describe('matchesIdentity', () => {
  it('matches a wrapper-urn target to a bare connection urn by member id', () => {
    // The connection reader emits the bare fsd_profile urn; the target holds the
    // wrapper. They share the same member id, so this must match.
    expect(matchesIdentity(CLEAN, undefined, target({}))).toBe(true);
  });

  it('matches by /in/ vanity from the enrichment blob when ids differ by surface', () => {
    // Simulate the id-scheme mismatch: connection arrives as a legacy member urn
    // with a /in/ vanity, target's urn is a wrapper but its blob has the /in/ url.
    const t = target({
      linkedinUrn: WRAPPER,
      externalContext: { profileUrl: 'https://www.linkedin.com/in/bradley-ewing-099a41117' },
    });
    expect(
      matchesIdentity(
        'urn:li:member:99999',
        'https://www.linkedin.com/in/bradley-ewing-099a41117/',
        t,
      ),
    ).toBe(true);
  });

  it('does not match a different person', () => {
    expect(
      matchesIdentity(
        'urn:li:fsd_profile:ACoAADIFFERENT',
        'https://www.linkedin.com/in/someone-else',
        target({}),
      ),
    ).toBe(false);
  });
});
