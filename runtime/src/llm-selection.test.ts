// LLM selection precedence: OpenRouter > Anthropic > Fake. The internal LLM is
// optional (driven mode over MCP needs no key), so with no key set the offline
// Fake provider is selected. We stub the env into loadConfig rather than mutating
// process.env, then assert both the resolved config and the selected label.

import { describe, expect, it } from 'vitest';
import { selectLlmProvider } from './compose.js';
import { loadConfig } from './config.js';

describe('LLM provider selection precedence', () => {
  it('selects OpenRouter when OPENROUTER_API_KEY is set (even alongside Anthropic)', () => {
    const cfg = loadConfig({
      OPENROUTER_API_KEY: 'or-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
    } as NodeJS.ProcessEnv);
    expect(cfg.openRouterApiKey).toBe('or-key');
    expect(selectLlmProvider(cfg)).toBe('openrouter');
  });

  it('selects Claude when only ANTHROPIC_API_KEY is set', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'anthropic-key' } as NodeJS.ProcessEnv);
    expect(selectLlmProvider(cfg)).toBe('claude');
  });

  it('selects Fake when no LLM key is set (driven mode needs none)', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.openRouterApiKey).toBeUndefined();
    expect(cfg.anthropicApiKey).toBeUndefined();
    expect(selectLlmProvider(cfg)).toBe('fake');
  });

  it('reads the optional OpenRouter model and attribution vars', () => {
    const cfg = loadConfig({
      OPENROUTER_API_KEY: 'or-key',
      OPENROUTER_MODEL: 'anthropic/claude-3.7-sonnet',
      OPENROUTER_SITE_URL: 'https://example.com',
      OPENROUTER_APP_TITLE: 'LOA',
    } as NodeJS.ProcessEnv);
    expect(cfg.openRouterModel).toBe('anthropic/claude-3.7-sonnet');
    expect(cfg.openRouterSiteUrl).toBe('https://example.com');
    expect(cfg.openRouterAppTitle).toBe('LOA');
  });
});
