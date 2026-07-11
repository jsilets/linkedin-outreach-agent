import type { Step, CampaignStepType } from './api';

export const STEP_LABELS: Record<CampaignStepType, string> = {
  view_profile: 'View profile',
  connect: 'Connect',
  message: 'Message',
  follow: 'Follow',
  react: 'React',
  delay: 'Delay',
};

// Render a delay in seconds as a short, readable duration.
export function formatDelay(seconds: number): string {
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

// A one-line funnel label for a step, e.g. "Wait 2d" or "Connect".
export function funnelLabel(step: Step): string {
  if (step.stepType === 'delay') return `Wait ${formatDelay(step.delaySeconds)}`;
  const base = STEP_LABELS[step.stepType];
  if (step.delaySeconds > 0) return `${base} (+${formatDelay(step.delaySeconds)})`;
  return base;
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
