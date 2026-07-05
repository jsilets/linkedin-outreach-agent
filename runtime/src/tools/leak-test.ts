// Proxy leak-test: launches a real patchright Chromium through the production
// leak-guard launch options and runs the three assertions from infra/PROXY.md
// ("Verify before trusting an account"):
//
//   1. Reported public IP == proxy exit IP.
//   2. No WebRTC candidate exposes a non-proxy IP.
//   3. DNS resolver geo matches the exit city, not the host region.
//
// We cannot know the expected proxy exit IP programmatically, so check 1 asserts
// the reported IP is public (not a host/private range) and prints it for the
// operator to eyeball against their provider's exit IP. Check 2 is a hard fail
// if any candidate exposes a private/host-looking IP while a proxy is set. Check
// 3 is best-effort and print-only.
//
// This is a standalone ops script. The narrow PagePort in the account-runner
// does NOT expose .evaluate(), which we need for the WebRTC probe and for
// reading fetch results. So instead of going through the port, we reuse the
// production launch OPTIONS (buildLaunchConfig gives us the exact leak-guard
// flags + proxy/geo binding) and hand them straight to patchright's
// chromium.launchPersistentContext — that returns a full Playwright context/page
// with the complete API, including .evaluate().
//
//   COOKIE_VAULT_KEY not required. Proxy env mirrors login.ts:
//   PROXY_URL=... PROXY_USERNAME=... PROXY_PASSWORD=... \
//   PROXY_TIMEZONE=America/New_York PROXY_LOCALE=en-US \
//   PROXY_LAT=40.7128 PROXY_LNG=-74.006 \
//   node --import tsx runtime/src/tools/leak-test.ts
//
// With no PROXY_URL it runs in baseline mode (no proxy) and reports the host IP,
// which is expected to fail check 1's "is this really the proxy?" intent — that
// mode exists to prove the mechanism works locally.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';
import {
  buildLaunchConfig,
  type LaunchConfigInput,
  type ProxyIdentity,
} from '@loa/account-runner';

// The runtime tsconfig deliberately omits the DOM lib (this is a Node package).
// The callbacks passed to page.evaluate run in the browser, not in Node, so the
// browser globals they reference are provided by Chromium at runtime. Declare
// just the handful we use as ambient `any` so this file typechecks without
// pulling the whole DOM lib into the runtime build.
declare const document: any;
declare const RTCPeerConnection: any;
type RTCPeerConnection = any;

/**
 * Build the proxy identity from env, or undefined when no proxy is set.
 * Duplicated from runtime/src/login.ts on purpose (do not import) so the ops
 * script has no coupling to the login CLI.
 */
function identityFromEnv(env: NodeJS.ProcessEnv): ProxyIdentity | undefined {
  if (!env.PROXY_URL) return undefined;
  const tz = env.PROXY_TIMEZONE;
  const locale = env.PROXY_LOCALE;
  const lat = env.PROXY_LAT ? Number(env.PROXY_LAT) : undefined;
  const lng = env.PROXY_LNG ? Number(env.PROXY_LNG) : undefined;
  if (
    !tz ||
    !locale ||
    lat === undefined ||
    lng === undefined ||
    Number.isNaN(lat) ||
    Number.isNaN(lng)
  ) {
    throw new Error(
      'PROXY_URL is set but geo coherence is incomplete. The leak test needs ' +
        'PROXY_TIMEZONE, PROXY_LOCALE, PROXY_LAT and PROXY_LNG matching the exit city.',
    );
  }
  return {
    server: env.PROXY_URL,
    ...(env.PROXY_USERNAME ? { username: env.PROXY_USERNAME } : {}),
    ...(env.PROXY_PASSWORD ? { password: env.PROXY_PASSWORD } : {}),
    timezoneId: tz,
    locale,
    geolocation: { latitude: lat, longitude: lng },
  };
}

/** Is this a private / loopback / link-local / CGNAT (non-public) address? */
function isPrivateOrHostIp(ip: string): boolean {
  const v = ip.trim();
  if (!v) return true;
  // IPv6 loopback / link-local / unique-local.
  if (v === '::1') return true;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  // mDNS obfuscated candidate host — treat as a host identifier, not a public IP.
  if (v.endsWith('.local')) return true;
  const parts = v.split('.');
  if (parts.length !== 4) {
    // Not a dotted IPv4; if it looks like a real global IPv6 leave it to caller,
    // but for our purposes anything non-IPv4 that isn't caught above is "unknown"
    // and we conservatively do not flag it as private.
    return false;
  }
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true;
  return false;
}

/** Extract IP-looking tokens from an ICE candidate SDP string. */
function ipsFromCandidate(candidate: string): string[] {
  const out: string[] = [];
  // IPv4
  const v4 = candidate.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
  if (v4) out.push(...v4);
  // .local mDNS host token (Chromium obfuscation)
  const local = candidate.match(/\b[0-9a-f-]+\.local\b/gi);
  if (local) out.push(...local);
  // IPv6 (rough): sequences of hex groups with colons
  const v6 = candidate.match(/\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}\b/gi);
  if (v6) out.push(...v6);
  return out;
}

type CheckStatus = 'PASS' | 'FAIL' | 'INFO' | 'ERROR';

interface CheckResult {
  status: CheckStatus;
  detail: string;
  [k: string]: unknown;
}

/** page is a full patchright Page; typed loosely since we don't import PW types. */
async function checkPublicIp(page: any, hasProxy: boolean): Promise<CheckResult> {
  try {
    await page.goto('https://api.ipify.org?format=json', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // ipify returns raw JSON as the document body.
    const body: string = await page.evaluate(() => document.body.innerText);
    let ip = '';
    try {
      ip = String(JSON.parse(body).ip ?? '').trim();
    } catch {
      ip = body.trim();
    }
    if (!ip) {
      return { status: 'ERROR', detail: 'no IP returned by ipify', ip: null };
    }
    if (!hasProxy) {
      return {
        status: 'INFO',
        detail: 'baseline (no proxy): this is the host IP',
        ip,
      };
    }
    if (isPrivateOrHostIp(ip)) {
      return {
        status: 'FAIL',
        detail: 'reported public IP is a private/host range — proxy not in effect',
        ip,
      };
    }
    return {
      status: 'PASS',
      detail:
        'reported a public IP; OPERATOR: confirm this equals your proxy exit IP',
      ip,
    };
  } catch (err) {
    return {
      status: 'ERROR',
      detail: `ipify failed: ${err instanceof Error ? err.message : String(err)}`,
      ip: null,
    };
  }
}

async function checkWebRtc(page: any, hasProxy: boolean): Promise<CheckResult> {
  try {
    const candidates: string[] = await page.evaluate(async () => {
      return await new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        let pc: RTCPeerConnection;
        try {
          pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          });
        } catch {
          resolve(seen);
          return;
        }
        pc.onicecandidate = (e: any) => {
          if (e.candidate && e.candidate.candidate) {
            seen.push(e.candidate.candidate);
          }
        };
        try {
          pc.createDataChannel('leak-test');
        } catch {
          /* ignore */
        }
        pc.createOffer()
          .then((offer: any) => pc.setLocalDescription(offer))
          .catch(() => {
            /* ignore */
          });
        // Gather for ~3s then resolve.
        setTimeout(() => {
          try {
            pc.close();
          } catch {
            /* ignore */
          }
          resolve(seen);
        }, 3000);
      });
    });

    const ipSet = new Set<string>();
    for (const c of candidates) {
      for (const ip of ipsFromCandidate(c)) ipSet.add(ip);
    }
    const ips = [...ipSet];
    const hostLeaks = ips.filter((ip) => isPrivateOrHostIp(ip));

    if (!hasProxy) {
      return {
        status: 'INFO',
        detail: 'baseline (no proxy): candidate IPs observed, not asserted',
        candidateIps: ips,
        hostLeaks,
      };
    }
    if (hostLeaks.length > 0) {
      return {
        status: 'FAIL',
        detail: 'WebRTC exposed a non-proxy/host IP — leak guard failed',
        candidateIps: ips,
        hostLeaks,
      };
    }
    return {
      status: 'PASS',
      detail:
        ips.length === 0
          ? 'no ICE candidates gathered (WebRTC blocked by leak guard)'
          : 'no host/private IP among candidates',
      candidateIps: ips,
      hostLeaks,
    };
  } catch (err) {
    return {
      status: 'ERROR',
      detail: `WebRTC probe failed: ${err instanceof Error ? err.message : String(err)}`,
      candidateIps: [],
      hostLeaks: [],
    };
  }
}

async function checkGeo(page: any): Promise<CheckResult> {
  const endpoints = ['https://ipapi.co/json/', 'https://ipwho.is/'];
  for (const url of endpoints) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const body: string = await page.evaluate(() => document.body.innerText);
      const data = JSON.parse(body) as Record<string, unknown>;
      const country =
        data.country_name ?? data.country ?? data.countryCode ?? null;
      const region = data.region ?? data.region_name ?? null;
      const city = data.city ?? null;
      const timezone =
        (typeof data.timezone === 'object' && data.timezone !== null
          ? (data.timezone as Record<string, unknown>).id
          : data.timezone) ?? null;
      return {
        status: 'INFO',
        detail: `geo via ${url}; OPERATOR: confirm this matches the proxy exit city`,
        country,
        region,
        city,
        timezone,
      };
    } catch {
      // try the next endpoint
    }
  }
  return {
    status: 'ERROR',
    detail: 'all geo endpoints failed',
    country: null,
    region: null,
    city: null,
    timezone: null,
  };
}

async function main(): Promise<void> {
  const identity = identityFromEnv(process.env);
  const hasProxy = identity !== undefined;
  const modeLabel = hasProxy
    ? `PROXY (${identity.server})`
    : 'NO PROXY (baseline: expect host IP)';

  console.log(`[leak-test] mode: ${modeLabel}`);

  const userDataDir = join(tmpdir(), 'leak-test-profile');
  const input: LaunchConfigInput = {
    userDataDir,
    headless: false,
    ...(identity ? { identity } : {}),
  };
  // Reuse the exact production leak-guard flags + proxy/geo binding, then launch
  // patchright directly so we get a full-API page (with .evaluate()).
  const { options } = buildLaunchConfig(input);

  const context = await chromium.launchPersistentContext(userDataDir, options as any);
  let publicIp: CheckResult;
  let webrtc: CheckResult;
  let geo: CheckResult;
  try {
    const page = await context.newPage();
    publicIp = await checkPublicIp(page, hasProxy);
    console.log(`[leak-test] check 1 public-ip: ${publicIp.status} — ${publicIp.detail} (${publicIp.ip ?? 'n/a'})`);

    webrtc = await checkWebRtc(page, hasProxy);
    console.log(
      `[leak-test] check 2 webrtc: ${webrtc.status} — ${webrtc.detail} ` +
        `candidates=${JSON.stringify(webrtc.candidateIps)} hostLeaks=${JSON.stringify(webrtc.hostLeaks)}`,
    );

    geo = await checkGeo(page);
    console.log(
      `[leak-test] check 3 geo: ${geo.status} — ${geo.detail} ` +
        `country=${geo.country} region=${geo.region} city=${geo.city} tz=${geo.timezone}`,
    );
  } finally {
    await context.close().catch(() => {
      /* ignore close errors */
    });
  }

  // Hard-fail policy: with a proxy set, check 1 must not be FAIL/ERROR and
  // check 2 must not be FAIL. Geo is print-only. In baseline mode nothing hard
  // fails (the whole point is to observe the host IP).
  const hardFail =
    hasProxy &&
    (publicIp.status === 'FAIL' ||
      publicIp.status === 'ERROR' ||
      webrtc.status === 'FAIL');

  const summary = {
    mode: hasProxy ? 'proxy' : 'baseline',
    proxyServer: identity?.server ?? null,
    passed: !hardFail,
    checks: {
      publicIp,
      webrtc,
      geo,
    },
  };

  console.log(`\nLEAK_TEST_RESULT ${JSON.stringify(summary)}`);
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  console.error('[leak-test] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
