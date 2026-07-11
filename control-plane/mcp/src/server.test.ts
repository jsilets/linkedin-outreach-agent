// Unit tests for the POST /mcp bearer-token auth. Privilege must derive from
// the token, never from a client-supplied header.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authenticate } from './server.js';

// Snapshot and restore the env vars the auth reads so tests don't leak state.
const ENV_KEYS = ['LOA_MCP_TOKEN', 'LOA_OPERATOR_TOKEN', 'NODE_ENV'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function bearer(token: string): Record<string, unknown> {
  return { authorization: `Bearer ${token}` };
}

describe('authenticate', () => {
  it('grants the non-privileged agent context for a valid base token', () => {
    process.env.LOA_MCP_TOKEN = 'agent-secret';
    process.env.LOA_OPERATOR_TOKEN = 'operator-secret';
    const result = authenticate(bearer('agent-secret'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.ctx.privileged).toBe(false);
    expect(result.ctx.operator).toBe('');
  });

  it('grants a privileged operator context for a valid operator token', () => {
    process.env.LOA_MCP_TOKEN = 'agent-secret';
    process.env.LOA_OPERATOR_TOKEN = 'operator-secret';
    const result = authenticate({ ...bearer('operator-secret'), 'x-loa-operator': 'operator-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.ctx.privileged).toBe(true);
    expect(result.ctx.operator).toBe('operator-1');
  });

  it('falls back to a default operator label when x-loa-operator is absent', () => {
    process.env.LOA_MCP_TOKEN = 'agent-secret';
    process.env.LOA_OPERATOR_TOKEN = 'operator-secret';
    const result = authenticate(bearer('operator-secret'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.ctx.privileged).toBe(true);
    expect(result.ctx.operator).toBe('operator');
  });

  it('rejects a request with no bearer token', () => {
    process.env.LOA_MCP_TOKEN = 'agent-secret';
    const result = authenticate({});
    expect(result).toEqual({ ok: false, status: 401, message: 'missing bearer token' });
  });

  it('rejects a request with an invalid bearer token', () => {
    process.env.LOA_MCP_TOKEN = 'agent-secret';
    process.env.LOA_OPERATOR_TOKEN = 'operator-secret';
    const result = authenticate(bearer('wrong'));
    expect(result).toEqual({ ok: false, status: 401, message: 'invalid bearer token' });
  });

  it('does not grant privilege from x-loa-privileged alone', () => {
    process.env.LOA_MCP_TOKEN = 'agent-secret';
    process.env.LOA_OPERATOR_TOKEN = 'operator-secret';
    // The old vulnerability: header-only elevation. With only the base token
    // the caller stays non-privileged; with no token at all it is rejected.
    const withBase = authenticate({
      ...bearer('agent-secret'),
      'x-loa-privileged': 'true',
      'x-loa-operator': 'attacker',
    });
    expect(withBase.ok).toBe(true);
    if (!withBase.ok) throw new Error('unreachable');
    expect(withBase.ctx.privileged).toBe(false);

    const headerOnly = authenticate({ 'x-loa-privileged': 'true', 'x-loa-operator': 'attacker' });
    expect(headerOnly).toEqual({ ok: false, status: 401, message: 'missing bearer token' });
  });

  it('disables auth in dev when no base token is set (operator fallback)', () => {
    delete process.env.LOA_MCP_TOKEN;
    delete process.env.LOA_OPERATOR_TOKEN;
    delete process.env.NODE_ENV;
    const result = authenticate({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.ctx.privileged).toBe(true);
  });
});
