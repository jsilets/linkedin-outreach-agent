import { describe, it, expect } from 'vitest';
import { FakePage } from './fakes.js';

describe('FakePage.waitForResponse', () => {
  it('returns a preloaded canned response for a matching substring', async () => {
    const page = new FakePage();
    page.preloadResponse('voyagerSearchDashClusters', { hello: 'world' });
    const res = await page.waitForResponse('voyagerSearchDashClusters');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'world' });
    expect(page.responseWaits).toContain('voyagerSearchDashClusters');
  });

  it('drains a FIFO queue for successive pages, reusing the last', async () => {
    const page = new FakePage();
    page.preloadResponse('search', { page: 1 });
    page.preloadResponse('search', { page: 2 });
    expect(await (await page.waitForResponse('search')).json()).toEqual({ page: 1 });
    expect(await (await page.waitForResponse('search')).json()).toEqual({ page: 2 });
    // Queue drained to one; the last payload is reused rather than throwing.
    expect(await (await page.waitForResponse('search')).json()).toEqual({ page: 2 });
  });

  it('throws when nothing is preloaded for the substring', async () => {
    const page = new FakePage();
    await expect(page.waitForResponse('missing')).rejects.toThrow(/no canned response/);
  });
});
