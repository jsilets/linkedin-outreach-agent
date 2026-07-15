// No component-test setup exists in this workspace (no jsdom/testing-library),
// so the write/reload outcome helper is pinned here at unit level.
import { describe, expect, it, vi } from 'vitest';
import { runWriteAction } from './writeAction';

describe('runWriteAction', () => {
  const notices = { failure: 'Could not resume sending.', stale: 'stale notice' };

  it('reports done when the write and the reload both land', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    expect(await runWriteAction(vi.fn().mockResolvedValue(undefined), reload, notices)).toEqual({
      phase: 'done',
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reports a failed write as an error, and does not reload', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const outcome = await runWriteAction(
      vi.fn().mockRejectedValue(new Error('mcp upstream unavailable.')),
      reload,
      notices,
    );
    expect(outcome).toEqual({ phase: 'error', notice: 'mcp upstream unavailable.' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('falls back to the failure notice when the write throws a non-Error', async () => {
    expect(await runWriteAction(() => Promise.reject('boom'), vi.fn(), notices)).toEqual({
      phase: 'error',
      notice: 'Could not resume sending.',
    });
  });

  it('does NOT report a succeeded write as an error when only the reload fails', async () => {
    // The regression this exists for: one try/catch around both made a failed
    // re-read look like a failed write and invited a second click — which for a
    // resume is a second release of real messages to real people.
    const act = vi.fn().mockResolvedValue(undefined);
    const outcome = await runWriteAction(act, vi.fn().mockRejectedValue(new Error('500')), notices);
    expect(outcome).toEqual({ phase: 'stale', notice: 'stale notice' });
    expect(act).toHaveBeenCalledOnce();
  });

  it('keeps the reload error out of the stale notice', async () => {
    // The reload's message describes the read, not the write: surfacing it would
    // read as though the resume itself failed.
    const outcome = await runWriteAction(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockRejectedValue(new Error('Request failed (500).')),
      notices,
    );
    expect(outcome).toMatchObject({ phase: 'stale' });
    expect(JSON.stringify(outcome)).not.toContain('Request failed');
  });
});
