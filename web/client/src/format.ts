import type { CampaignStepType, Step } from './api';

export const STEP_LABELS: Record<CampaignStepType, string> = {
  view_profile: 'View profile',
  connect: 'Connect',
  message: 'Message',
  follow: 'Follow',
  react: 'React',
  delay: 'Delay',
};

// Render a delay in seconds as a short, readable duration.
function formatDelay(seconds: number): string {
  if (seconds <= 0) return 'no wait';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

// The cumulative day each step lands on, indexed to `steps`. delaySeconds is the
// gap AFTER the previous enabled step, so the running sum from the first enabled
// step is the day a step actually runs — the first enabled step is the anchor
// (day 0). Disabled steps are skipped: they get `null` and don't advance the
// clock. Days are rounded because sends land the next working morning, so the
// number is approximate, not an exact 24h offset.
export function cumulativeDays(steps: Step[]): (number | null)[] {
  let seconds = 0;
  return steps.map((step) => {
    if (!step.enabled) return null;
    seconds += Math.max(0, step.delaySeconds);
    return Math.round(seconds / 86400);
  });
}

// The timing tag for a funnel chip: when the step lands, given its cumulative
// `day` from cumulativeDays. A standalone Delay shows its own wait; a disabled
// step (day === null) has no timing. Kept separate from the action word so the
// chip can render the numerals in --font-mono.
export function funnelWhen(step: Step, day: number | null): string {
  if (step.stepType === 'delay') return formatDelay(step.delaySeconds);
  if (day === null) return '';
  return day <= 0 ? 'day 0' : `~day ${day}`;
}

// The full one-line chip label, e.g. "Message · ~day 3". Used as the chip's
// title; the visible chip renders the action and the timing tag separately.
export function funnelLabel(step: Step, day: number | null): string {
  const base = step.stepType === 'delay' ? 'Wait' : STEP_LABELS[step.stepType];
  const when = funnelWhen(step, day);
  return when ? `${base} · ${when}` : base;
}

// Relative time from now, e.g. "in 2h", "3d ago", "just now". Future = "in X",
// past = "X ago". Null-safe for missing timestamps.
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const deltaSec = Math.round((then - Date.now()) / 1000);
  const future = deltaSec >= 0;
  const abs = Math.abs(deltaSec);
  if (abs < 45) return 'just now';
  const mins = Math.round(abs / 60);
  const hours = Math.round(abs / 3600);
  const days = Math.round(abs / 86400);
  let mag: string;
  if (abs < 3600) mag = `${mins}m`;
  else if (abs < 86400) mag = `${hours}h`;
  else mag = `${days}d`;
  return future ? `in ${mag}` : `${mag} ago`;
}

// Absolute short timestamp for hover/detail, e.g. "Jul 10, 21:34".
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
