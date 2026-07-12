import { describe, expect, it } from 'vitest';
import { FakeContext, FakeLauncher, FakePage } from '../testing/fakes.js';
import type { LaunchConfigInput } from './context-factory.js';
import { BrowserContextFactory, buildLaunchConfig } from './context-factory.js';

const input: LaunchConfigInput = {
  userDataDir: '/profiles/acct-1',
  identity: {
    server: 'http://gw.proxy.example:7000',
    username: 'user',
    password: 'pass',
    timezoneId: 'America/New_York',
    locale: 'en-US',
    geolocation: { latitude: 40.7128, longitude: -74.006 },
  },
};

describe('buildLaunchConfig', () => {
  it('sets the proxy from the identity', () => {
    const cfg = buildLaunchConfig(input);
    expect(cfg.options.proxy).toEqual({
      server: 'http://gw.proxy.example:7000',
      username: 'user',
      password: 'pass',
    });
  });

  it('sets timezone, locale, and geo coherent with the proxy city', () => {
    const cfg = buildLaunchConfig(input);
    expect(cfg.options.timezoneId).toBe('America/New_York');
    expect(cfg.options.locale).toBe('en-US');
    expect(cfg.options.geolocation.latitude).toBeCloseTo(40.7128);
    expect(cfg.options.permissions).toContain('geolocation');
  });

  it('includes WebRTC/DNS/IPv6 leak-guard flags', () => {
    const cfg = buildLaunchConfig(input);
    const args = cfg.options.args;
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args).toContain('--disable-ipv6');
    expect(args.some((a) => a.includes('proxy-server-uses-tcp'))).toBe(true);
    expect(args).toContain('--disable-blink-features=AutomationControlled');
  });

  it('defaults to headless chromium channel', () => {
    const cfg = buildLaunchConfig(input);
    expect(cfg.options.headless).toBe(true);
    expect(cfg.options.channel).toBe('chromium');
  });

  it('omits proxy credentials when not provided', () => {
    const cfg = buildLaunchConfig({
      ...input,
      identity: { ...input.identity, username: undefined, password: undefined },
    });
    expect(cfg.options.proxy).toEqual({ server: 'http://gw.proxy.example:7000' });
  });

  it('omits proxy and geo entirely when no identity is given', () => {
    const cfg = buildLaunchConfig({ userDataDir: '/profiles/acct-1' });
    expect(cfg.options.proxy).toBeUndefined();
    expect(cfg.options.timezoneId).toBeUndefined();
    expect(cfg.options.geolocation).toBeUndefined();
    expect(cfg.options.permissions).toEqual([]);
    // Leak-guard flags still apply with no proxy.
    expect(cfg.options.args).toContain('--disable-ipv6');
  });
});

describe('BrowserContextFactory', () => {
  it('passes the resolved config to the launcher', async () => {
    const page = new FakePage();
    const ctx = new FakeContext(page, { cookies: [], origins: [] });
    const launcher = new FakeLauncher(ctx);
    const factory = new BrowserContextFactory(launcher);

    const { config } = await factory.launch(input);
    expect(launcher.lastDir).toBe('/profiles/acct-1');
    expect(launcher.lastOptions?.timezoneId).toBe('America/New_York');
    expect((launcher.lastOptions?.proxy as { server: string }).server).toBe(
      'http://gw.proxy.example:7000',
    );
    expect(config.options.args.length).toBeGreaterThan(0);
  });
});
