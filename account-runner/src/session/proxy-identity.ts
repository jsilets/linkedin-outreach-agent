// Proxy-identity resolver. Turns the PROXY_* runtime secrets into a resolved
// ProxyIdentity whose timezone/locale/geolocation are coherent with the proxy
// exit city (see infra/PROXY.md: a mismatched fingerprint is a bot tell).
//
// Geo is resolved in priority order: explicit env overrides first, else a
// PROXY_CITY lookup in a small built-in table of common exit cities. If a
// proxy is configured but no geo can be resolved, we throw rather than launch
// with an incoherent (host-region) fingerprint.

import type { ProxyIdentity } from './context-factory.js';

/** Geo half of a ProxyIdentity: everything that must match the exit city. */
interface CityGeo {
  timezoneId: string;
  locale: string;
  geolocation: { latitude: number; longitude: number };
}

// Built-in table of common proxy exit cities. Keys are lowercase snake_case.
// Locales follow the exit region (en-US for US, en-GB London, nl-NL Amsterdam,
// de-DE Frankfurt, en-CA Toronto); lat/lng are city-center approximations.
const CITY_TABLE: Readonly<Record<string, CityGeo>> = {
  new_york: {
    timezoneId: 'America/New_York',
    locale: 'en-US',
    geolocation: { latitude: 40.7128, longitude: -74.006 },
  },
  los_angeles: {
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
    geolocation: { latitude: 34.0522, longitude: -118.2437 },
  },
  chicago: {
    timezoneId: 'America/Chicago',
    locale: 'en-US',
    geolocation: { latitude: 41.8781, longitude: -87.6298 },
  },
  dallas: {
    timezoneId: 'America/Chicago',
    locale: 'en-US',
    geolocation: { latitude: 32.7767, longitude: -96.797 },
  },
  miami: {
    timezoneId: 'America/New_York',
    locale: 'en-US',
    geolocation: { latitude: 25.7617, longitude: -80.1918 },
  },
  london: {
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
  },
  amsterdam: {
    timezoneId: 'Europe/Amsterdam',
    locale: 'nl-NL',
    geolocation: { latitude: 52.3676, longitude: 4.9041 },
  },
  frankfurt: {
    timezoneId: 'Europe/Berlin',
    locale: 'de-DE',
    geolocation: { latitude: 50.1109, longitude: 8.6821 },
  },
  toronto: {
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    geolocation: { latitude: 43.6532, longitude: -79.3832 },
  },
};

/** Sorted list of known PROXY_CITY keys, for lookups and error messages. */
export const KNOWN_CITIES: readonly string[] = Object.keys(CITY_TABLE).sort();

/** True when every explicit geo override env var is present. */
function hasExplicitGeo(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.PROXY_TIMEZONE && env.PROXY_LOCALE && env.PROXY_LAT && env.PROXY_LNG);
}

/** Resolve the geo half from explicit overrides, else the PROXY_CITY table. */
function resolveGeo(env: NodeJS.ProcessEnv): CityGeo {
  // 1. Explicit overrides win when all four are supplied.
  if (hasExplicitGeo(env)) {
    const latitude = Number(env.PROXY_LAT);
    const longitude = Number(env.PROXY_LNG);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(
        `PROXY_LAT and PROXY_LNG must be numbers, got PROXY_LAT="${env.PROXY_LAT}" PROXY_LNG="${env.PROXY_LNG}".`,
      );
    }
    return {
      // Non-null: hasExplicitGeo guarantees these are set.
      timezoneId: env.PROXY_TIMEZONE!,
      locale: env.PROXY_LOCALE!,
      geolocation: { latitude, longitude },
    };
  }

  // 2. PROXY_CITY lookup (case-insensitive) in the built-in table.
  const cityKey = env.PROXY_CITY?.trim().toLowerCase();
  if (cityKey) {
    const geo = CITY_TABLE[cityKey];
    if (geo) return geo;
  }

  throw new Error(
    'PROXY_URL is set but the proxy exit geo could not be resolved. ' +
      'Supply all of PROXY_TIMEZONE, PROXY_LOCALE, PROXY_LAT, PROXY_LNG, ' +
      `or set PROXY_CITY to a known city (${KNOWN_CITIES.join(', ')}).`,
  );
}

/**
 * Resolve a ProxyIdentity from the environment.
 *
 * Returns undefined when PROXY_URL is unset (no proxy configured). When
 * PROXY_URL is set, geo coherence is resolved from explicit overrides or the
 * PROXY_CITY table; if neither yields a geo, this throws rather than launch
 * with a host-region fingerprint.
 */
export function resolveProxyIdentity(
  env: NodeJS.ProcessEnv = process.env,
): ProxyIdentity | undefined {
  const server = env.PROXY_URL;
  if (!server) return undefined;

  const geo = resolveGeo(env);

  return {
    server,
    ...(env.PROXY_USERNAME ? { username: env.PROXY_USERNAME } : {}),
    ...(env.PROXY_PASSWORD ? { password: env.PROXY_PASSWORD } : {}),
    timezoneId: geo.timezoneId,
    locale: geo.locale,
    geolocation: geo.geolocation,
  };
}
