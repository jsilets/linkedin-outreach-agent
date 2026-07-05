# Proxy and leak guard

Each account body sends all of its LinkedIn traffic through one sticky
residential or ISP-static IP. This document is the contract the account-runner's
`BrowserContextFactory` implements. If the browser context does not match this,
the host Fly IP leaks and the account looks like a bot.

## One sticky IP per account

- Every account gets its own proxy exit IP. Never share an exit IP between two
  accounts.
- The IP must be sticky (same IP across a session, ideally across days), not a
  rotating pool. LinkedIn treats an account whose IP jumps cities mid-session as
  compromised.
- Prefer residential or ISP-static over datacenter IPs.

The proxy is supplied to the Machine as Fly secrets, never baked into the image
or toml:

    PROXY_URL        e.g. http://gw.provider.com:8000  (or socks5://...)
    PROXY_USERNAME
    PROXY_PASSWORD

## Binding the proxy to the browser context

The runner opens a persistent context and passes the proxy on it, so every
request from that context egresses through the proxy:

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      proxy: {
        server: process.env.PROXY_URL,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      },
      // geo coherence, below
    });

Binding the proxy at the context (not via a system-wide env) keeps the egress
scoped to the browser and lets a future multi-context runner give each context
its own IP.

## Geo coherence

The browser fingerprint must agree with the exit IP's city. A New York exit IP
with a Los Angeles timezone is a tell. Set all of these to the proxy exit city:

- `timezoneId` on the context, e.g. `America/New_York`.
- `locale`, e.g. `en-US`.
- `geolocation` (lat/long of the exit city) plus the `geolocation` permission,
  if geolocation is granted at all.
- Accept-Language header consistent with `locale`.

Resolve the exit city once at provisioning time from the proxy IP and store it
alongside the account so the values stay stable. Set `primary_region` in the
account's fly toml to the Fly region nearest that city to keep latency low.

## Leak guard: WebRTC, DNS, IPv6

Even with the HTTP(S) proxy bound, three side channels can reveal the host IP.
Close all three.

### WebRTC

WebRTC can expose the real local/public IP via STUN even when HTTP goes through
the proxy. Disable it, or force it through the proxy:

- Launch Chromium with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
  so WebRTC never uses a non-proxied path.
- If the outreach flows never need WebRTC, disabling it outright
  (`--disable-features=WebRtcHideLocalIpsWithMdns` is not enough on its own;
  prefer the handling-policy flag above) is safest.

### DNS

DNS must resolve through the proxy, not the host resolver, or the host's
resolver IP leaks the real location. Use a proxy protocol that tunnels DNS:

- With SOCKS5, use `socks5://` (proxy-side DNS), not `socks5h`-vs-`socks5`
  confusion at the client. In Chromium, a SOCKS proxy resolves names remotely by
  default, which is what we want.
- With an HTTP CONNECT proxy, the origin hostname is resolved by the proxy for
  TLS destinations, so DNS stays remote. Verify no `--host-resolver-rules` or
  local DoH overrides re-introduce host-side resolution.

### IPv6

If the container has IPv6 connectivity and the proxy is IPv4-only, traffic can
happy-eyeballs onto native IPv6 and bypass the proxy entirely. Force IPv4:

- Launch with `--disable-ipv6` behaviour via `--host-resolver-rules` mapping, or
  simpler, ensure the Machine has no public IPv6 route for egress and the proxy
  endpoint is reached over IPv4.
- Confirm the exit IP the site sees is the proxy IPv4, not a v6 address.

## Verify before trusting an account

On first boot for a new account, and after any proxy change, have the runner
open an IP/leak echo page (an ipify-style JSON endpoint and a WebRTC leak test)
through the context and assert:

1. Reported public IP == proxy exit IP.
2. No WebRTC candidate exposes a non-proxy IP.
3. DNS resolver geo matches the exit city, not the Fly region.

If any check fails, do not run outreach on that account; surface it to the
control plane instead.
