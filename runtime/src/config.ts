// Runtime configuration, read from the environment. compose() takes a resolved
// RuntimeConfig; loadConfig() builds one from process.env with safe defaults so
// dev and smoke run offline and in memory.

export interface RuntimeConfig {
  /** Port the MCP HTTP server binds. */
  mcpPort: number;
  /** Postgres connection string; when set, the Postgres store is used. */
  databaseUrl?: string;
  /** OpenRouter key; when set, OpenRouterLLMProvider is used (takes precedence). */
  openRouterApiKey?: string;
  /** OpenRouter model id, forwarded to OpenRouterLLMProvider when live. */
  openRouterModel?: string;
  /** Optional OpenRouter attribution: HTTP-Referer header. */
  openRouterSiteUrl?: string;
  /** Optional OpenRouter attribution: X-Title header. */
  openRouterAppTitle?: string;
  /** Anthropic key; when set (and no OpenRouter key), ClaudeLLMProvider is used. */
  anthropicApiKey?: string;
  /** LLM model id, forwarded to ClaudeLLMProvider when live. */
  llmModel?: string;
  /**
   * Which executor drives actions. 'fake' (default) never touches a browser;
   * 'real' uses the account-runner over live patchright Chromium and needs a
   * seeded session per account. Set with LOA_EXECUTOR=real.
   */
  executorMode: 'fake' | 'real';
  /** Persistent browser-profile root; one subdir per account. */
  profileDir: string;
  /** Encrypted cookie-vault root; one file per account. */
  vaultDir: string;
  /** Default egress proxy for the real executor (one sticky IP per account). */
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  /**
   * Allow the real executor to launch WITHOUT a proxy. Off by default: a real
   * account must run behind its sticky proxy, since the first-login IP becomes
   * the account's trusted baseline. Only set LOA_ALLOW_NO_PROXY=true for local
   * spine checks against neutral pages, never for a real account.
   */
  allowNoProxy: boolean;
  /**
   * Poll interval (ms) for the campaign dispatch tick. Unset means the tick
   * does NOT auto-start: composing the runtime never drives outreach on its
   * own. Set LOA_DISPATCH_INTERVAL_MS (e.g. 30000) on a host that should run
   * the sequence engine unattended.
   */
  dispatchIntervalMs?: number;
  /**
   * Poll interval (ms) for the reply-detection tick. Unset means it does NOT
   * auto-start (same opt-in rule as the dispatch tick): composing the runtime
   * never reads inboxes on its own. Set LOA_REPLY_POLL_INTERVAL_MS on a host
   * that should watch for prospect replies and pull them out of the funnel.
   */
  replyPollIntervalMs?: number;
  /**
   * Poll interval (ms) for the acceptance-detection tick. Unset means it does
   * NOT auto-start (same opt-in rule as the reply tick): composing the runtime
   * never reads the connections list on its own. Set LOA_ACCEPTANCE_POLL_INTERVAL_MS
   * on a host that should watch for accepted invites and release parked cursors
   * from a connect step into the next step.
   */
  acceptancePollIntervalMs?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const cfg: RuntimeConfig = {
    mcpPort: Number(env.MCP_PORT ?? 8080),
    executorMode: env.LOA_EXECUTOR === 'real' ? 'real' : 'fake',
    profileDir: env.LOA_PROFILE_DIR ?? '/data/profile',
    vaultDir: env.LOA_VAULT_DIR ?? '/data/vault',
    allowNoProxy: env.LOA_ALLOW_NO_PROXY === 'true',
  };
  if (env.DATABASE_URL) cfg.databaseUrl = env.DATABASE_URL;
  if (env.OPENROUTER_API_KEY) cfg.openRouterApiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_MODEL) cfg.openRouterModel = env.OPENROUTER_MODEL;
  if (env.OPENROUTER_SITE_URL) cfg.openRouterSiteUrl = env.OPENROUTER_SITE_URL;
  if (env.OPENROUTER_APP_TITLE) cfg.openRouterAppTitle = env.OPENROUTER_APP_TITLE;
  if (env.ANTHROPIC_API_KEY) cfg.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.LOA_LLM_MODEL) cfg.llmModel = env.LOA_LLM_MODEL;
  if (env.PROXY_URL) cfg.proxyUrl = env.PROXY_URL;
  if (env.PROXY_USERNAME) cfg.proxyUsername = env.PROXY_USERNAME;
  if (env.PROXY_PASSWORD) cfg.proxyPassword = env.PROXY_PASSWORD;
  if (env.LOA_DISPATCH_INTERVAL_MS) cfg.dispatchIntervalMs = Number(env.LOA_DISPATCH_INTERVAL_MS);
  if (env.LOA_REPLY_POLL_INTERVAL_MS)
    cfg.replyPollIntervalMs = Number(env.LOA_REPLY_POLL_INTERVAL_MS);
  if (env.LOA_ACCEPTANCE_POLL_INTERVAL_MS)
    cfg.acceptancePollIntervalMs = Number(env.LOA_ACCEPTANCE_POLL_INTERVAL_MS);
  return cfg;
}
