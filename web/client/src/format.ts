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
