/**
 * Anthropic provider: uses the native `browser_toolset_20260801` toolset, which Claude models are
 * trained on. Assistant turns are replayed verbatim (thinking blocks included) and the history is
 * append-only, so the preserved-thinking prefix check and prompt caching both hold. Old tool
 * results are dropped with server-side context editing, never by editing history client-side.
 */
import Anthropic from '@anthropic-ai/sdk';
import { BROWSER_MEMBERS, OPTIONAL_MEMBERS, type BrowserMember } from '@ba/shared';
import {
  ProviderError,
  type AssistantPart,
  type CompletionRequest,
  type CompletionResult,
  type ModelProfile,
  type Provider,
  type StreamCallbacks,
  type Turn,
  type Usage,
} from './types.ts';

type Block = Record<string, unknown>;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CONTEXT_BETA = 'context-management-2025-06-27';

/** Build the toolset entry, enabling/disabling members to match the session's member list. */
export function buildToolsetEntry(members: BrowserMember[]): Block {
  const configs: Record<string, { enabled: boolean }> = {};
  for (const m of BROWSER_MEMBERS) {
    const wanted = members.includes(m);
    const defaultOn = !OPTIONAL_MEMBERS.includes(m);
    if (wanted !== defaultOn) configs[m] = { enabled: wanted };
  }
  const entry: Block = { type: 'browser_toolset_20260801' };
  if (Object.keys(configs).length) entry.configs = configs;
  return entry;
}

function imageBlock(img: { mediaType: string; data: string }): Block {
  return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } };
}

/** Deterministic conversion: the same history always yields byte-identical messages. */
export function toAnthropicMessages(history: Turn[]): Block[] {
  const out: Block[] = [];
  for (const turn of history) {
    if (turn.role === 'user') {
      const content = turn.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : imageBlock(p)));
      out.push({ role: 'user', content });
    } else if (turn.role === 'assistant') {
      if (turn.native?.provider === 'anthropic') {
        const content = turn.native.content as unknown[];
        // An empty assistant message (e.g. a refusal with no content) is invalid mid-conversation.
        out.push({ role: 'assistant', content: Array.isArray(content) && content.length ? content : [{ type: 'text', text: '(no response)' }] });
        continue;
      }
      // Turn produced by another provider: rebuild (thinking from other models can't be replayed).
      const content: Block[] = [];
      for (const p of turn.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        if (p.type === 'tool_call') content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input, toolset_name: 'browser' });
      }
      if (!content.length) content.push({ type: 'text', text: '(no response)' });
      out.push({ role: 'assistant', content });
    } else {
      const content = turn.results.map((r) => {
        const blocks: Block[] = [];
        for (const b of r.result.content) {
          if (b.type === 'text') {
            if (b.text) blocks.push({ type: 'text', text: b.text });
          } else if (b.type === 'image') blocks.push(imageBlock(b));
          else if (b.type === 'browser_state' && !r.result.isError) blocks.push(b as unknown as Block);
        }
        if (!blocks.length) blocks.push({ type: 'text', text: r.result.isError ? 'Error.' : 'Done.' });
        const tr: Block = { type: 'tool_result', tool_use_id: r.callId, toolset_name: 'browser', content: blocks };
        if (r.result.isError) tr.is_error = true;
        return tr;
      });
      for (const n of turn.notes ?? []) content.push({ type: 'text', text: userNoteText(n) });
      out.push({ role: 'user', content });
    }
  }
  return out;
}

export function userNoteText(note: string): string {
  return `[Message from the user, sent while you were working]\n${note}`;
}

export function buildRequest(req: CompletionRequest, opts: { fallbacks: boolean; stream: boolean }): { body: Block; betas: string[] } {
  const p = req.profile;
  const betas: string[] = [];
  const body: Block = {
    model: p.model,
    max_tokens: p.maxTokens ?? 32000,
    system: [{ type: 'text', text: req.system }],
    tools: [buildToolsetEntry(req.members)],
    messages: toAnthropicMessages(req.history),
    thinking: { type: 'adaptive', display: 'summarized' },
    // Automatic prompt caching: the breakpoint advances with the conversation.
    cache_control: { type: 'ephemeral' },
  };
  if (p.effort) body.output_config = { effort: p.effort };
  const clearAt = p.contextClearAt ?? 120_000;
  if (clearAt > 0) {
    betas.push(CONTEXT_BETA);
    body.context_management = {
      edits: [
        {
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: clearAt },
          keep: { type: 'tool_uses', value: 8 },
          clear_at_least: { type: 'input_tokens', value: Math.min(30_000, Math.floor(clearAt / 3)) },
        },
      ],
    };
  }
  if (opts.fallbacks) {
    betas.push(FALLBACK_BETA);
    body.fallbacks = 'default';
  }
  return { body, betas };
}

function usageOf(u: Record<string, unknown> | undefined): Usage {
  return {
    inputTokens: Number(u?.input_tokens ?? 0),
    outputTokens: Number(u?.output_tokens ?? 0),
    cacheReadTokens: Number(u?.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Number(u?.cache_creation_input_tokens ?? 0),
  };
}

/** Parse a final API message into neutral parts. */
export function parseMessage(msg: { content: Block[]; stop_reason?: string | null; stop_details?: unknown; usage?: unknown }): CompletionResult {
  const parts: AssistantPart[] = [];
  for (const b of msg.content) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) parts.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use')
      parts.push({ type: 'tool_call', id: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {} });
  }
  const sr = msg.stop_reason;
  const stopReason =
    sr === 'tool_use' ? 'tool_use' : sr === 'end_turn' || sr === 'stop_sequence' ? 'end_turn' : sr === 'max_tokens' ? 'max_tokens' : sr === 'refusal' ? 'refusal' : 'other';
  let stopDetail: string | undefined;
  if (sr === 'refusal' && msg.stop_details && typeof msg.stop_details === 'object') {
    const d = msg.stop_details as { category?: string; explanation?: string };
    stopDetail = [d.category, d.explanation].filter(Boolean).join(': ');
  }
  // A tool_use stop with no tool calls (shouldn't happen) is treated as end of turn.
  const hasCalls = parts.some((p) => p.type === 'tool_call');
  return {
    parts,
    native: { provider: 'anthropic', content: msg.content },
    stopReason: stopReason === 'tool_use' && !hasCalls ? 'end_turn' : stopReason,
    usage: usageOf(msg.usage as Record<string, unknown>),
    stopDetail,
  };
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private fallbacksSupported = true;

  constructor(
    private profile: ModelProfile,
    apiKey: string,
  ) {
    this.client = new Anthropic({
      apiKey,
      // Never inherit ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the shell (e.g. a Claude Code
      // proxy): requests go to the profile's endpoint with the profile's key only.
      authToken: null,
      baseURL: profile.baseURL ?? 'https://api.anthropic.com',
      maxRetries: 4,
      timeout: profile.timeoutMs ?? 10 * 60 * 1000,
    });
  }

  async complete(req: CompletionRequest, cb: StreamCallbacks, signal: AbortSignal): Promise<CompletionResult> {
    const wantFallbacks = (this.profile.fallbacks ?? 'default') === 'default' && this.fallbacksSupported;
    try {
      return await this.run(req, cb, signal, wantFallbacks);
    } catch (e) {
      // If the server-side fallback beta is rejected (older SDK/API, partner platform), retry without.
      if (wantFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
        this.fallbacksSupported = false;
        cb.onNotice?.('warn', 'Server-side refusal fallbacks are not available for this model/account; continuing without them.');
        return this.run(req, cb, signal, false);
      }
      throw this.wrap(e);
    }
  }

  private wrap(e: unknown): Error {
    if (e instanceof ProviderError) return e;
    if (e instanceof Anthropic.APIError) {
      const status = (e as { status?: number }).status;
      const retryable = status === 429 || status === 529 || (status != null && status >= 500);
      return new ProviderError(`Anthropic API error${status ? ` ${status}` : ''}: ${e.message}`, retryable, status);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  private async run(req: CompletionRequest, cb: StreamCallbacks, signal: AbortSignal, fallbacks: boolean): Promise<CompletionResult> {
    const { body, betas } = buildRequest(req, { fallbacks, stream: true });
    // The beta namespace carries context_management / fallbacks; types for these evolve quickly,
    // so the body is assembled as plain JSON and validated by the API.
    const stream = this.client.beta.messages.stream({ ...(body as object), betas } as never, { signal });
    for await (const ev of stream as AsyncIterable<Record<string, any>>) {
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') cb.onText?.(ev.delta.text);
        else if (ev.delta?.type === 'thinking_delta') cb.onThinking?.(ev.delta.thinking);
      }
    }
    const msg = (await stream.finalMessage()) as unknown as { content: Block[]; stop_reason?: string; stop_details?: unknown; usage?: unknown };
    // Fallback blocks (server-side model switch) are informational; keep them in native content.
    for (const b of msg.content) {
      if (b.type === 'fallback') {
        const from = (b as any).from?.model ?? (b as any).from_?.model;
        const to = (b as any).to?.model;
        cb.onNotice?.('info', `Model ${from ?? '?'} declined; ${to ?? 'fallback model'} continued.`);
      }
    }
    return parseMessage(msg);
  }
}
