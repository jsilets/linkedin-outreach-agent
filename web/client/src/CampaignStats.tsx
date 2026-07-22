// The two campaign readouts, shared by the campaign cards, the campaign detail
// header, and the dashboard roll-up: StageFunnel (outcomes — is it working?)
// and WorkBar (progress — how far along, and who holds the next move?). Both
// read the pure derivations in campaignMetrics.ts.

import type { CampaignPerformance } from './api';
import { buildFunnel, summarizeWork, type WorkSummary } from './campaignMetrics';

/**
 * The people-count outcome funnel as four tight rows: label, a proportional bar
 * (width = share of the eligible pool, so the drop-off is a visible shape, not a
 * calculation), then count + conversion rate in tabular mono. Em dash when a
 * denominator is 0, so an unstarted campaign reads honestly.
 */
export function StageFunnel({
  performance,
  eligible,
}: {
  performance: CampaignPerformance | undefined;
  eligible: number;
}) {
  const stages = buildFunnel(performance, eligible);
  return (
    <div className="stage-funnel">
      {stages.map((s) => {
        const share = s.share;
        return (
          <div className="fs-row" key={s.key}>
            <span className="fs-label">{s.label}</span>
            <span className="fs-track" aria-hidden>
              {/* min-width keeps a nonzero count visible even at a sliver share. */}
              <span
                className="fs-fill"
                style={{ width: `${share}%`, minWidth: s.count > 0 ? 3 : 0 }}
              />
            </span>
            <span className="fs-value">
              <span className="fs-n">{s.count}</span>
              <span className="fs-rate">
                {s.rate === null ? '—' : `${s.rate}%`} <span className="fs-of">{s.rateOf}</span>
                {s.sub && <span className="fs-of"> · {s.sub}</span>}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Completion, stated plainly: "X of Y finished · Z%" over a grouped bar whose
 * segments answer "who holds the next move". Every segment carries a hover /
 * focus tooltip with its exact composition, so the thin strip is never mute.
 * Skipped leads are out of the denominator and read as a quiet footnote;
 * failed leads get an explicit count.
 */
export function WorkBar({
  byProgressState,
  targetCount,
}: {
  byProgressState: Record<string, number>;
  targetCount: number;
}) {
  const work = summarizeWork(byProgressState, targetCount);
  return (
    <div className="work">
      <WorkHeadline work={work} />
      <WorkSegments work={work} />
    </div>
  );
}

/** The completion headline alone, for surfaces that already render their own
 * state breakdown (the campaign detail's clickable funnel tiles). */
export function WorkStatusLine({
  byProgressState,
  targetCount,
}: {
  byProgressState: Record<string, number>;
  targetCount: number;
}) {
  return (
    <div className="work">
      <WorkHeadline work={summarizeWork(byProgressState, targetCount)} />
    </div>
  );
}

function WorkHeadline({ work }: { work: WorkSummary }) {
  return (
    <div className="work-head">
      <span className="work-ratio">
        <span className="work-n">
          {work.finished} of {work.eligible}
        </span>{' '}
        leads finished
        {work.finishedPct !== null && <span className="work-pct"> · {work.finishedPct}%</span>}
      </span>
      {work.failed > 0 && (
        <span className="work-flag" style={{ ['--c' as string]: 'var(--st-failed)' }}>
          {work.failed} failed
        </span>
      )}
      {work.skipped > 0 && (
        <span
          className="work-skip"
          title="Skipped leads are removed from the campaign and don't count toward its totals."
        >
          {work.skipped} skipped
        </span>
      )}
    </div>
  );
}

function WorkSegments({ work }: { work: WorkSummary }) {
  if (work.groups.length === 0) {
    return <div className="work-bar work-bar-empty">No enrolled leads yet.</div>;
  }
  return (
    <div
      className="work-bar"
      role="img"
      aria-label={work.groups.map((g) => `${g.label}: ${g.count}`).join(', ')}
    >
      {work.groups.map((g) => (
        <span
          key={g.key}
          className="wseg"
          tabIndex={0}
          style={{ ['--c' as string]: `var(${g.varName})`, flexGrow: g.count }}
        >
          <span className="wseg-pop" role="tooltip">
            <span className="wseg-pop-head">
              {g.label} · {g.count}
            </span>
            <span className="wseg-pop-detail">{g.detail}</span>
            {(g.parts.length > 1 || g.parts[0]?.label !== g.label) &&
              g.parts.map((p) => (
                <span className="wseg-pop-part" key={p.key}>
                  {p.label}
                  <span className="wseg-pop-n">{p.count}</span>
                </span>
              ))}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Legend chips naming each present group with its count — the compact bar's
 * always-visible key, so the dashboard strip reads without hovering. */
export function WorkLegend({
  byProgressState,
  targetCount,
}: {
  byProgressState: Record<string, number>;
  targetCount: number;
}) {
  const work = summarizeWork(byProgressState, targetCount);
  if (work.groups.length === 0) return null;
  return (
    <div className="work-legend">
      {work.groups.map((g) => (
        <span className="work-legend-item" key={g.key}>
          <span className="swatch" style={{ background: `var(${g.varName})` }} />
          {g.label}
          <span className="work-legend-n">{g.count}</span>
        </span>
      ))}
    </div>
  );
}
