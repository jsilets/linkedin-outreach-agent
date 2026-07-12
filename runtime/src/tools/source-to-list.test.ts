import { describe, expect, it } from 'vitest';
import { parseArgs } from './source-to-list.js';

describe('source-to-list parseArgs', () => {
  it('parses a single --geo id into geoUrns', () => {
    const { query } = parseArgs(['acct', '--list-name', 'US', '--geo', '103644278']);
    expect(query.geoUrns).toEqual(['103644278']);
  });

  it('parses a comma-separated --geo list into geoUrns (like --company-urn)', () => {
    const { query } = parseArgs(['acct', '--list-name', 'NA', '--geo', '103644278, 101174742']);
    // Whitespace around commas is trimmed and empties dropped, matching csv().
    expect(query.geoUrns).toEqual(['103644278', '101174742']);
  });

  it('leaves geoUrns unset when --geo is absent', () => {
    const { query } = parseArgs(['acct', '--list-name', 'X', '--keywords', 'ops']);
    expect(query.geoUrns).toBeUndefined();
  });

  it('keeps accountId, list flags, and other facets alongside --geo', () => {
    const parsed = parseArgs([
      'acct-1',
      '--list-id',
      'list-9',
      '--company-urn',
      '439853,2685826',
      '--geo',
      '103644278,101174742',
      '--network',
      'S,O',
    ]);
    expect(parsed.accountId).toBe('acct-1');
    expect(parsed.listId).toBe('list-9');
    expect(parsed.query.companyUrns).toEqual(['439853', '2685826']);
    expect(parsed.query.geoUrns).toEqual(['103644278', '101174742']);
    expect(parsed.query.network).toEqual(['S', 'O']);
  });
});
