/**
 * OpenAI-compatible provider (Chat Completions). Covers OpenAI, Google Gemini (OpenAI endpoint),
 * Groq, OpenRouter, Together, DeepSeek, xAI, Mistral, and local servers: Ollama, LM Studio, vLLM,
 * llama.cpp. Browser members are exposed as ordinary function tools with the same names/inputs as
 * Anthropic's toolset. Two tool modes:
 *   native – the server's function-calling API
 *   json   – a text protocol for models without tool calling (tool calls in ```tool fences)
 */
import OpenAI from 'openai';
import { memberSpecs, renderResultForText, truncate, type BrowserMember, type ImageBlock } from '@ba/shared';
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
import { chooseCut, discoverContextWindow, estimateTokens, guardState, guardedHistory, parseOverflow, saveGuardState, type GuardState } from './context-guard.ts';

type Msg = Record<string, any>;

const IMAGE_BATCH = 8;
const OLD_TEXT_LIMIT = 6000;

export function toolDefinitions(members: BrowserMember[]): Msg[] {
  return memberSpecs(members).map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

/** Prompt section describing the JSON tool protocol (json tool mode). */
export function jsonToolPrompt(members: BrowserMember[]): string {
  const lines = memberSpecs(members).map((s) => `- ${s.name}: ${s.description}\n  input schema: ${JSON.stringify(s.parameters)}`);
  return [
    '# Tools',
    'You control the browser by emitting tool calls. To call tools, output one or more fenced blocks exactly like:',
    '```tool',
    '{"name": "read_page", "input": {"filter": "interactive"}}',
    '```',
    'Several blocks in one reply run in order and stop at the first failure. After your tool calls, stop and wait: the results arrive in the next message.',
    'When the task is complete (or you need the user), reply with plain text and no tool blocks.',
    '',
    'Available tools:',
    ...lines,
  ].join('\n');
}

/** Extract ```tool {...}``` blocks from a text reply (json tool mode). */
export function parseJsonToolCalls(text: string): { calls: { name: string; input: Record<string, unknown> }[]; rest: string; errors: string[] } {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const re = /```(?:tool|tool_call|json)\s*\n([\s\S]*?)```/g;
  let rest = text;
  for (const m of text.matchAll(re)) {
    rest = rest.replace(m[0], '');
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of list) {
        const name = c?.name ?? c?.tool ?? c?.function;
        const input = c?.input ?? c?.arguments ?? c?.parameters ?? {};
        if (typeof name === 'string') calls.push({ name, input: typeof input === 'string' ? JSON.parse(input) : input });
        else errors.push(`Tool block without a "name": ${truncate(raw, 200)}`);
      }
    } catch (e) {
      errors.push(`Could not parse tool block as JSON: ${truncate(raw, 200)}`);
    }
  }
  return { calls, rest: rest.trim(), errors };
}

/**
 * Deterministic conversion with batched pruning: old screenshots are replaced by a placeholder
 * and old long tool texts are truncated, but the cut-off only moves every IMAGE_BATCH images so
 * the prefix stays stable between prune events (good for automatic prefix caching).
 */
export function toOpenAIMessages(
  system: string,
  history: Turn[],
  profile: ModelProfile,
  opts: { owners?: number[]; squeeze?: boolean } = {},
): Msg[] {
  const json = profile.toolMode === 'json';
  const keep = opts.squeeze ? 1 : (profile.keepImages ?? 3);
  const vision = profile.vision;

  // Count images across tool results / user turns to decide the cut-off ordinal.
  let totalImages = 0;
  for (const t of history) {
    if (t.role === 'tool_results') for (const r of t.results) totalImages += r.result.content.filter((b) => b.type === 'image').length;
    if (t.role === 'user') totalImages += t.parts.filter((p) => p.type === 'image').length;
  }
  const imageCutoff = Math.max(0, Math.floor((totalImages - keep) / IMAGE_BATCH) * IMAGE_BATCH);
  // Tool-result text truncation follows the same batching on the number of tool-result turns.
  const resultTurns = history.filter((t) => t.role === 'tool_results').length;
  const textCutoff = opts.squeeze ? Math.max(0, resultTurns - 1) : Math.max(0, Math.floor((resultTurns - 6) / IMAGE_BATCH) * IMAGE_BATCH);
  const oldLimit = opts.squeeze ? 1500 : OLD_TEXT_LIMIT;

  const msgs: Msg[] = [{ role: 'system', content: system }];
  opts.owners?.push(-1);
  let cur = -1;
  const push = (m: Msg) => {
    msgs.push(m);
    opts.owners?.push(cur);
  };
  let imageOrdinal = 0;
  let resultTurnOrdinal = 0;
  const dedupe: { lastTabContext?: string } = {};

  const imagePart = (img: ImageBlock): Msg | null => {
    const ord = imageOrdinal++;
    if (!vision || ord < imageCutoff) return null;
    return { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } };
  };

  for (const turn of history) {
    cur++;
    if (turn.role === 'user') {
      const content: Msg[] = [];
      for (const p of turn.parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        else {
          const ip = imagePart(p);
          if (ip) content.push(ip);
        }
      }
      push({ role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content });
    } else if (turn.role === 'assistant') {
      const text = turn.parts
        .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const calls = turn.parts.filter((p): p is Extract<AssistantPart, { type: 'tool_call' }> => p.type === 'tool_call');
      if (json) {
        const blocks = calls.map((c) => '```tool\n' + JSON.stringify({ name: c.name, input: c.input }) + '\n```');
        push({ role: 'assistant', content: [text, ...blocks].filter(Boolean).join('\n') || '(no response)' });
      } else {
        const m: Msg = { role: 'assistant', content: text || null };
        if (profile.replayReasoning) {
          const reasoning = turn.parts.filter((p) => p.type === 'thinking').map((p) => (p as { text: string }).text).join('\n');
          if (reasoning) m.reasoning_content = reasoning;
        }
        if (calls.length)
          m.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
        if (!text && !calls.length) m.content = '(no response)';
        push(m);
      }
    } else {
      const truncateOld = resultTurnOrdinal++ < textCutoff;
      const pendingImages: { label: string; part: Msg }[] = [];
      const jsonTexts: string[] = [];
      for (const r of turn.results) {
        let { text, images } = renderResultForText(r.member, r.input, r.result, dedupe);
        if (r.result.isError && !/^(error|not executed)/i.test(text)) text = `Error: ${text}`;
        if (truncateOld && text.length > oldLimit) text = text.slice(0, opts.squeeze ? 1000 : 1500) + '\n[... older output truncated ...]';
        let dropped = 0;
        for (const img of images) {
          const ip = imagePart(img);
          if (ip) pendingImages.push({ label: `Image from ${r.member} (call ${r.callId}):`, part: ip });
          else dropped++;
        }
        if (dropped) text += vision ? '\n[older screenshot omitted to save context]' : '\n[image omitted: this model has no vision; use read_page/get_page_text]';
        if (json) jsonTexts.push(`Result of ${r.member} (call ${r.callId})${r.result.isError ? ' [error]' : ''}:\n${text}`);
        else push({ role: 'tool', tool_call_id: r.callId, content: text });
      }
      if (json) {
        const content: Msg[] = [{ type: 'text', text: jsonTexts.join('\n\n') }];
        for (const pi of pendingImages) content.push({ type: 'text', text: pi.label }, pi.part);
        push({ role: 'user', content: content.length === 1 ? content[0].text : content });
      } else if (pendingImages.length) {
        // Chat Completions tool messages are text-only: images follow as a user message.
        const content: Msg[] = [];
        for (const pi of pendingImages) content.push({ type: 'text', text: pi.label }, pi.part);
        push({ role: 'user', content });
      }
      for (const n of turn.notes ?? []) push({ role: 'user', content: `[Message from the user, sent while you were working]\n${n}` });
    }
  }
  return msgs;
}

function usageOf(u: any): Usage {
  // prompt_tokens includes cached tokens; report them separately (Anthropic-style) so totals
  // aren't counted twice.
  const prompt = Number(u?.prompt_tokens ?? 0);
  const cached = Math.min(prompt, Number(u?.prompt_tokens_details?.cached_tokens ?? 0));
  return {
    inputTokens: prompt - cached,
    outputTokens: Number(u?.completion_tokens ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

let callCounter = 0;
const genId = () => `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`;

export class OpenAICompatProvider implements Provider {
  readonly name = 'openai';
  private client: OpenAI;
  /** Real prompt tokens / estimated tokens, learned from responses. */
  private calib = 1;
  /** Context window learned from an overflow error when the profile doesn't set one. */
  private learnedWindow?: number;
  /** Context window the provider reports in its model list (looked up once). */
  private reportedWindow?: number;
  private lookedUp = false;

  constructor(
    private profile: ModelProfile,
    private apiKey: string,
  ) {
    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      // Explicit endpoint: never inherit OPENAI_BASE_URL from the environment.
      baseURL: profile.baseURL ?? 'https://api.openai.com/v1',
      organization: null,
      project: null,
      maxRetries: 3,
      timeout: profile.timeoutMs ?? 5 * 60 * 1000,
      defaultHeaders: profile.headers,
    });
  }

  /** Configured window, else one learned from an overflow error, else what the provider reports. */
  contextWindow(): number | undefined {
    return this.profile.contextTokens ?? this.learnedWindow ?? this.reportedWindow;
  }

  async complete(req: CompletionRequest, cb: StreamCallbacks, signal: AbortSignal): Promise<CompletionResult> {
    const p = this.profile;
    if (!p.contextTokens && !this.lookedUp && p.baseURL) {
      this.lookedUp = true;
      this.reportedWindow = await discoverContextWindow(p.baseURL, p.model, this.apiKey, p.headers);
    }
    const json = p.toolMode === 'json';
    const system = json ? `${req.system}\n\n${jsonToolPrompt(req.members)}` : req.system;
    const tools = json || !req.members.length ? undefined : toolDefinitions(req.members);
    const build = (st: GuardState) => toOpenAIMessages(system, guardedHistory(req.history, st), p, { squeeze: st.squeeze });

    let st = guardState(req.history);
    let messages = build(st);
    let forced = false;
    for (let attempt = 0; ; attempt++) {
      const window = this.contextWindow();
      if (window) {
        const before = st;
        st = this.fit(req.history, st, messages, system, tools, window, forced);
        if (st !== before) {
          saveGuardState(req.history, st);
          messages = build(st);
          const dropped = req.history.slice(1, st.dropUntil).filter((t) => t.role === 'assistant').length;
          cb.onNotice?.('info', `This chat got long, so the ${dropped} oldest steps were trimmed to fit the model's ${Math.round(window / 1000)}k context. Your task and messages are kept.`);
        }
      }
      const estimate = estimateTokens(messages, tools);
      const body: Msg = {
        model: p.model,
        messages,
        ...(p.maxTokens ? { max_completion_tokens: p.maxTokens } : {}),
        ...(p.extraBody ?? {}),
      };
      if (tools) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      try {
        const raw = p.stream === false ? await this.once(body, signal, cb) : await this.streamed(body, signal, cb);
        const prompt = raw.usage.inputTokens + raw.usage.cacheReadTokens;
        if (prompt > 0 && estimate > 0) this.calib = Math.min(2.5, Math.max(0.4, prompt / estimate));
        const result = this.finish(raw, json, cb);
        result.context = { used: prompt || Math.round(estimate * this.calib), window: this.contextWindow() };
        return result;
      } catch (e) {
        const err = this.wrap(e);
        const overflow = attempt === 0 && !signal.aborted && err instanceof ProviderError && err.status === 400 ? parseOverflow(err.message) : null;
        if (!overflow) throw err;
        // Learn the real window and how far off the estimate was, then trim and retry once.
        if (overflow.window && !p.contextTokens) this.learnedWindow = overflow.window;
        if (overflow.requested && estimate > 0) this.calib = Math.min(2.5, Math.max(this.calib, overflow.requested / estimate));
        if (!this.contextWindow()) this.learnedWindow = Math.round((overflow.requested ?? estimate * this.calib) * 0.95);
        forced = true;
      }
    }
  }

  /** Decide whether to trim, returning the (possibly new) guard state. */
  private fit(history: Turn[], st: GuardState, messages: Msg[], system: string, tools: unknown, window: number, forced: boolean): GuardState {
    const reserve = Math.min(Math.round(window * 0.25), Math.max(4096, this.profile.maxTokens ?? 8192));
    const usable = window - reserve;
    const est = (m: Msg[], t?: unknown) => Math.ceil(estimateTokens(m, t) * this.calib);
    if (!forced && est(messages, tools) <= usable * 0.9) return st;
    // Per-turn cost over the full history (owner index per message).
    const owners: number[] = [];
    const full = toOpenAIMessages(system, history, this.profile, { owners });
    const perTurn = new Array(history.length).fill(0);
    let fixed = est([], tools) + est([full[0]]);
    full.forEach((m, i) => {
      if (owners[i] >= 0) perTurn[owners[i]] += est([m]);
    });
    let next = chooseCut(history, perTurn, fixed, Math.round(usable * 0.6), st);
    // Verify with the real conversion; squeeze old outputs too if it still doesn't fit.
    const check = toOpenAIMessages(system, guardedHistory(history, next), this.profile, { squeeze: next.squeeze });
    if (!next.squeeze && est(check, tools) > usable * 0.9) next = { ...next, squeeze: true };
    return next.dropUntil === st.dropUntil && next.squeeze === st.squeeze ? st : next;
  }

  private wrap(e: unknown): Error {
    if (e instanceof ProviderError) return e;
    if (e instanceof OpenAI.APIConnectionError) {
      // Connected and sent the request, then the server hung up without a reply (e.g. NVIDIA NIM
      // when a model is overloaded or the account can't run it): not an unreachable server.
      const inner = (e as { cause?: { cause?: { code?: string; message?: string } } }).cause?.cause;
      if (inner && /UND_ERR_SOCKET|ECONNRESET/.test(inner.code ?? '') || /other side closed|socket hang up/i.test(inner?.message ?? '')) {
        return new ProviderError(`${this.profile.label}: the server took the request but closed the connection without answering. The model may be overloaded, or the account can't run it yet.`, true);
      }
      return new ProviderError(`Cannot reach ${this.profile.baseURL ?? 'the model server'} for "${this.profile.label}". Is it running and is the URL right?`, true);
    }
    if (e instanceof OpenAI.APIError) {
      const status = e.status;
      const retryable = status === 429 || (status != null && status >= 500);
      return new ProviderError(`${this.profile.label} API error${status ? ` ${status}` : ''}: ${e.message}`, retryable, status);
    }
    if (e instanceof Error && /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(e.message + String((e as any).cause ?? ''))) {
      return new ProviderError(`Cannot reach ${this.profile.baseURL ?? 'the model server'} (${e.message}). Is it running?`, true);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  private async once(body: Msg, signal: AbortSignal, cb: StreamCallbacks) {
    const res: any = await this.client.chat.completions.create({ ...body, stream: false } as any, { signal });
    const choice = res.choices?.[0];
    const msg = choice?.message ?? {};
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (typeof reasoning === 'string' && reasoning) cb.onThinking?.(reasoning);
    if (msg.content) cb.onText?.(msg.content);
    return {
      text: msg.content ?? '',
      thinking: typeof reasoning === 'string' ? reasoning : '',
      toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, args: t.function?.arguments ?? '' })),
      finish: choice?.finish_reason ?? 'stop',
      usage: usageOf(res.usage),
    };
  }

  private async streamed(body: Msg, signal: AbortSignal, cb: StreamCallbacks) {
    const stream: any = await this.client.chat.completions.create(
      { ...body, stream: true, stream_options: { include_usage: true } } as any,
      { signal },
    );
    let text = '';
    let thinking = '';
    let finish = 'stop';
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      if (chunk.usage) usage = usageOf(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) {
        thinking += r;
        cb.onThinking?.(r);
      }
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        cb.onText?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? calls.size;
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    return { text, thinking, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v), finish, usage };
  }

  private finish(
    raw: { text: string; thinking: string; toolCalls: { id: string; name: string; args: string }[]; finish: string; usage: Usage },
    json: boolean,
    cb: StreamCallbacks,
  ): CompletionResult {
    const parts: AssistantPart[] = [];
    // Some local models leak <think>...</think> into content.
    let text = raw.text;
    let thinking = raw.thinking;
    const think = text.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
    if (think) {
      thinking = (thinking ? thinking + '\n' : '') + think[1].trim();
      text = text.slice(think[0].length);
    }
    if (thinking) parts.push({ type: 'thinking', text: thinking });

    if (json) {
      const { calls, rest, errors } = parseJsonToolCalls(text);
      if (rest) parts.push({ type: 'text', text: rest });
      for (const c of calls) parts.push({ type: 'tool_call', id: genId(), name: c.name, input: c.input ?? {} });
      for (const e of errors) cb.onNotice?.('warn', e);
      if (!calls.length && errors.length) {
        // Let the model see its own mistake: turn the bad block into a call that will fail.
        parts.push({ type: 'tool_call', id: genId(), name: '__invalid__', input: { error: errors.join('; ') } });
      }
    } else {
      if (text) parts.push({ type: 'text', text });
      for (const tc of raw.toolCalls) {
        let input: Record<string, unknown> = {};
        let bad: string | undefined;
        if (tc.args.trim()) {
          try {
            const parsed = JSON.parse(tc.args);
            input = parsed && typeof parsed === 'object' ? parsed : {};
          } catch {
            bad = `Invalid JSON arguments for ${tc.name}: ${truncate(tc.args, 200)}`;
          }
        }
        if (bad) {
          cb.onNotice?.('warn', bad);
          input = { __invalid_arguments__: bad };
        }
        parts.push({ type: 'tool_call', id: tc.id || genId(), name: tc.name, input });
      }
    }
    const hasCalls = parts.some((x) => x.type === 'tool_call');
    const stopReason = hasCalls ? 'tool_use' : raw.finish === 'length' ? 'max_tokens' : raw.finish === 'content_filter' ? 'refusal' : 'end_turn';
    return { parts, stopReason, usage: raw.usage };
  }
}
