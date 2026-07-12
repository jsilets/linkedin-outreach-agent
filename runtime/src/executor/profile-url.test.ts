import type { Target } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import { profileUrlForTarget } from './session-provider.js';

function target(over: Partial<Target>): Target {
  return {
    id: 't1',
    prospectRef: 'ref',
    linkedinUrn: '',
    externalContext: {},
    stage: 'sourced',
    campaignId: 'c1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

describe('profileUrlForTarget', () => {
  const WRAPPED =
    'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAADddP88BDzg1iKnhgLmjDHu9bOnYbpegn8s,SEARCH_SRP,DEFAULT)';

  it('prefers the stored /in/ vanity url over the wrapped urn', () => {
    const t = target({
      linkedinUrn: WRAPPED,
      externalContext: { profileUrl: 'https://www.linkedin.com/in/dfanavoll' },
    });
    expect(profileUrlForTarget(t)).toBe('https://www.linkedin.com/in/dfanavoll');
  });

  it('never produces the ,SEARCH_SRP,DEFAULT) junk url that 404s', () => {
    const t = target({ linkedinUrn: WRAPPED, externalContext: {} });
    const url = profileUrlForTarget(t);
    expect(url).not.toContain('SEARCH_SRP');
    expect(url).not.toContain('%2C');
    // Falls back to the clean inner fsd_profile id.
    expect(url).toBe('https://www.linkedin.com/in/ACoAADddP88BDzg1iKnhgLmjDHu9bOnYbpegn8s/');
  });

  it('extracts the id from a bare person urn', () => {
    const t = target({ linkedinUrn: 'urn:li:person:ABC123', externalContext: {} });
    expect(profileUrlForTarget(t)).toBe('https://www.linkedin.com/in/ABC123/');
  });

  it('passes a full url ref through unchanged', () => {
    const t = target({ linkedinUrn: 'https://www.linkedin.com/in/jane/', externalContext: {} });
    expect(profileUrlForTarget(t)).toBe('https://www.linkedin.com/in/jane/');
  });
});
