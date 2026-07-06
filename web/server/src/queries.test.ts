// The volume query is asserted at the SQL level: postgres.js does not open a
// connection until a query actually runs, and drizzle's .toSQL() only builds
// the statement, so no live DB is needed here.
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://loa:loa@localhost:5432/loa';

// Import lazily so the dummy DATABASE_URL is in place first.
let buildVolumeQuery: typeof import('./queries.js').buildVolumeQuery;

beforeAll(async () => {
  ({ buildVolumeQuery } = await import('./queries.js'));
});

describe('buildVolumeQuery', () => {
  it('filters to successful actions and groups by day + type', () => {
    const { sql, params } = buildVolumeQuery({ days: 30 }).toSQL();
    expect(sql).toContain('"actions"');
    expect(sql).toContain('date_trunc');
    expect(sql).toContain('group by');
    // result='success' is a bound param, not inlined.
    expect(params).toContain('success');
    // No account filter when accountId is omitted.
    expect(sql).not.toContain('"account_id" =');
  });

  it('adds an account filter when accountId is given', () => {
    const { sql, params } = buildVolumeQuery({
      accountId: '11111111-1111-1111-1111-111111111111',
      days: 7,
    }).toSQL();
    expect(sql).toContain('"account_id"');
    expect(params).toContain('11111111-1111-1111-1111-111111111111');
    expect(params).toContain(7);
  });

  it('honors the days window in the interval expression', () => {
    const { params } = buildVolumeQuery({ days: 90 }).toSQL();
    expect(params).toContain(90);
  });
});
