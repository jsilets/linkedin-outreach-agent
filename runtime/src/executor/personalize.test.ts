import type { Target } from '@loa/shared';
import { describe, expect, it } from 'vitest';
import { companyFromTarget, firstNameFromTarget, personalizeBody } from './session-provider.js';

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

describe('firstNameFromTarget', () => {
  it('takes the first token of the sourced name', () => {
    expect(firstNameFromTarget(target({ externalContext: { name: 'Kenney Tran' } }))).toBe(
      'Kenney',
    );
  });

  it('is undefined when no name was captured', () => {
    expect(firstNameFromTarget(target({ externalContext: {} }))).toBeUndefined();
    expect(firstNameFromTarget(target({ externalContext: { name: '   ' } }))).toBeUndefined();
  });
});

describe('personalizeBody', () => {
  const t = target({ externalContext: { name: 'Kenney Tran' } });

  it('substitutes {First} with the first name', () => {
    expect(personalizeBody('Hi {First}, thanks for connecting.', t)).toBe(
      'Hi Kenney, thanks for connecting.',
    );
  });

  it('matches token spelling variants', () => {
    for (const tok of ['{First}', '{first}', '{FirstName}', '{first_name}', '{first name}']) {
      expect(personalizeBody(`Hey ${tok}!`, t)).toBe('Hey Kenney!');
    }
  });

  it('replaces every occurrence', () => {
    expect(personalizeBody('{First} {First}', t)).toBe('Kenney Kenney');
  });

  it('falls back to "there" when the target has no name', () => {
    const noName = target({ externalContext: {} });
    expect(personalizeBody('Hi {First}, thanks for connecting.', noName)).toBe(
      'Hi there, thanks for connecting.',
    );
  });

  it('leaves a body without the token unchanged', () => {
    expect(personalizeBody('No token here.', t)).toBe('No token here.');
  });

  it('is stable across repeated calls (stateful-regex guard)', () => {
    expect(personalizeBody('Hi {First}', t)).toBe('Hi Kenney');
    expect(personalizeBody('Hi {First}', t)).toBe('Hi Kenney');
  });
});

describe('companyFromTarget', () => {
  it('reads the sourced currentCompany', () => {
    expect(companyFromTarget(target({ externalContext: { currentCompany: 'Globex' } }))).toBe(
      'Globex',
    );
  });
  it('is undefined when absent or blank', () => {
    expect(companyFromTarget(target({ externalContext: {} }))).toBeUndefined();
    expect(
      companyFromTarget(target({ externalContext: { currentCompany: '  ' } })),
    ).toBeUndefined();
  });
});

describe('personalizeBody — {Company}', () => {
  const withCo = target({ externalContext: { name: 'Kenney Tran', currentCompany: 'Globex' } });
  const noCo = target({ externalContext: { name: 'Kenney Tran' } });

  it('substitutes {Company} when known', () => {
    expect(personalizeBody('your work at {Company} and see', withCo)).toBe(
      'your work at Globex and see',
    );
  });

  it('drops the "at {Company}" clause when the company is unknown', () => {
    expect(personalizeBody('your work at {Company} and see', noCo)).toBe('your work and see');
    expect(personalizeBody('your role @ {Company} today', noCo)).toBe('your role today');
  });

  it('personalizes both tokens together', () => {
    expect(personalizeBody('Hey {First}, how is {Company}?', withCo)).toBe(
      'Hey Kenney, how is Globex?',
    );
    expect(personalizeBody('Hey {First}, thanks.', noCo)).toBe('Hey Kenney, thanks.');
  });

  it('drops a bare {Company} token cleanly when unknown', () => {
    expect(personalizeBody('at {Company}', noCo)).toBe('');
  });
});
