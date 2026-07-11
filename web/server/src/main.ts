// Thin JSON API for the campaign-management UI. Reads and writes Postgres
// directly through the shared Drizzle schema. Host-agnostic: binds 0.0.0.0 on
// PORT (default 4000) so it runs the same locally and on Railway.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { AUTH_COOKIE, authCookieOk, basicAuthOk, issueAuthToken, safeEqual } from './auth.js';
import { createMcpProxy } from './mcp-proxy.js';
import { callMcpTool, McpError } from './mcp-client.js';
import { VaultError } from '@loa/account-runner';
import {
  createCampaignFromList,
  createList,
  deleteCampaign,
  deleteList,
  EmptyListError,
  getActivity,
  getCampaign,
  getCampaignLeads,
  getList,
  getPending,
  getVolume,
  launchCampaign,
  LaunchError,
  LimitsError,
  linkAccount,
  listAccounts,
  listCampaigns,
  listLists,
  replaceSteps,
  updateAccountLimits,
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

// Auth over every route except health and login. Two credential paths: HTTP
// Basic (curl/API) and a signed session cookie set by POST /login. The cookie is
// what lets embedded browsers in — they cannot render a native Basic-auth prompt,
// and URL-embedded credentials break the SPA's fetch() calls. Posture:
// credentials are required in production (fail closed if unset); in dev with none
// set, auth is disabled with a one-time warning so local work still flows.
const authUser = process.env.LOA_WEB_USER ?? '';
const authPassword = process.env.LOA_WEB_PASSWORD ?? '';
const authConfigured = authUser.length > 0 && authPassword.length > 0;
const production = process.env.NODE_ENV === 'production';
if (production && !authConfigured) {
  console.error('web api: LOA_WEB_USER/LOA_WEB_PASSWORD are required in production; all routes will refuse requests');
} else if (!authConfigured) {
  console.warn('web api: LOA_WEB_USER/LOA_WEB_PASSWORD unset: auth is DISABLED (dev only). All routes are open.');
}

// Login page + handler, served without auth so a browser can sign in.
app.get('/login', (_req, res) => {
  res.type('html').send(loginPage());
});

app.post('/login', (req, res) => {
  if (!authConfigured) {
    res.json({ ok: true }); // dev: auth disabled, nothing to check.
    return;
  }
  const user = typeof req.body?.user === 'string' && req.body.user ? req.body.user : authUser;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (safeEqual(user, authUser) && safeEqual(password, authPassword)) {
    const token = issueAuthToken(authUser, authPassword);
    const secure = production ? ' Secure;' : '';
    res.setHeader(
      'Set-Cookie',
      `${AUTH_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    );
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: 'invalid credentials.' });
});

app.use((req, res, next) => {
  if (req.path === '/healthz' || req.path === '/login') return next();

  // Fail closed in production if credentials were never configured.
  if (production && !authConfigured) {
    res.status(503).json({ error: 'server misconfigured: web credentials are not set.' });
    return;
  }
  // Dev open posture: auth disabled.
  if (!authConfigured) return next();

  // Accept either a valid session cookie (browsers) or Basic credentials (curl).
  if (
    authCookieOk(req.headers.cookie, authUser, authPassword) ||
    basicAuthOk(req.headers.authorization, authUser, authPassword)
  ) {
    return next();
  }

  // API callers get a clean 401; browsers get sent to the login page.
  if (req.path.startsWith('/api')) {
    res.set('WWW-Authenticate', 'Basic realm="loa"').status(401).json({ error: 'authentication required.' });
    return;
  }
  res.redirect('/login');
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

// Per-lead drill-down for one campaign. Optional ?state filter matches a lead's
// progress state or stage (case-insensitive, spaces↔underscores).
api.get('/campaigns/:id/leads', async (req, res, next) => {
  try {
    const state =
      typeof req.query.state === 'string' && req.query.state.trim().length > 0
        ? req.query.state.trim()
        : undefined;
    res.json(await getCampaignLeads(req.params.id, state));
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

// Delete a campaign and all its dependents (targets, progress, actions,
// messages, steps) in one transaction. 404 when the campaign does not exist.
api.delete('/campaigns/:id', async (req, res, next) => {
  try {
    const deleted = await deleteCampaign(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
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

// Edit an account's automation limits: per-action daily caps and the optional
// working-hours/days schedule. A bad value surfaces as a 400; unknown account
// also 400s via LimitsError.
api.patch('/accounts/:id/limits', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const limits = await updateAccountLimits(req.params.id, body.caps, body.schedule);
    res.json({ ok: true, limits });
  } catch (err) {
    if (err instanceof LimitsError) {
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

// Pending message approvals across campaigns (or one, via ?campaignId).
api.get('/pending', async (req, res, next) => {
  try {
    const campaignId =
      typeof req.query.campaignId === 'string' && req.query.campaignId.length > 0
        ? req.query.campaignId
        : undefined;
    res.json(await getPending(campaignId));
  } catch (err) {
    next(err);
  }
});

// Reverse-chron feed of real actions (optionally scoped to one campaign).
api.get('/activity', async (req, res, next) => {
  try {
    const campaignId =
      typeof req.query.campaignId === 'string' && req.query.campaignId.length > 0
        ? req.query.campaignId
        : undefined;
    res.json(await getActivity({ campaignId, limit: clampLimit(req.query.limit) }));
  } catch (err) {
    next(err);
  }
});

// Bulk approve. Registered before the parameterized :messageId routes; distinct
// segment count means no route collision, but keep it first for clarity. Each
// approval is enqueued sequentially; the runtime paces the actual sends.
api.post('/pending/approve', async (req, res, next) => {
  try {
    const ids = (req.body ?? {}).messageIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      res.status(400).json({ error: 'messageIds must be an array of strings.' });
      return;
    }
    const results: Array<{ messageId: string; ok: boolean; error?: string }> = [];
    for (const messageId of ids as string[]) {
      try {
        await callMcpTool('approve', { pendingId: messageId });
        results.push({ messageId, ok: true });
      } catch (err) {
        results.push({ messageId, ok: false, error: err instanceof Error ? err.message : 'approve failed' });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// Approve one pending draft. A non-empty body edits the draft before sending
// (edit_and_approve); otherwise the draft is approved as-is (approve). Both
// dispatch a real send through the runtime executor.
api.post('/pending/:messageId/approve', async (req, res, next) => {
  try {
    const edited = (req.body ?? {}).body;
    const hasEdit = typeof edited === 'string' && edited.trim().length > 0;
    const action = hasEdit ? 'edit_and_approve' : 'approve';
    const args = hasEdit
      ? { pendingId: req.params.messageId, body: edited }
      : { pendingId: req.params.messageId };
    await callMcpTool(action, args);
    res.json({ ok: true, action });
  } catch (err) {
    if (err instanceof McpError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Reject one pending draft with a reason; the runtime drops the binding so it is
// never sent.
api.post('/pending/:messageId/reject', async (req, res, next) => {
  try {
    const reason = (req.body ?? {}).reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      res.status(400).json({ error: 'reason is required.' });
      return;
    }
    await callMcpTool('reject', { pendingId: req.params.messageId, reason });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof McpError) {
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

// Self-contained login page (no external assets) so it renders in any browser,
// including embedded preview panes that cannot show a native Basic-auth dialog.
// Posts JSON to /login, which sets the session cookie, then redirects to the app.
function loginPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>loa · sign in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;font:15px/1.4 system-ui,-apple-system,sans-serif}
  form{background:#111820;border:1px solid #1f2a36;border-radius:12px;padding:28px;width:280px}
  h1{margin:0 0 4px;font-size:17px}
  p{margin:0 0 18px;color:#8b98a5;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:12px;background:#0b0f14;border:1px solid #223041;border-radius:8px;color:#e6edf3;font-size:14px}
  button{width:100%;padding:10px;background:#2f81f7;border:0;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6}
  .err{color:#f85149;font-size:13px;min-height:18px;margin-top:8px}
</style></head><body>
<form id="f">
  <h1>linkedin-outreach-agent</h1>
  <p>Sign in to the control panel.</p>
  <input id="u" placeholder="username" autocomplete="username" autofocus>
  <input id="p" type="password" placeholder="password" autocomplete="current-password">
  <button id="b" type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
  var f=document.getElementById('f'),b=document.getElementById('b'),e=document.getElementById('e');
  f.addEventListener('submit',async function(ev){ev.preventDefault();b.disabled=true;e.textContent='';
    try{var r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({user:document.getElementById('u').value,password:document.getElementById('p').value})});
      if(r.ok){location.href='/';}else{e.textContent='Invalid credentials.';b.disabled=false;}
    }catch(_){e.textContent='Network error.';b.disabled=false;}});
</script>
</body></html>`;
}

function clampDays(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 365);
}

// Activity feed page size: default 50, capped at 200.
function clampLimit(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
app.listen(port, host, () => {
  console.log(`web api listening on http://${host}:${port}`);
});
