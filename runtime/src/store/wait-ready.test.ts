import { describe, expect, it } from 'vitest';
import { isConnectionError, waitForStoreReady } from './wait-ready.js';

const noSleep = async (): Promise<void> => {};

describe('isConnectionError', () => {
  it('recognizes ECONNREFUSED wrapped by drizzle/postgres (cause -> AggregateError)', () => {
    // The shape the runtime actually logged on a boot race.
    const err = Object.assign(new Error('Failed query: select ... from "accounts"'), {
      cause: Object.assign(new Error('aggregate'), {
        errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }],
      }),
    });
    expect(isConnectionError(err)).toBe(true);
  });

  it('recognizes a top-level code and the Postgres starting-up code', () => {
    expect(isConnectionError({ code: 'ECONNRESET' })).toBe(true);
    expect(isConnectionError({ code: '57P03' })).toBe(true);
  });

  it('recognizes a plain ECONNREFUSED message', () => {
    expect(isConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
  });

  it('does NOT treat a real query/logic error as a connection error', () => {
    expect(isConnectionError(new Error('column "foo" does not exist'))).toBe(false);
    expect(isConnectionError({ code: '42P01' })).toBe(false); // undefined_table
  });
});

describe('waitForStoreReady', () => {
  it('returns once the probe succeeds after transient connection failures', async () => {
    let calls = 0;
    await waitForStoreReady(
      async () => {
        calls += 1;
        if (calls < 3) throw { code: 'ECONNREFUSED' };
        return [];
      },
      { sleep: noSleep },
    );
    expect(calls).toBe(3);
  });

  it('rethrows a non-connection error immediately (no retry)', async () => {
    let calls = 0;
    await expect(
      waitForStoreReady(
        async () => {
          calls += 1;
          throw new Error('column "foo" does not exist');
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/does not exist/);
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget so the supervisor can respawn', async () => {
    let calls = 0;
    await expect(
      waitForStoreReady(
        async () => {
          calls += 1;
          throw { code: 'ECONNREFUSED' };
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(calls).toBe(4);
  });
});
