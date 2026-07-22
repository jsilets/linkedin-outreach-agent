import type { ProfilePosition, ProfileSummary } from '@loa/mcp';
import { describe, expect, it, vi } from 'vitest';
import { companyFromProfile, ProfileCompanyEnricher, resolveCurrentPosition } from './enrich.js';

function profile(over: Partial<ProfileSummary>): ProfileSummary {
  return {
    linkedinUrn: 'urn:li:person:abc',
    handle: 'abc',
    name: 'Steven H',
    headline: 'COO @ aetherEV, ex. Tesla',
    raw: {},
    ...over,
  };
}

const pos = (over: Partial<ProfilePosition>): ProfilePosition => ({ ...over });

describe('resolveCurrentPosition', () => {
  it('prefers the position flagged current over an earlier one', () => {
    const positions = [
      pos({ company: 'aetherEV', title: 'COO', current: true }),
      pos({ company: 'Tesla', title: 'Director', current: false }),
    ];
    expect(resolveCurrentPosition(positions)?.company).toBe('aetherEV');
  });

  it('falls back to the most-recent position when none is flagged current', () => {
    const positions = [pos({ company: 'aetherEV' }), pos({ company: 'Tesla' })];
    expect(resolveCurrentPosition(positions)?.company).toBe('aetherEV');
  });

  it('is undefined for an empty or missing experience section', () => {
    expect(resolveCurrentPosition([])).toBeUndefined();
    expect(resolveCurrentPosition(undefined)).toBeUndefined();
  });
});

describe('companyFromProfile', () => {
  it('reads the current company off the current position, not a former employer', () => {
    const got = companyFromProfile(
      profile({
        positions: [
          pos({ company: 'aetherEV', title: 'COO', current: true }),
          pos({ company: 'Tesla', title: 'Director' }),
        ],
      }),
    );
    expect(got).toEqual({
      currentCompany: 'aetherEV',
      currentTitle: 'COO',
      companySource: 'profile',
    });
  });

  it('falls back to the summary fields when positions did not parse', () => {
    const got = companyFromProfile(
      profile({ currentCompany: 'Ivy Charging', currentTitle: 'Ops Manager', positions: [] }),
    );
    expect(got.currentCompany).toBe('Ivy Charging');
    expect(got.currentTitle).toBe('Ops Manager');
    expect(got.companySource).toBe('profile');
  });
});

describe('ProfileCompanyEnricher', () => {
  it('resolves the operating account and reads the profile', async () => {
    const getProfile = vi.fn(async () =>
      profile({ positions: [pos({ company: 'aetherEV', title: 'COO', current: true })] }),
    );
    const enricher = new ProfileCompanyEnricher({ getProfile }, async () => 'acct-1');
    const got = await enricher.enrich('urn:li:person:abc');
    expect(getProfile).toHaveBeenCalledWith('acct-1', 'urn:li:person:abc');
    expect(got).toEqual({
      currentCompany: 'aetherEV',
      currentTitle: 'COO',
      companySource: 'profile',
    });
  });

  it('returns null when there is no operating account (never blocks scoring)', async () => {
    const getProfile = vi.fn();
    const enricher = new ProfileCompanyEnricher({ getProfile }, async () => undefined);
    expect(await enricher.enrich('urn:li:person:abc')).toBeNull();
    expect(getProfile).not.toHaveBeenCalled();
  });

  it('returns null when the live read throws', async () => {
    const getProfile = vi.fn(async () => {
      throw new Error('voyager 429');
    });
    const enricher = new ProfileCompanyEnricher({ getProfile }, async () => 'acct-1');
    expect(await enricher.enrich('urn:li:person:abc')).toBeNull();
  });

  it('returns null when the profile yields no company and no title', async () => {
    const getProfile = vi.fn(async () => profile({ positions: [] }));
    const enricher = new ProfileCompanyEnricher({ getProfile }, async () => 'acct-1');
    expect(await enricher.enrich('urn:li:person:abc')).toBeNull();
  });
});
