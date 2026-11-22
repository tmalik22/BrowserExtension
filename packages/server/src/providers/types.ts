import type { BrowserMember, ImageBlock, ToolResult } from '@ba/shared';

// ---------------------------------------------------------------------------------------------
// Provider-neutral conversation. Append-only: turns are never edited after they are added, so
// every provider's request prefix stays byte-identical between steps (prompt caching, and
// Anthropic's preserved-thinking prefix check).
// ---------------------------------------------------------------------------------------------

export type UserPart = { type: 'text'; text: string } | ImageBlock;

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> };

export interface ToolResultEntry {
  callId: string;
  member: string;
  input: Record<string, unknown>;
  result: ToolResult;
}

export type Turn =
  | { role: 'user'; parts: UserPart[] }
  | {
      role: 'assistant';
      parts: AssistantPart[];
      /** Raw provider content, replayed verbatim to the same provider (thinking signatures etc). */
      native?: { provider: string; content: unknown };
    }
  | {
      role: 'tool_results';
      results: ToolResultEntry[];
      /** Messages the user sent while the agent was working, delivered with these results. */
      notes?: string[];
    };

export interface ModelProfile {
  id: string;
  label: string;
  /** anthropic | openai (any OpenAI-compatible endpoint) | mock */
  provider: 'anthropic' | 'openai' | 'mock';
  model: string;
  baseURL?: string;
  /** Name of the env var holding the key (preferred), or a literal key for local servers. */
  apiKeyEnv?: string;
  apiKey?: string;
  /** Read the key from this file (e.g. a local server's key file). */
  apiKeyFile?: string;
  vision: boolean;
  /** native tool calling, or a JSON-in-text protocol for models without tool support. */
  toolMode?: 'native' | 'json';
  toolSet?: 'full' | 'compact';
  maxTokens?: number;
  /** Anthropic: output_config.effort */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Anthropic: server-side refusal fallbacks ("default") or off. */
  fallbacks?: 'default' | 'off';
  /** Anthropic: server-side tool-result clearing threshold (input tokens). 0 disables. */
  contextClearAt?: number;
  /** OpenAI-compatible: stream responses (some local servers mishandle streamed tool calls). */
  stream?: boolean;
  /** OpenAI-compatible: the model's context window in tokens (e.g. llama.cpp -c). Old steps are
   *  trimmed automatically before a request would overflow it. Learned from errors if unset. */
  contextTokens?: number;
  /** OpenAI-compatible: send the model's own reasoning back with its earlier tool calls
   *  (DeepSeek's thinking mode rejects tool-call histories without it). */
  replayReasoning?: boolean;
  /** OpenAI-compatible: keep this many most recent screenshots in context. */
  keepImages?: number;
  /** OpenAI-compatible: extra request body fields (e.g. reasoning_effort, temperature). */
  extraBody?: Record<string, unknown>;
  /** OpenAI-compatible: extra headers (e.g. OpenRouter's HTTP-Referer). */
  headers?: Record<string, string>;
  /** Request timeout ms. */
  timeoutMs?: number;
  /** Mock provider: script name. */
  script?: string;
  /** CAPTCHA helper protocol. "kraken" = CaptchaKraken JSON plan (no tool calls). */
  captchaProtocol?: 'kraken';
  /** Found by local-model auto-detection (Ollama / LM Studio), not in models.json. */
  detected?: boolean;
  /** From a provider's live model list (catalog.ts): the catalog provider id. */
  catalog?: string;
  /** Heading the model picker groups this model under (e.g. "NVIDIA NIM", "Local"). */
  group?: string;
  /** Local script that starts this profile's model server (spawned on first CAPTCHA use). */
  startScript?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface CompletionRequest {
  system: string;
  history: Turn[];
  members: BrowserMember[];
  profile: ModelProfile;
}

export interface CompletionResult {
  parts: AssistantPart[];
  native?: { provider: string; content: unknown };
  stopReason: StopReason;
  usage: Usage;
  /** Human-readable reason for refusals etc. */
  stopDetail?: string;
  /** Size of this request's prompt and the model's window, when known. */
  context?: { used: number; window?: number };
}

export interface StreamCallbacks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onNotice?(level: 'info' | 'warn', message: string): void;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest, cb: StreamCallbacks, signal: AbortSignal): Promise<CompletionResult>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
  }
}
