// Thin JSON API for the campaign-management UI. Reads and writes Postgres
// directly through the shared Drizzle schema. Host-agnostic: binds 0.0.0.0 on
// PORT (default 4000) so it runs the same locally and on Railway.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  getCampaign,
  getVolume,
  listAccounts,
  listCampaigns,
  replaceSteps,
} from './queries.js';
import { StepValidationError } from './steps.js';

const app = express();
app.use(express.json());

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
