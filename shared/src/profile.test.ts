import { describe, it, expect } from 'vitest';
import { canonicalProfileKey } from './profile.js';

describe('canonicalProfileKey', () => {
  it('unwraps a search-result entityUrn to the bare fsd_profile urn', () => {
    expect(
      canonicalProfileKey(
        'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAA123,SEARCH_SRP,DEFAULT)',
      ),
    ).toBe('urn:li:fsd_profile:ACoAA123');
  });

  it('leaves an already-bare fsd_profile urn unchanged', () => {
    expect(canonicalProfileKey('urn:li:fsd_profile:ACoAA123')).toBe('urn:li:fsd_profile:ACoAA123');
  });

  it('is idempotent', () => {
    const wrapped =
      'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAA_9-x,SEARCH_SRP,DEFAULT)';
    const once = canonicalProfileKey(wrapped);
    expect(canonicalProfileKey(once)).toBe(once);
  });

  it('collapses two wrappers of the same person to one key', () => {
    const a = canonicalProfileKey(
      'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAxyz,SEARCH_SRP,DEFAULT)',
    );
    const b = canonicalProfileKey(
      'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAxyz,PEOPLE,DEFAULT)',
    );
    expect(a).toBe(b);
  });

  it('passes through refs with no fsd_profile token (dev refs, member urns, urls)', () => {
    expect(canonicalProfileKey('urn:li:person:crm-1')).toBe('urn:li:person:crm-1');
    expect(canonicalProfileKey('urn:li:member:98765')).toBe('urn:li:member:98765');
    expect(canonicalProfileKey('https://www.linkedin.com/in/dana-lopez/')).toBe(
      'https://www.linkedin.com/in/dana-lopez/',
    );
  });
});
