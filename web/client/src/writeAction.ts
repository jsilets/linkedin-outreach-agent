// One shape for "write to the runtime, then re-read": the write and the reload
// are reported separately on purpose. Folding both into one try/catch makes a
// failed reload indistinguishable from a failed write, so the UI reports an
// error for an action the runtime already accepted and invites a second click —
// which for a send is a second real message to a real person.

/** 'stale' means the runtime ACCEPTED the write but the re-read failed: the
 * action must never be offered for retry from that state. */
export type WriteOutcome =
  | { phase: 'done' }
  | { phase: 'stale'; notice: string }
  | { phase: 'error'; notice: string };

export async function runWriteAction(
  act: () => Promise<unknown>,
  reload: () => Promise<unknown>,
  notices: { failure: string; stale: string },
): Promise<WriteOutcome> {
  try {
    await act();
  } catch (err) {
    return { phase: 'error', notice: err instanceof Error ? err.message : notices.failure };
  }
  try {
    await reload();
  } catch {
    return { phase: 'stale', notice: notices.stale };
  }
  return { phase: 'done' };
}
