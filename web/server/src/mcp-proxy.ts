// Reverse-proxy the MCP endpoint to the in-container MCP server, so one public
// domain serves both the web UI (Basic auth) and the MCP surface (its own bearer
// auth). Mounted before the JSON body parser and the Basic-auth gate so the raw
// JSON-RPC stream, the Accept header, and the Authorization: Bearer header pass
// through untouched — including streamed text/event-stream responses.
import http from 'node:http';
import type { Request, Response } from 'express';

export interface McpProxyOptions {
  host: string;
  port: number;
}

/** Build an Express handler that streams /mcp to the internal MCP server. */
export function createMcpProxy({ host, port }: McpProxyOptions) {
  return function mcpProxy(req: Request, res: Response): void {
    const upstream = http.request(
      { host, port, method: req.method, path: '/mcp', headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    // The MCP server shares this container; a connection error means it is down
    // or still booting. Surface a 502 rather than hanging the caller.
    upstream.on('error', () => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(502).json({ error: 'mcp upstream unavailable.' });
    });
    req.pipe(upstream);
  };
}
