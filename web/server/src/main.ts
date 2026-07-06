// Thin JSON API for the campaign-management UI. Reads and writes Postgres
// directly through the shared Drizzle schema. Host-agnostic: binds 0.0.0.0 on
// PORT (default 4000) so it runs the same locally and on Railway.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { basicAuthOk } from './auth.js';
import { createMcpProxy } from './mcp-proxy.js';
import { VaultError } from '@loa/account-runner';
import {
  createCampaignFromList,
  createList,
  deleteList,
  EmptyListError,
  getCampaign,
  getList,
  getVolume,
  launchCampaign,
  LaunchError,
  linkAccount,
  listAccounts,
  listCampaigns,
  listLists,
  replaceSteps,
} from './queries.js';
import { StepValidationError } from './steps.js';

const app = express();

// One public domain serves both faces of the single-service deploy: the web UI
// here and the MCP surface on the internal MCP server. Forward /mcp before the
// JSON body parser and the Basic-auth gate below, so the raw JSON-RPC stream and
// the MCP server's own Authorization: Bearer auth pass through untouched. The
// MCP server binds MCP_PORT internally and is never exposed directly.
app.all('/mcp', createMcpProxy({
  host: process.env.MCP_HOST ?? '127.0.0.1',
  port: Number(process.env.MCP_PORT ?? 8080),
}));

app.use(express.json());

// Health check for the platform (Railway healthcheckPath). Served by the web
// process, which is the public face of the single-service deploy. Registered
// before the auth gate so Railway can probe it without credentials.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, server: '@loa/web' });
});

// HTTP Basic auth over every non-health route. Railway terminates TLS, so
// Basic over HTTPS is fine. Posture: credentials are required in production
// (fail closed if unset); in dev with no credentials set, auth is disabled
// with a one-time loud warning so local work still flows.
const authUser = process.env.LOA_WEB_USER ?? '';
const authPassword = process.env.LOA_WEB_PASSWORD ?? '';
const authConfigured = authUser.length > 0 && authPassword.length > 0;
const production = process.env.NODE_ENV === 'production';
if (production && !authConfigured) {
  console.error('web api: LOA_WEB_USER/LOA_WEB_PASSWORD are required in production; all routes will refuse requests');
} else if (!authConfigured) {
  console.warn('web api: LOA_WEB_USER/LOA_WEB_PASSWORD unset: Basic auth is DISABLED (dev only). All routes are open.');
}

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();

  // Fail closed in production if credentials were never configured.
  if (production && !authConfigured) {
    res.status(503).json({ error: 'server misconfigured: web credentials are not set.' });
    return;
  }
  // Dev open posture: auth disabled.
  if (!authConfigured) return next();

  if (basicAuthOk(req.headers.authorization, authUser, authPassword)) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="loa"').status(401).json({ error: 'authentication required.' });
});

const api = express.Router();

api.get('/campaigns', async (_req, res, next) => {
  try {
    res.json(await listCampaigns());
  } catch (err) {
    next(err);
  }
});

api.get('/campaigns/:id', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

api.put('/campaigns/:id/steps', async (req, res, next) => {
  try {
    const campaign = await getCampaign(req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }
    const steps = await replaceSteps(req.params.id, req.body?.steps ?? req.body);
    res.json({ steps });
  } catch (err) {
    if (err instanceof StepValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Launch a campaign: enroll its targets under a sender account so the dispatch
// loop starts stepping them through the funnel.
api.post('/campaigns/:id/launch', async (req, res, next) => {
  try {
    const { accountId } = req.body ?? {};
    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      res.status(400).json({ error: 'accountId is required.' });
      return;
    }
    const result = await launchCampaign(req.params.id, accountId.trim());
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LaunchError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

api.get('/metrics/volume', async (req, res, next) => {
  try {
    const accountId =
      typeof req.query.accountId === 'string' && req.query.accountId.length > 0
        ? req.query.accountId
        : undefined;
    const days = clampDays(req.query.days);
    res.json(await getVolume({ accountId, days }));
  } catch (err) {
    next(err);
  }
});

api.get('/accounts', async (_req, res, next) => {
  try {
    res.json(await listAccounts());
  } catch (err) {
    next(err);
  }
});

// Link a LinkedIn account from pasted session cookies (li_at + JSESSIONID).
// Secrets are never logged; a malformed cookie surfaces as a 400.
api.post('/accounts/link', async (req, res, next) => {
  try {
    const { handle, liAt, jsessionId } = req.body ?? {};
    if (
      typeof handle !== 'string' ||
      handle.trim().length === 0 ||
      typeof liAt !== 'string' ||
      typeof jsessionId !== 'string'
    ) {
      res.status(400).json({ error: 'handle, liAt, and jsessionId are required.' });
      return;
    }
    const result = await linkAccount({ handle: handle.trim(), liAt, jsessionId });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof VaultError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

api.get('/lists', async (_req, res, next) => {
  try {
    res.json(await listLists());
  } catch (err) {
    next(err);
  }
});

api.post('/lists', async (req, res, next) => {
  try {
    const { name, description } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required.' });
      return;
    }
    const list = await createList({
      name: name.trim(),
      description: typeof description === 'string' ? description : undefined,
    });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

api.get('/lists/:id', async (req, res, next) => {
  try {
    const list = await getList(req.params.id);
    if (!list) {
      res.status(404).json({ error: 'List not found.' });
      return;
    }
    res.json(list);
  } catch (err) {
    next(err);
  }
});

api.delete('/lists/:id', async (req, res, next) => {
  try {
    const deleted = await deleteList(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'List not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Create a campaign seeded from a list's leads (added as targets).
api.post('/lists/:id/campaign', async (req, res, next) => {
  try {
    const { goal, owner, messageStrategy } = req.body ?? {};
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      res.status(400).json({ error: 'goal is required.' });
      return;
    }
    const result = await createCampaignFromList(req.params.id, {
      goal: goal.trim(),
      owner: typeof owner === 'string' && owner.trim() ? owner.trim() : undefined,
      messageStrategy:
        typeof messageStrategy === 'string' && messageStrategy.trim() ? messageStrategy.trim() : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof EmptyListError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.use('/api', api);

// Serve the built client if it exists (production / `npm start`). In dev the
// Vite server handles the SPA and proxies /api here.
const clientDist = path.resolve(fileURLToPath(new URL('../../client/dist', import.meta.url)));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

function clampDays(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 365);
}

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
app.listen(port, host, () => {
  console.log(`web api listening on http://${host}:${port}`);
});
