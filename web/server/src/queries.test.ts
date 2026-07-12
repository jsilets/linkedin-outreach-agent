// The volume query is asserted at the SQL level: postgres.js does not open a
// connection until a query actually runs, and drizzle's .toSQL() only builds
// the statement, so no live DB is needed here.
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://loa:loa@localhost:5432/loa';

// Import lazily so the dummy DATABASE_URL is in place first.
let buildVolumeQuery: typeof import('./queries.js').buildVolumeQuery;
let campaignDeleteStatements: typeof import('./queries.js').campaignDeleteStatements;
let buildErrorEventsQuery: typeof import('./queries.js').buildErrorEventsQuery;
let buildFailedActionsQuery: typeof import('./queries.js').buildFailedActionsQuery;
let db: typeof import('./db.js').db;

beforeAll(async () => {
  ({ buildVolumeQuery, campaignDeleteStatements, buildErrorEventsQuery, buildFailedActionsQuery } =
    await import('./queries.js'));
  ({ db } = await import('./db.js'));
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

describe('campaignDeleteStatements', () => {
  const id = '22222222-2222-2222-2222-222222222222';

  it('clears dependents before the campaign, in FK-safe order', () => {
    const tables = campaignDeleteStatements(db, id).map((stmt) => {
      const sql = stmt.toSQL().sql;
      const match = /delete from "([a-z_]+)"/.exec(sql);
      return match?.[1];
    });
    expect(tables).toEqual([
      'target_progress',
      'actions',
      'messages',
      'targets',
      'campaign_steps',
      'campaigns',
    ]);
  });

  it('deletes messages via the campaign targets subquery', () => {
    const [, , messagesDelete] = campaignDeleteStatements(db, id);
    const { sql, params } = messagesDelete.toSQL();
    // messages have no campaign_id; they are removed by target_id in (targets of this campaign).
    expect(sql).toContain('"messages"');
    expect(sql).toMatch(/"target_id" in \(select .* from "targets"/i);
    expect(params).toContain(id);
  });

  it('scopes every dependent delete to the campaign id', () => {
    for (const stmt of campaignDeleteStatements(db, id)) {
      expect(stmt.toSQL().params).toContain(id);
    }
  });
});

describe('buildErrorEventsQuery', () => {
  it('filters events to failure-ish kinds by suffix with an escaped underscore', () => {
    const { sql, params } = buildErrorEventsQuery(24).toSQL();
    expect(sql).toContain('"events"');
    // Both shared suffixes become escaped LIKE patterns (underscore is a wildcard).
    expect(sql).toContain('LIKE');
    expect(sql).toContain("ESCAPE '\\'");
    expect(params).toContain('%\\_failed');
    expect(params).toContain('%\\_cancelled');
  });

  it('pulls campaign/target context out of the jsonb payload', () => {
    const { sql } = buildErrorEventsQuery(24).toSQL();
    expect(sql).toContain("->>'campaignId'");
    expect(sql).toContain("->>'targetId'");
  });

  it('honors the hours lookback in the interval expression', () => {
    const { params } = buildErrorEventsQuery(72).toSQL();
    expect(params).toContain(72);
  });
});

describe('buildFailedActionsQuery', () => {
  it('filters actions to result=failed within the window', () => {
    const { sql, params } = buildFailedActionsQuery(24).toSQL();
    expect(sql).toContain('"actions"');
    // result='failed' is a bound param.
    expect(params).toContain('failed');
    expect(params).toContain(24);
    // Windowed by executed-else-scheduled time.
    expect(sql).toContain('coalesce');
  });
});
