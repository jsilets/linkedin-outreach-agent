// The MCP server: registers the tool surface on an McpServer and mounts it on
// an Express app over a Streamable HTTP transport.
//
// Stateless transport: a fresh McpServer + transport is created per POST. This
// keeps every request independent, avoids shared session state across the
// autonomous agent and operator callers, and means privileged safety tools
// (kill_all, pause_account) are reachable on any request without depending on a
// long-lived session that could be wedged.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AGENT_CONTEXT, operatorContext, type RequestContext } from './context.js';
import { CapabilityError } from './capability.js';
import { ALL_TOOLS } from './tools.js';
import type { Ports } from './ports.js';

const SERVER_INFO = { name: '@loa/mcp', version: '0.0.0' } as const;

/** Constant-time string equality that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual requires equal-length buffers; compare against a
  // same-length copy and fold the length check into the boolean result so the
  // comparison itself stays constant-time.
  const target = ab.length === bb.length ? bb : ab;
  return timingSafeEqual(ab, target) && ab.length === bb.length;
}

/** Pull the raw token out of an `Authorization: Bearer <token>` header. */
function bearerToken(headers: Record<string, unknown>): string | undefined {
  const raw = headers['authorization'];
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1] : undefined;
}

/** Result of authenticating a POST /mcp request. */
export type AuthResult =
  | { ok: true; ctx: RequestContext }
  | { ok: false; status: number; message: string };

/**
 * Authenticate a request and derive its caller capability from a bearer token.
 *
 * Two callers exist: the autonomous agent (never privileged) and a human
 * operator (privileged). Privilege derives ONLY from the token, never from a
 * client-supplied flag:
 *   - Authorization: Bearer <LOA_OPERATOR_TOKEN> -> operatorContext (privileged)
 *   - Authorization: Bearer <LOA_MCP_TOKEN>      -> AGENT_CONTEXT (base access)
 *   - anything else                              -> 401, before any tool runs
 *
 * The operator NAME is still read from x-loa-operator purely for audit
 * labeling; it grants nothing on its own. This is the ONLY place caller
 * identity is established, so the tool layer can trust ctx.privileged.
 *
 * Posture: in production LOA_MCP_TOKEN must be set (enforced at startup, see
 * createApp). In dev with no token set, every request is treated as a
 * privileged operator so local work still flows, with a one-time loud warning.
 */
export function authenticate(headers: Record<string, unknown>): AuthResult {
  const mcpToken = process.env.LOA_MCP_TOKEN ?? '';
  const operatorToken = process.env.LOA_OPERATOR_TOKEN ?? '';

  // Dev fallback: no base token configured means auth is disabled. createApp
  // only reaches here in that state outside production (production fails closed
  // at startup). Treat the caller as a labeled operator so everything works.
  if (mcpToken.length === 0) {
    return { ok: true, ctx: operatorContext(operatorName(headers) || 'dev') };
  }

  const token = bearerToken(headers);
  if (!token) {
    return { ok: false, status: 401, message: 'missing bearer token' };
  }
  if (operatorToken.length > 0 && safeEqual(token, operatorToken)) {
    return { ok: true, ctx: operatorContext(operatorName(headers) || 'operator') };
  }
  if (safeEqual(token, mcpToken)) {
    return { ok: true, ctx: AGENT_CONTEXT };
  }
  return { ok: false, status: 401, message: 'invalid bearer token' };
}

/** Operator display name for audit records; label-only, grants no privilege. */
function operatorName(headers: Record<string, unknown>): string {
  const operator = headers['x-loa-operator'];
  return typeof operator === 'string' ? operator.trim() : '';
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

  // Auth posture. Fail closed in production if no base token is configured;
  // warn-and-allow in dev so local work still flows without secrets.
  const production = process.env.NODE_ENV === 'production';
  const tokenConfigured = (process.env.LOA_MCP_TOKEN ?? '').length > 0;
  if (production && !tokenConfigured) {
    console.error(`[${SERVER_INFO.name}] LOA_MCP_TOKEN is required in production; /mcp will refuse all requests`);
  } else if (!tokenConfigured) {
    console.warn(
      `[${SERVER_INFO.name}] LOA_MCP_TOKEN unset: MCP auth is DISABLED (dev only). Every caller is treated as a privileged operator.`,
    );
  }

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, server: SERVER_INFO.name });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    // In production a missing base token fails closed: refuse before any tool
    // runs rather than fall back to the dev open posture.
    if (production && !tokenConfigured) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'server misconfigured: LOA_MCP_TOKEN is not set' },
        id: null,
      });
      return;
    }

    const auth = authenticate(req.headers as Record<string, unknown>);
    if (!auth.ok) {
      res.status(auth.status).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: auth.message },
        id: null,
      });
      return;
    }
    const ctx = auth.ctx;
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
