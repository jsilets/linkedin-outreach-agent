import { describe, expect, it } from 'vitest';
import { KNOWN_CITIES, resolveProxyIdentity } from './proxy-identity.js';

describe('resolveProxyIdentity', () => {
  it('returns undefined when PROXY_URL is unset', () => {
    expect(resolveProxyIdentity({})).toBeUndefined();
  });

  it('lets explicit env overrides win over the city table', () => {
    const identity = resolveProxyIdentity({
      PROXY_URL: 'http://gw.proxy.example:7000',
      // PROXY_CITY says new_york, but explicit overrides should win.
      PROXY_CITY: 'new_york',
      PROXY_TIMEZONE: 'Europe/Paris',
      PROXY_LOCALE: 'fr-FR',
      PROXY_LAT: '48.8566',
      PROXY_LNG: '2.3522',
    });
    expect(identity).toEqual({
      server: 'http://gw.proxy.example:7000',
      timezoneId: 'Europe/Paris',
      locale: 'fr-FR',
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
    });
  });

  it('resolves new_york from the city table', () => {
    const identity = resolveProxyIdentity({
      PROXY_URL: 'http://gw.proxy.example:7000',
      PROXY_CITY: 'new_york',
    });
    expect(identity?.timezoneId).toBe('America/New_York');
    expect(identity?.locale).toBe('en-US');
    expect(identity?.geolocation.latitude).toBeCloseTo(40.7128);
  });

  it('resolves london from the city table with en-GB', () => {
    const identity = resolveProxyIdentity({
      PROXY_URL: 'http://gw.proxy.example:7000',
      PROXY_CITY: 'london',
    });
    expect(identity?.timezoneId).toBe('Europe/London');
    expect(identity?.locale).toBe('en-GB');
    expect(identity?.geolocation.longitude).toBeCloseTo(-0.1278);
  });

  it('looks up the city key case-insensitively', () => {
    const identity = resolveProxyIdentity({
      PROXY_URL: 'http://gw.proxy.example:7000',
      PROXY_CITY: '  New_York  ',
    });
    expect(identity?.timezoneId).toBe('America/New_York');
  });

  it('throws when PROXY_URL is set but city is unknown and no overrides', () => {
    expect(() =>
      resolveProxyIdentity({
        PROXY_URL: 'http://gw.proxy.example:7000',
        PROXY_CITY: 'atlantis',
      }),
    ).toThrow(/could not be resolved/);
  });

  it('throws when PROXY_URL is set but no city and no overrides', () => {
    let message = '';
    try {
      resolveProxyIdentity({ PROXY_URL: 'http://gw.proxy.example:7000' });
    } catch (err) {
      message = (err as Error).message;
    }
    // Error lists both resolution options and the known cities.
    expect(message).toContain('PROXY_TIMEZONE');
    expect(message).toContain('PROXY_CITY');
    for (const city of KNOWN_CITIES) {
      expect(message).toContain(city);
    }
  });

  it('omits username and password when absent', () => {
    const identity = resolveProxyIdentity({
      PROXY_URL: 'http://gw.proxy.example:7000',
      PROXY_CITY: 'new_york',
    });
    expect(identity).not.toHaveProperty('username');
    expect(identity).not.toHaveProperty('password');
  });

  it('includes username and password when present', () => {
    const identity = resolveProxyIdentity({
      PROXY_URL: 'http://gw.proxy.example:7000',
      PROXY_USERNAME: 'user',
      PROXY_PASSWORD: 'pass',
      PROXY_CITY: 'london',
    });
    expect(identity?.username).toBe('user');
    expect(identity?.password).toBe('pass');
  });
});
