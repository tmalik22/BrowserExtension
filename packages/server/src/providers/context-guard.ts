/**
 * Context guard for OpenAI-compatible (mostly local) models with a fixed context window.
 *
 * Every request carries the whole conversation, so long tasks grow until they no longer fit.
 * When an estimate of the next request crosses ~90% of the usable window, the oldest steps are
 * dropped (the original task and every user message are kept, as a short note) down to ~60%.
 * The cut point is remembered per conversation and only moves at the next trim, so the request
 * prefix stays stable in between (llama.cpp/vLLM prefix caching keeps working).
 */
import type { Turn } from './types.ts';

type Msg = Record<string, any>;

/** Rough cost of one screenshot (≤1.15 MP) for current vision models. */
export const IMAGE_TOKENS = 1200;
const CHARS_PER_TOKEN = 3.2;
const PER_MESSAGE = 8;

export interface GuardState {
  /** History index of the first kept turn after the task (0 = nothing dropped). */
  dropUntil: number;
  /** Also shorten old tool outputs hard (when even dropping steps isn't enough). */
  squeeze: boolean;
}

const states = new WeakMap<Turn, GuardState>();

export function guardState(history: Turn[]): GuardState {
  return (history[0] && states.get(history[0])) ?? { dropUntil: 0, squeeze: false };
}

export function saveGuardState(history: Turn[], st: GuardState): void {
  if (history[0]) states.set(history[0], st);
}

/** Raw token estimate of a message list (+ tool definitions), before calibration. */
export function estimateTokens(msgs: Msg[], tools?: unknown): number {
  let chars = tools ? JSON.stringify(tools).length : 0;
  let images = 0;
  for (const m of msgs) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === 'image_url') images++;
        else if (typeof p?.text === 'string') chars += p.text.length;
      }
    }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + msgs.length * PER_MESSAGE;
}

function userTexts(turn: Turn): string[] {
  if (turn.role === 'user') {
    const t = turn.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n').trim();
    return t ? [t] : [];
  }
  if (turn.role === 'tool_results') return (turn.notes ?? []).map((n) => n.trim()).filter(Boolean);
  return [];
}

/** The note that stands in for dropped steps. */
export function omissionNote(history: Turn[], dropUntil: number): Turn {
  const steps = history.slice(1, dropUntil).filter((t) => t.role === 'assistant').length;
  const said = history.slice(1, dropUntil).flatMap(userTexts).map((t) => `- ${t.length > 600 ? `${t.slice(0, 600)}…` : t}`);
  const lines = [
    `[Context note: ${steps} earlier step${steps === 1 ? ' was' : 's were'} removed to fit the model's context window. The original task is above and your most recent steps follow.`,
    ...(said.length ? ['Messages from the user in the removed part, oldest first:', ...said.slice(-20)] : []),
    'If you are unsure what has already been done or what the page looks like now, check (read_page / screenshot) before acting, and do not repeat finished work.]',
  ];
  return { role: 'user', parts: [{ type: 'text', text: lines.join('\n') }] };
}

/** The history the model actually sees under the current guard state. */
export function guardedHistory(history: Turn[], st: GuardState): Turn[] {
  if (!st.dropUntil || st.dropUntil <= 1 || st.dropUntil >= history.length) return history;
  return [history[0], omissionNote(history, st.dropUntil), ...history.slice(st.dropUntil)];
}

/**
 * Pick a new cut point so the kept part fits `targetTokens`.
 * `perTurn[i]` = estimated tokens of history[i] (calibrated); `fixed` = system + tools.
 */
export function chooseCut(history: Turn[], perTurn: number[], fixed: number, targetTokens: number, current: GuardState): GuardState {
  // Valid cuts: start of an assistant turn, after the task, keeping at least the last 2 steps.
  const cuts: number[] = [];
  for (let i = 2; i < history.length; i++) if (history[i].role === 'assistant' && i > current.dropUntil) cuts.push(i);
  const keepFrom = cuts.length > 2 ? cuts.length - 2 : cuts.length - 1;
  const usable = cuts.slice(0, Math.max(0, keepFrom + 1));
  if (!usable.length) return { dropUntil: current.dropUntil, squeeze: true };
  const suffix = new Array(history.length + 1).fill(0);
  for (let i = history.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + (perTurn[i] ?? 0);
  const noteCost = 400;
  for (const c of usable) {
    if (fixed + (perTurn[0] ?? 0) + noteCost + suffix[c] <= targetTokens) return { dropUntil: c, squeeze: false };
  }
  return { dropUntil: usable[usable.length - 1], squeeze: true };
}

// Context window discovery ------------------------------------------------------------------------

type ModelEntry = Record<string, any>;

/** Normalise a model id for matching: "deepseek-v4.1-flash:thinking" -> "deepseek-v4-1-flash". */
const normId = (s: string) => s.toLowerCase().replace(/:.*$/, '').replace(/[._\s]/g, '-');

function windowOf(m: ModelEntry): number | undefined {
  const v = m.context_window ?? m.context_length ?? m.max_context_length ?? m.max_model_len ?? m.top_provider?.context_length;
  return typeof v === 'number' && v >= 2048 ? v : undefined;
}

/**
 * Find `model` in a provider's /models list and return its context window. Matches the exact id,
 * the same id written with dots or dashes, its display name, or a dated variant
 * ("deepseek-v4-1-flash-261017"); among dated variants the newest wins.
 */
export function findContextWindow(models: ModelEntry[], model: string): number | undefined {
  const exact = models.find((m) => m.id === model);
  if (exact && windowOf(exact)) return windowOf(exact);
  const want = normId(model);
  const hits = models.filter((m) => {
    const id = typeof m.id === 'string' ? normId(m.id) : '';
    const name = typeof m.name === 'string' ? normId(m.name) : '';
    return id === want || name === want || (id.startsWith(`${want}-`) && /^-\d{6,8}$/.test(id.slice(want.length)));
  });
  hits.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  for (const h of hits) {
    const w = windowOf(h);
    if (w) return w;
  }
  return undefined;
}

const discovered = new Map<string, { window?: number; at: number }>();

/**
 * Ask an OpenAI-compatible provider how big the model's context window is (Ark, NanoGPT,
 * OpenRouter and vLLM all say so in /models). Cached per endpoint+model; failures retry after
 * 10 minutes. Returns undefined when the provider doesn't tell.
 */
export async function discoverContextWindow(baseURL: string, model: string, apiKey: string, headers?: Record<string, string>): Promise<number | undefined> {
  const key = `${baseURL}|${model}`;
  const hit = discovered.get(key);
  if (hit && (hit.window || Date.now() - hit.at < 10 * 60_000)) return hit.window;
  let window: number | undefined;
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models?detailed=true`, {
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: ModelEntry[] };
      if (Array.isArray(body.data)) window = findContextWindow(body.data, model);
    }
  } catch {
    /* provider unreachable or no model list: fall back to learning from errors */
  }
  discovered.set(key, { window, at: Date.now() });
  return window;
}

/** Tests only. */
export function clearDiscoveredWindows(): void {
  discovered.clear();
}

/** Parse "request (114697 tokens) exceeds the available context size (114688 tokens)" style errors. */
export function parseOverflow(message: string): { requested?: number; window?: number } | null {
  if (!/context (size|length|window)|exceeds|too long|maximum context|n_ctx/i.test(message)) return null;
  if (!/exceed|too long|maximum|greater than|larger than/i.test(message)) return null;
  const llama = message.match(/\((\d+) tokens\)[^()]*context size \((\d+) tokens\)/i);
  if (llama) return { requested: Number(llama[1]), window: Number(llama[2]) };
  const oai = message.match(/maximum context length is (\d+) tokens[\s\S]*?(\d+) tokens/i);
  if (oai) return { window: Number(oai[1]), requested: Number(oai[2]) };
  return {};
}
