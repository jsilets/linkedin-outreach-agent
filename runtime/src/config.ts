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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const cfg: RuntimeConfig = {
    mcpPort: Number(env.MCP_PORT ?? 8080),
  };
  if (env.DATABASE_URL) cfg.databaseUrl = env.DATABASE_URL;
  if (env.OPENROUTER_API_KEY) cfg.openRouterApiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_MODEL) cfg.openRouterModel = env.OPENROUTER_MODEL;
  if (env.OPENROUTER_SITE_URL) cfg.openRouterSiteUrl = env.OPENROUTER_SITE_URL;
  if (env.OPENROUTER_APP_TITLE) cfg.openRouterAppTitle = env.OPENROUTER_APP_TITLE;
  if (env.ANTHROPIC_API_KEY) cfg.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.LOA_LLM_MODEL) cfg.llmModel = env.LOA_LLM_MODEL;
  return cfg;
}
