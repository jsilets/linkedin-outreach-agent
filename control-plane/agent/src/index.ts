// @loa/agent — the agent control loop and the LLMProvider implementation.
//
// Public API:
//   ClaudeLLMProvider          LLMProvider backed by @anthropic-ai/sdk (Fable 5).
//   OpenRouterLLMProvider      LLMProvider over OpenRouter's OpenAI-compatible API.
//   AnthropicClientSeam        real seam over the SDK; inject a fake for tests.
//   OpenRouterClientSeam       real seam over fetch; inject a fake for tests.
//   control loop               observe -> personalize -> pace -> act -> ingest
//                              -> classify -> draft, stepwise and resumable.
//   PORT interfaces            the integration contract with the other packages.

export type {
  AnthropicSeam,
  SeamRequest,
  SeamResult,
  SeamTool,
  SeamToolUse,
} from './anthropic-seam.js';
export { AnthropicClientSeam } from './anthropic-seam.js';
export type { LoopPhase, LoopState } from './control-loop.js';
export {
  initialState,
  isTerminal,
  runStep,
  runToStop,
} from './control-loop.js';
export type { ClaudeLLMProviderOptions } from './llm-provider.js';
export { ClaudeLLMProvider } from './llm-provider.js';
export type { OpenRouterLLMProviderOptions } from './openrouter-llm-provider.js';
export { OpenRouterLLMProvider } from './openrouter-llm-provider.js';
export type {
  FetchLike,
  OpenRouterClientSeamOptions,
  OpenRouterSeam,
} from './openrouter-seam.js';
export { OpenRouterClientSeam } from './openrouter-seam.js';

export type {
  ExecIntent,
  ExecutorPort,
  LLMPort,
  LoopContext,
  LoopPorts,
  Observation,
  ObservedMessage,
  PersistencePort,
  SafetyPort,
  SchedulerPort,
} from './ports.js';
