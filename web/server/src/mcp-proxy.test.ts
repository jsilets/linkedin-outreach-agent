import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { createMcpProxy } from './mcp-proxy.js';

// Servers spun up per test; torn down in afterEach.
const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  }

async function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Build the same middleware order main.ts uses: proxy first, then a Basic-auth
// gate that would 401 everything else. Proves /mcp bypasses the gate.
async function appWithProxy(upstreamPort: number): Promise<number> {
  const app = express();
  app.all('/mcp', createMcpProxy({ host: '127.0.0.1', port: upstreamPort }));
  app.use(express.json());
  app.use((_req, res) => res.status(401).json({ error: 'gated' }));
  const server = http.createServer(app);
  servers.push(server);
  return listen(server);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('createMcpProxy', () => {
  it('forwards method, path, Authorization, and body to the upstream MCP server', async () => {
    let seen: { method?: string; auth?: string; url?: string; body?: string } = {};
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { method: req.method, auth: req.headers.authorization, url: req.url, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const appPort = await appWithProxy(upstreamPort);

    const payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const res = await post(
      appPort,
      '/mcp',
      { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      payload,
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/mcp');
    expect(seen.auth).toBe('Bearer test-token');
    expect(seen.body).toBe(payload);
  });

  it('preserves a streamed text/event-stream response', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: one\n\n');
      res.end('event: message\ndata: two\n\n');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const appPort = await appWithProxy(upstreamPort);

    const res = await post(appPort, '/mcp', { authorization: 'Bearer t' }, '{}');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('data: one');
    expect(res.body).toContain('data: two');
  });

  it('does not apply the Basic-auth gate to /mcp (a gated non-/mcp route 401s)', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200).end('reached');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const appPort = await appWithProxy(upstreamPort);

    const mcp = await post(appPort, '/mcp', {}, '{}');
    expect(mcp.status).toBe(200);
    expect(mcp.body).toBe('reached');

    const other = await post(appPort, '/api/campaigns', {}, '{}');
    expect(other.status).toBe(401);
  });

  it('returns 502 when the MCP server is unreachable', async () => {
    // Point at a port with nothing listening.
    const app = express();
    app.all('/mcp', createMcpProxy({ host: '127.0.0.1', port: 1 }));
    const server = http.createServer(app);
    servers.push(server);
    const appPort = await listen(server);

    const res = await post(appPort, '/mcp', {}, '{}');
    expect(res.status).toBe(502);
  });
});
