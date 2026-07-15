// No component-test setup exists in this workspace (no jsdom/testing-library),
// so the pause toggle is pinned on the pure helpers the view delegates to: the
// copy that names the consequence, and the write/reload outcome it renders.
import { describe, expect, it, vi } from 'vitest';
import { pauseStatusCopy, resumeConfirmCopy } from './AccountsView';
import { runWriteAction } from './writeAction';

describe('pauseStatusCopy', () => {
  it('stays quiet while sending is active', () => {
    // Nothing is held, so there is nothing to warn about.
    expect(pauseStatusCopy(false, 0)).toBe('Sending is active.');
    expect(pauseStatusCopy(false, 11)).toBe('Sending is active.');
  });

  it('names what a pause is holding', () => {
    expect(pauseStatusCopy(true, 11)).toBe(
      'Sending is paused. 11 approved messages are waiting and will not go out.',
    );
  });

  it('reads naturally for a single held message', () => {
    expect(pauseStatusCopy(true, 1)).toBe(
      'Sending is paused. 1 approved message is waiting and will not go out.',
    );
  });

  it('does not claim a queue when nothing is approved', () => {
    expect(pauseStatusCopy(true, 0)).toBe('Sending is paused. Nothing is approved and waiting.');
  });

  it('never renders an awkward plural', () => {
    for (const n of [0, 1, 2, 11]) {
      expect(pauseStatusCopy(true, n)).not.toMatch(/\b1 approved messages\b/);
      expect(pauseStatusCopy(true, n)).not.toMatch(/\bmessage\(s\)\b/);
    }
  });
});

describe('resumeConfirmCopy', () => {
  it('names the real count before releasing a queue', () => {
    // The count is the whole point of the confirm: it is what resume sends to
    // real people, and it cannot be undone.
    const copy = resumeConfirmCopy(11);
    expect(copy).toContain('11 approved messages');
    expect(copy).toContain('4-10 minutes');
  });

  it('drops the pacing rate for a single message', () => {
    // "roughly one every 4-10 minutes" is meaningless for one message.
    const copy = resumeConfirmCopy(1);
    expect(copy).toBe('Resume sending? 1 approved message will begin going out.');
    expect(copy).not.toContain('4-10 minutes');
  });

  it('does not promise a send when nothing is approved', () => {
    const copy = resumeConfirmCopy(0);
    expect(copy).not.toMatch(/\b0 approved\b/);
    expect(copy).toContain('Nothing is approved right now');
  });

  it('always asks rather than announces', () => {
    for (const n of [0, 1, 2, 11]) {
      expect(resumeConfirmCopy(n)).toMatch(/^Resume sending\?/);
    }
  });
});

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
