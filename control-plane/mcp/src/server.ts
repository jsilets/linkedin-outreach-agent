// The MCP server: registers the tool surface on an McpServer and mounts it on
// an Express app over a Streamable HTTP transport.
//
// Stateless transport: a fresh McpServer + transport is created per POST. This
// keeps every request independent, avoids shared session state across the
// autonomous agent and operator callers, and means privileged safety tools
// (kill_all, pause_account) are reachable on any request without depending on a
// long-lived session that could be wedged.

import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AGENT_CONTEXT, operatorContext, type RequestContext } from './context.js';
import { CapabilityError } from './capability.js';
import { ALL_TOOLS } from './tools.js';
import type { Ports } from './ports.js';

const SERVER_INFO = { name: '@loa/mcp', version: '0.0.0' } as const;

/**
 * Derive the caller capability from request headers.
 *
 * Two callers exist: the autonomous agent (never privileged) and a human
 * operator (privileged). For now the operator identity is passed via headers;
 * a real deployment authenticates it. The agent sends neither header and gets
 * AGENT_CONTEXT. This is the ONLY place caller identity is established, so the
 * tool layer can trust ctx.privileged.
 */
export function contextFromHeaders(headers: Record<string, unknown>): RequestContext {
  const priv = headers['x-loa-privileged'];
  const operator = headers['x-loa-operator'];
  if (priv === 'true' && typeof operator === 'string' && operator.length > 0) {
    return operatorContext(operator);
  }
  return AGENT_CONTEXT;
}

/** Build an McpServer with every tool registered for the given context. */
export function buildMcpServer(ports: Ports, ctx: RequestContext): McpServer {
  const server = new McpServer(SERVER_INFO);

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(args as never, ports, ctx);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
          };
        } catch (err) {
          // Capability failures and port errors surface as tool errors rather
          // than transport crashes, so a bad call cannot take the server down.
          const message = err instanceof Error ? err.message : String(err);
          const kind = err instanceof CapabilityError ? 'forbidden' : 'error';
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: JSON.stringify({ kind, message }) }],
          };
        }
      },
    );
  }

  return server;
}

/**
 * Create the Express app hosting the MCP endpoint at POST /mcp. Stateless: each
 * request spins up its own server + transport and tears them down on close.
 */
export function createApp(ports: Ports): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, server: SERVER_INFO.name });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const ctx = contextFromHeaders(req.headers as Record<string, unknown>);
    const server = buildMcpServer(ports, ctx);
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id issued or required.
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
          id: null,
        });
      }
    }
  });

  return app;
}

/** Start listening on MCP_PORT. Returns the http.Server. */
export function startServer(ports: Ports): import('node:http').Server {
  const app = createApp(ports);
  const port = Number(process.env.MCP_PORT ?? 8080);
  return app.listen(port, () => {
    // Plain startup log; no structured logger wired in this package yet.
    console.log(`[${SERVER_INFO.name}] listening on :${port} (session ${randomUUID()})`);
  });
}
