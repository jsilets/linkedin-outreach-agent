// Server-side JSON-RPC client for the runtime's MCP server. The approval WRITE
// endpoints call the runtime's operator tools (approve / edit_and_approve /
// reject) through here — only the runtime executor actually sends a LinkedIn
// message, so the web server never touches a browser. This is deliberately NOT
// the /mcp browser proxy (mcp-proxy.ts): that streams a browser's own JSON-RPC
// through untouched, whereas this makes a first-party call with the operator
// token from the environment.
//
// Auth mirrors the runtime's posture (control-plane/mcp/src/server.ts): a
// LOA_OPERATOR_TOKEN bearer marks the caller as a privileged operator. We send
// it only when it is set; a dev-open runtime (no LOA_MCP_TOKEN) needs none. The
// x-loa-operator header is an audit label only and grants no privilege.

/** Thrown when the MCP transport fails or a tool reports an error. Routes map this to 400. */
export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: unknown;
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
}

// The runtime answers tools/call as an SSE frame ("event: message\ndata: {…}")
// when text/event-stream is accepted, or as a bare JSON body otherwise. Pull the
// JSON-RPC envelope out of either shape.
function parseEnvelope(contentType: string, body: string): JsonRpcEnvelope {
  const trimmed = body.trim();
  const looksLikeSse =
    contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:');
  const payload = looksLikeSse
    ? trimmed
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('')
    : trimmed;
  if (!payload) throw new McpError('empty response from mcp server');
  try {
    return JSON.parse(payload) as JsonRpcEnvelope;
  } catch {
    throw new McpError('unparseable response from mcp server');
  }
}

/**
 * Call one MCP tool and return its text content. Throws McpError on a transport
 * failure, a JSON-RPC error, or a tool that reports isError. The text content is
 * the concatenation of the tool's text parts (usually a JSON string).
 */
export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_PORT ?? 8080);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-loa-operator': 'web-ui',
  };
  const token = process.env.LOA_OPERATOR_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  let body: string;
  try {
    res = await fetch(`http://${host}:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    });
    body = await res.text();
  } catch {
    throw new McpError('mcp upstream unavailable.');
  }

  let envelope: JsonRpcEnvelope;
  try {
    envelope = parseEnvelope(res.headers.get('content-type') ?? '', body);
  } catch (err) {
    // A non-2xx with no parseable envelope (e.g. a bare 401) still needs a message.
    if (!res.ok) throw new McpError(`mcp server returned ${res.status}`);
    throw err;
  }

  if (envelope.error) throw new McpError(envelope.error.message ?? `mcp error (${envelope.error.code ?? 'unknown'})`);
  const content = envelope.result?.content;
  const text = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '';
  if (envelope.result?.isError) throw new McpError(text || 'mcp tool reported an error');
  return text;
}
