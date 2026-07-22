import { describe, expect, it } from 'vitest';
import {
  canonicalProfileKey,
  expandsInitialFirstName,
  firstNameIsInitial,
  isTruncatedName,
} from './profile.js';

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

describe('isTruncatedName', () => {
  it('flags a trailing surname stub', () => {
    expect(isTruncatedName('R S.')).toBe(true);
    expect(isTruncatedName('Joe D.')).toBe(true);
  });

  it('leaves a real name, a credential suffix, and an initial without a period alone', () => {
    expect(isTruncatedName('Priya Raman')).toBe(false);
    expect(isTruncatedName('Priya Raman, P.Eng.')).toBe(false);
    expect(isTruncatedName('Malcolm X')).toBe(false);
    expect(isTruncatedName('R Shafaei, P.Eng.')).toBe(false);
    expect(isTruncatedName(null)).toBe(false);
  });
});

describe('firstNameIsInitial', () => {
  it('flags a bare-initial given name, with or without a period or suffix', () => {
    expect(firstNameIsInitial('R Shafaei')).toBe(true);
    expect(firstNameIsInitial('R Shafaei, P.Eng.')).toBe(true);
    expect(firstNameIsInitial('J. Smith')).toBe(true);
  });

  it('leaves a real given name and a lone token alone', () => {
    expect(firstNameIsInitial('Rouh Shafaei')).toBe(false);
    expect(firstNameIsInitial('Priya Raman, P.Eng.')).toBe(false);
    expect(firstNameIsInitial('Cher')).toBe(false);
    expect(firstNameIsInitial('R S.')).toBe(true); // also an initial given name
    expect(firstNameIsInitial('')).toBe(false);
  });
});

describe('expandsInitialFirstName', () => {
  it('accepts a same-surname expansion of the stored initial', () => {
    expect(expandsInitialFirstName('R Shafaei, P.Eng.', 'Rouh Shafaei')).toBe(true);
    expect(expandsInitialFirstName('J. Smith', 'Jordan Smith')).toBe(true);
  });

  it('rejects a different surname or a non-matching initial', () => {
    expect(expandsInitialFirstName('R Shafaei', 'Rita Alvarez')).toBe(false);
    expect(expandsInitialFirstName('R Shafaei', 'Bob Shafaei')).toBe(false);
  });

  it('rejects when either side is not a two-token given+surname name', () => {
    expect(expandsInitialFirstName('Rouh Shafaei', 'Rouhullah Shafaei')).toBe(false); // stored not an initial
    expect(expandsInitialFirstName('R Shafaei', 'Rouh')).toBe(false); // full has no surname
  });
});
