// Runtime configuration, read from the environment. compose() takes a resolved
// RuntimeConfig; loadConfig() builds one from process.env with safe defaults so
// dev and smoke run offline and in memory.

export interface RuntimeConfig {
  /** Port the MCP HTTP server binds. */
  mcpPort: number;
  /** Postgres connection string; when set, the Postgres store is used. */
  databaseUrl?: string;
  /** Anthropic key; when set, the real ClaudeLLMProvider is used. */
  anthropicApiKey?: string;
  /** LLM model id, forwarded to ClaudeLLMProvider when live. */
  llmModel?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const cfg: RuntimeConfig = {
    mcpPort: Number(env.MCP_PORT ?? 8080),
  };
  if (env.DATABASE_URL) cfg.databaseUrl = env.DATABASE_URL;
  if (env.ANTHROPIC_API_KEY) cfg.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.LOA_LLM_MODEL) cfg.llmModel = env.LOA_LLM_MODEL;
  return cfg;
}
