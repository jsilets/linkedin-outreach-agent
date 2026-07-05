import { describe, it, expect } from 'vitest';
import { scanPage, acceptanceSignal, geoDriftSignal } from './index.js';
import { SELECTORS } from '../selectors.js';
import { FakePage } from '../testing/fakes.js';

describe('scanPage restriction signals', () => {
  it('emits a velocity signal for the weekly-limit popup', async () => {
    const page = new FakePage({
      counts: {
        [SELECTORS.weeklyLimitAlert]: 1,
        [SELECTORS.viewLimitWarning]: 0,
        [SELECTORS.challengeContainer]: 0,
        [SELECTORS.banBanner]: 0,
      },
    });
    const signals = await scanPage(page);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe('velocity');
  });

  it('emits a challenge signal for a checkpoint container', async () => {
    const page = new FakePage({
      counts: {
        [SELECTORS.weeklyLimitAlert]: 0,
        [SELECTORS.viewLimitWarning]: 0,
        [SELECTORS.challengeContainer]: 1,
        [SELECTORS.banBanner]: 0,
      },
    });
    const signals = await scanPage(page);
    expect(signals.map((s) => s.kind)).toEqual(['challenge']);
  });

  it('emits a ban_banner signal for a restriction banner', async () => {
    const page = new FakePage({
      counts: {
        [SELECTORS.weeklyLimitAlert]: 0,
        [SELECTORS.viewLimitWarning]: 0,
        [SELECTORS.challengeContainer]: 0,
        [SELECTORS.banBanner]: 1,
      },
    });
    const signals = await scanPage(page);
    expect(signals.map((s) => s.kind)).toEqual(['ban_banner']);
  });

  it('emits nothing on a clean page', async () => {
    const page = new FakePage({
      counts: {
        [SELECTORS.weeklyLimitAlert]: 0,
        [SELECTORS.viewLimitWarning]: 0,
        [SELECTORS.challengeContainer]: 0,
        [SELECTORS.banBanner]: 0,
      },
    });
    expect(await scanPage(page)).toHaveLength(0);
  });
});

describe('acceptanceSignal', () => {
  it('raises low_acceptance under 35%', () => {
    const sig = acceptanceSignal({ invitesSent: 100, invitesAccepted: 20 });
    expect(sig?.kind).toBe('low_acceptance');
    expect(sig?.magnitude).toBeCloseTo(0.2);
  });

  it('stays silent at or above 35%', () => {
    expect(acceptanceSignal({ invitesSent: 100, invitesAccepted: 40 })).toBeNull();
    expect(acceptanceSignal({ invitesSent: 100, invitesAccepted: 35 })).toBeNull();
  });

  it('stays silent below the minimum volume', () => {
    expect(acceptanceSignal({ invitesSent: 5, invitesAccepted: 0 })).toBeNull();
  });
});

describe('geoDriftSignal', () => {
  it('raises when regions differ', () => {
    expect(geoDriftSignal('us-east', 'eu-west')?.kind).toBe('geo_drift');
  });
  it('silent when regions match', () => {
    expect(geoDriftSignal('us-east', 'us-east')).toBeNull();
  });
});
