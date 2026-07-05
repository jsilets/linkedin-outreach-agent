// Human-like pacing helpers. Randomized gaps and typing cadence so the runner
// does not act at machine speed. Public rate-limit lore: keep 8-20s between
// discrete actions and vary per-keystroke typing delays.

/** Inclusive random integer in [min, max]. */
export function randInt(min: number, max: number, rng: () => number = Math.random): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** A between-actions gap in ms. Default window is 8-20s. */
export function actionGapMs(rng: () => number = Math.random): number {
  return randInt(8000, 20000, rng);
}

/** A per-keystroke typing delay in ms; realistic human cadence. */
export function typingDelayMs(rng: () => number = Math.random): number {
  return randInt(40, 160, rng);
}

/** A short pre-click hover/settle delay in ms. */
export function clickDelayMs(rng: () => number = Math.random): number {
  return randInt(60, 240, rng);
}

/** Sleep helper. Injectable so tests can stub it and not actually wait. */
export type Sleeper = (ms: number) => Promise<void>;

export const realSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
