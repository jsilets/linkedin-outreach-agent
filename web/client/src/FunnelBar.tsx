import { PROGRESS_ORDER, statusLabel, statusVar } from './status';

type Counts = Record<string, number>;

// Order a counts map along the pipeline, dropping empty buckets. Any key not in
// PROGRESS_ORDER (shouldn't happen, but be safe) is appended at the end.
function ordered(counts: Counts): Array<[string, number]> {
  counts = counts ?? {};
  const known = PROGRESS_ORDER.filter((k) => (counts[k] ?? 0) > 0).map(
    (k) => [k, counts[k]!] as [string, number],
  );
  const extra = Object.entries(counts).filter(
    ([k, n]) => n > 0 && !PROGRESS_ORDER.includes(k as (typeof PROGRESS_ORDER)[number]),
  );
  return [...known, ...extra];
}

/**
 * The pipeline as proportional, clickable segments. Segment width tracks its
 * share of the total, so the shape of the funnel is legible at a glance; the
 * amber "Needs approval" segment is the one you're meant to act on. Clicking a
 * segment toggles a filter reported via onSelect.
 */
export function FunnelBar({
  counts,
  selected = null,
  onSelect,
}: {
  counts: Counts;
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const entries = ordered(counts);
  if (entries.length === 0) return <div className="empty">No enrolled leads yet.</div>;

  return (
    <div className="funnel-bar">
      {entries.map(([key, n]) => {
        const on = selected === key;
        const dim = selected !== null && !on;
        const cls = `seg${on ? ' active' : ''}${dim ? ' muted-seg' : ''}`;
        const style = { ['--c' as string]: statusVar(key), flexGrow: n };
        const inner = (
          <>
            <span className="seg-n">{n}</span>
            <span className="seg-label">{statusLabel(key)}</span>
          </>
        );
        // Interactive when a handler is given; a static segment otherwise.
        return onSelect ? (
          <button
            key={key}
            type="button"
            className={cls}
            style={style}
            onClick={() => onSelect(on ? null : key)}
            aria-pressed={on}
          >
            {inner}
          </button>
        ) : (
          <div key={key} className={cls} style={{ ...style, cursor: 'default' }}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** A single thin proportional strip — the funnel compressed to a card row. */
export function MiniFunnel({ counts }: { counts: Counts }) {
  const entries = ordered(counts);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (total === 0) return <div className="mini-funnel" aria-hidden />;
  return (
    <div className="mini-funnel" role="img" aria-label="Pipeline breakdown">
      {entries.map(([key, n]) => (
        <span
          key={key}
          className="mseg"
          style={{ background: statusVar(key), width: `${(n / total) * 100}%` }}
          title={`${statusLabel(key)}: ${n}`}
        />
      ))}
    </div>
  );
}
