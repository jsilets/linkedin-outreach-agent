import { useState } from 'react';
import { api, CAMPAIGN_STEP_TYPES, type CampaignStepType, type Step } from './api';
import { cumulativeDays, funnelLabel, funnelWhen, STEP_LABELS } from './format';

interface Props {
  campaignId: string;
  initial: Step[];
}

function blankStep(order: number): Step {
  return {
    stepOrder: order,
    stepType: 'view_profile',
    delaySeconds: 0,
    note: null,
    body: null,
    reaction: null,
    enabled: true,
  };
}

export function FlowEditor({ campaignId, initial }: Props) {
  const [steps, setSteps] = useState<Step[]>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function mutate(next: Step[]) {
    setSteps(next.map((s, i) => ({ ...s, stepOrder: i })));
    setSaved(false);
  }

  function update(i: number, patch: Partial<Step>) {
    mutate(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    mutate(next);
  }

  function remove(i: number) {
    mutate(steps.filter((_, idx) => idx !== i));
  }

  function add() {
    mutate([...steps, blankStep(steps.length)]);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const returned = await api.saveSteps(campaignId, steps);
      mutate(returned);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const days = cumulativeDays(steps);
  const firstEnabled = steps.findIndex((s) => s.enabled);
  const anchorIsConnect = firstEnabled >= 0 && steps[firstEnabled]?.stepType === 'connect';

  return (
    <div>
      <div className="funnel">
        {steps.length === 0 && <span className="muted">No steps yet.</span>}
        {steps.map((s, i) => {
          const act = s.stepType === 'delay' ? 'Wait' : STEP_LABELS[s.stepType];
          const when = funnelWhen(s, days[i] ?? null);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps lack a stable id until saved; index key matches existing reorder/save identity behavior.
            <span key={i} style={{ display: 'contents' }}>
              {i > 0 && (
                <span className="arrow" aria-hidden="true">
                  →
                </span>
              )}
              <span
                className={`node${s.enabled ? '' : ' node-off'}`}
                title={funnelLabel(s, days[i] ?? null)}
              >
                <span className="node-act">{act}</span>
                {when && <span className="node-when">{when}</span>}
              </span>
            </span>
          );
        })}
      </div>

      <p className="flow-note">
        Timing is approximate. Each step sends the next working-day morning and skips days off, so
        the day numbers are estimates, not exact 24-hour offsets.
      </p>

      <div className="steps">
        {steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps lack a stable id until saved; index key matches existing reorder/save identity behavior.
          <div className={`step${step.enabled ? '' : ' disabled'}`} key={i}>
            <div className="step-head">
              <span className="order">{i + 1}</span>
              <select
                value={step.stepType}
                onChange={(e) => update(i, { stepType: e.target.value as CampaignStepType })}
              >
                {CAMPAIGN_STEP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {STEP_LABELS[t]}
                  </option>
                ))}
              </select>
              <span className="spacer" />
              <label className="muted" style={{ display: 'flex', gap: 4, width: 'auto' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={step.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
                enabled
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn icon"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn icon"
                  onClick={() => move(i, 1)}
                  disabled={i === steps.length - 1}
                >
                  ↓
                </button>
                <button type="button" className="btn icon" onClick={() => remove(i)}>
                  ✕
                </button>
              </div>
            </div>
            <div className="step-body grid">
              <StepFields
                step={step}
                day={days[i] ?? null}
                isAnchor={i === firstEnabled}
                anchorIsConnect={anchorIsConnect}
                onChange={(patch) => update(i, patch)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="toolbar">
        <button type="button" className="btn ghost" onClick={add}>
          + Add step
        </button>
        <span className="spacer" />
        {saved && <span className="saved">Saved</span>}
        <button type="button" className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save flow'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// The one-line preview under the delay field: when this step actually lands,
// stated in cumulative days from the anchor (day 0). Kept honest about the
// working-morning rounding.
function timingHint(
  step: Step,
  day: number | null,
  isAnchor: boolean,
  anchorIsConnect: boolean,
): string {
  if (!step.enabled) return 'Disabled: skipped, and does not affect the timing below.';
  if (day === null) return '';
  if (step.stepType === 'delay') return `Advances the clock to ~day ${day}.`;
  if (isAnchor) {
    return day <= 0 ? 'Runs first, on day 0.' : `Runs first, ~day ${day} (next working morning).`;
  }
  const after = anchorIsConnect ? ' after connecting' : '';
  return `Sends ~day ${day}${after} (next working morning).`;
}

function StepFields({
  step,
  day,
  isAnchor,
  anchorIsConnect,
  onChange,
}: {
  step: Step;
  day: number | null;
  isAnchor: boolean;
  anchorIsConnect: boolean;
  onChange: (p: Partial<Step>) => void;
}) {
  const hint = timingHint(step, day, isAnchor, anchorIsConnect);
  const delayLabel = isAnchor
    ? step.stepType === 'connect'
      ? 'Wait before sending the invite'
      : 'Wait before the first step'
    : 'Wait after previous step';
  const delayField = (
    <div>
      <label>{delayLabel}</label>
      <DelayInput seconds={step.delaySeconds} onChange={(s) => onChange({ delaySeconds: s })} />
      {hint && <p className="step-hint">{hint}</p>}
    </div>
  );

  if (step.stepType === 'delay') {
    return (
      <div>
        <label>Wait duration</label>
        <DelayInput seconds={step.delaySeconds} onChange={(s) => onChange({ delaySeconds: s })} />
        {hint && <p className="step-hint">{hint}</p>}
      </div>
    );
  }
  if (step.stepType === 'connect') {
    return (
      <>
        {delayField}
        <div>
          <label>Connection note (optional)</label>
          <textarea
            value={step.note ?? ''}
            onChange={(e) => onChange({ note: e.target.value })}
            placeholder="Short note sent with the invite"
          />
        </div>
      </>
    );
  }
  if (step.stepType === 'message') {
    return (
      <>
        {delayField}
        <div>
          <label>Message body</label>
          <textarea value={step.body ?? ''} onChange={(e) => onChange({ body: e.target.value })} />
        </div>
      </>
    );
  }
  if (step.stepType === 'react') {
    return (
      <>
        {delayField}
        <div>
          <label>Reaction (defaults to LIKE)</label>
          <input
            value={step.reaction ?? ''}
            onChange={(e) => onChange({ reaction: e.target.value })}
            placeholder="LIKE, CELEBRATE, SUPPORT, ..."
          />
        </div>
      </>
    );
  }
  // view_profile, follow
  return delayField;
}

// Edit a delay as days/hours/minutes, stored as seconds.
function DelayInput({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  function set(nd: number, nh: number, nm: number) {
    onChange(nd * 86400 + nh * 3600 + nm * 60);
  }
  const box = { width: 70, display: 'inline-block' as const };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="number"
        min={0}
        style={box}
        value={d}
        onChange={(e) => set(+e.target.value, h, m)}
      />
      <span className="muted">d</span>
      <input
        type="number"
        min={0}
        style={box}
        value={h}
        onChange={(e) => set(d, +e.target.value, m)}
      />
      <span className="muted">h</span>
      <input
        type="number"
        min={0}
        style={box}
        value={m}
        onChange={(e) => set(d, h, +e.target.value)}
      />
      <span className="muted">m</span>
    </div>
  );
}
