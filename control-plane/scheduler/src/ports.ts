// Ports the scheduler depends on. The real implementations (SafetyGate, a
// deterministic RNG) are injected so the scheduler stays pure and testable.
// We deliberately do NOT import @loa/safety here; we depend on this local
// subset of its surface and let the wiring layer supply the concrete gate.

import type { Account, Action, DailyBudget, Decision } from '@loa/shared';

/**
 * Subset of SafetyGate the scheduler needs. The concrete DefaultSafetyGate
 * satisfies this structurally, so it can be passed straight in.
 */
export interface SafetyPort {
  canAct(acct: Account, action: Action): Decision;
  budget(acct: Account): DailyBudget;
}

/**
 * Deterministic RNG seam. Must return a float in [0, 1). Tests pass a seeded
 * generator so jitter and spread are reproducible; production passes Math.random.
 */
export type Rng = () => number;

/** A simple mulberry32 PRNG. Deterministic given a seed; good enough for jitter. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
