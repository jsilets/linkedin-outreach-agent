// BrowserContextFactory. Builds the launch config for a per-account persistent
// context: proxy binding, timezone/locale/geo coherence to the proxy's city,
// and leak-guard flags (WebRTC/DNS/IPv6). The actual patchright launch is
// injected as a port so tests assert on the produced config without a browser.

import type {
  BrowserContextPort,
  BrowserLauncherPort,
} from '../ports.js';

/** Coherent identity for a proxy exit: everything that must line up geo-wise. */
export interface ProxyIdentity {
  /** Proxy server URL, e.g. http://gw.example.com:7000 */
  server: string;
  username?: string;
  password?: string;
  /** IANA timezone matching the exit city, e.g. America/New_York. */
  timezoneId: string;
  /** BCP-47 locale matching the exit region, e.g. en-US. */
  locale: string;
  /** Geolocation matching the exit city. */
  geolocation: { latitude: number; longitude: number; accuracy?: number };
}

/** Input to build a launch config for one account. */
export interface LaunchConfigInput {
  /** Persistent profile directory, unique per account. */
  userDataDir: string;
  identity: ProxyIdentity;
  headless?: boolean;
  /** Browser distribution channel; default "chromium" (new headless). */
  channel?: string;
}

/** The fully-resolved options object passed to launchPersistentContext. */
export interface ResolvedLaunchConfig {
  userDataDir: string;
  options: {
    headless: boolean;
    channel: string;
    proxy: { server: string; username?: string; password?: string };
    timezoneId: string;
    locale: string;
    geolocation: { latitude: number; longitude: number; accuracy: number };
    permissions: string[];
    args: string[];
  };
}

// Chromium flags that stop IP/DNS leaks around a proxy. WebRTC is the big one:
// without this it can reveal the real local IP even behind a proxy.
const LEAK_GUARD_ARGS: readonly string[] = [
  // Force WebRTC to only use the proxied public interface.
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  // Route DNS through the proxy, never leak lookups to the local resolver.
  '--proxy-server-uses-tcp',
  // Disable IPv6 so traffic cannot bypass an IPv4-only proxy.
  '--disable-ipv6',
  // Reduce automation fingerprints.
  '--disable-blink-features=AutomationControlled',
];

/**
 * Build the launch config for one account. Pure function: no browser touched,
 * so tests assert on the returned object directly.
 */
export function buildLaunchConfig(input: LaunchConfigInput): ResolvedLaunchConfig {
  const { userDataDir, identity } = input;
  return {
    userDataDir,
    options: {
      headless: input.headless ?? true,
      channel: input.channel ?? 'chromium',
      proxy: {
        server: identity.server,
        ...(identity.username ? { username: identity.username } : {}),
        ...(identity.password ? { password: identity.password } : {}),
      },
      timezoneId: identity.timezoneId,
      locale: identity.locale,
      geolocation: {
        latitude: identity.geolocation.latitude,
        longitude: identity.geolocation.longitude,
        accuracy: identity.geolocation.accuracy ?? 50,
      },
      // Granting geolocation keeps the browser from prompting and keeps geo
      // coherent with the proxy city.
      permissions: ['geolocation'],
      args: [...LEAK_GUARD_ARGS],
    },
  };
}

/**
 * BrowserContextFactory wraps a launcher port. It resolves the config and calls
 * launchPersistentContext. The launcher is injected (patchright.chromium in
 * production, a fake in tests).
 */
export class BrowserContextFactory {
  constructor(private readonly launcher: BrowserLauncherPort) {}

  /** Resolve config without launching (handy for pre-flight and tests). */
  resolve(input: LaunchConfigInput): ResolvedLaunchConfig {
    return buildLaunchConfig(input);
  }

  /** Resolve config and launch a persistent context for the account. */
  async launch(input: LaunchConfigInput): Promise<{
    context: BrowserContextPort;
    config: ResolvedLaunchConfig;
  }> {
    const config = buildLaunchConfig(input);
    const context = await this.launcher.launchPersistentContext(
      config.userDataDir,
      config.options,
    );
    return { context, config };
  }
}
