import { afterEach, describe, expect, it } from 'vitest';
import { selectMembers } from '@ba/shared';
import { OpenAICompatProvider, toolDefinitions } from '../src/providers/openai.ts';
import { chooseCut, clearDiscoveredWindows, findContextWindow, guardedHistory, omissionNote, parseOverflow } from '../src/providers/context-guard.ts';
import type { ModelProfile, Turn } from '../src/providers/types.ts';
import { fakeServer, openaiSse } from './fake-servers.ts';

const members = selectMembers({});
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** A fake llama.cpp: counts "tokens" more expensively than our estimate and enforces a window. */
async function fakeLlama(window: number, models?: unknown[]) {
  const sizes: number[] = [];
  const srv = await fakeServer((req, n) => {
    const tokens = Math.ceil((JSON.stringify(req.body.messages).length + JSON.stringify(req.body.tools ?? []).length) / 2.6);
    sizes.push(tokens);
    if (tokens > window) {
      return { status: 400, json: { error: { code: 400, message: `request (${tokens} tokens) exceeds the available context size (${window} tokens), try increasing it`, type: 'exceed_context_size_error' } } };
    }
    const sse = openaiSse({ calls: [{ id: `call_${n}`, name: 'read_page', args: '{"filter":"interactive"}' }] }) as any[];
    sse[sse.length - 2] = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: tokens, completion_tokens: 20, prompt_tokens_details: { cached_tokens: Math.floor(tokens * 0.9) } } };
    return { sse };
  }, { models });
  closers.push(srv.close);
  return { ...srv, sizes };
}

const prof = (url: string, patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'q', label: 'Qwen', provider: 'openai', model: 'qwen', vision: true, baseURL: `${url}/v1`, ...patch });

const pageText = (i: number) => `Page outline after step ${i}\n` + Array.from({ length: 40 }, (_, k) => `button "Play lesson ${i}.${k}" [ref_${k}]`).join('\n');

function checkValid(messages: any[]): void {
  expect(messages[0].role).toBe('system');
  expect(messages[1]).toMatchObject({ role: 'user', content: 'Click play on every video in the course' });
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) open.add(c.id);
    if (m.role === 'tool') {
      expect(open.has(m.tool_call_id), `tool result ${m.tool_call_id} without its call`).toBe(true);
      open.delete(m.tool_call_id);
    }
  }
}

/** Drive a long task the way the session does: append the call and its result each step. */
async function longTask(p: OpenAICompatProvider, profile: ModelProfile, steps: number) {
  const history: Turn[] = [{ role: 'user', parts: [{ type: 'text', text: 'Click play on every video in the course' }] }];
  const notices: string[] = [];
  const contexts: { used: number; window?: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const res = await p.complete({ system: 'You are a browser agent.', history, members, profile }, { onNotice: (_l, m) => notices.push(m) }, new AbortController().signal);
    contexts.push(res.context!);
    history.push({ role: 'assistant', parts: res.parts });
    const call = res.parts.find((x) => x.type === 'tool_call') as { id: string };
    history.push({
      role: 'tool_results',
      results: [{ callId: call.id, member: 'read_page', input: {}, result: { isError: false, content: [{ type: 'text', text: pageText(i) }] } }],
      ...(i === 5 ? { notes: ['your coordinates for the button are wrong'] } : {}),
    });
    if (i === 8) history.push({ role: 'user', parts: [{ type: 'text', text: 'continue' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'Continuing.' }] });
  }
  return { history, notices, contexts };
}

describe('context guard', () => {
  it('keeps a 120-step task inside a known context window without a single overflow', async () => {
    const llama = await fakeLlama(40_000);
    const profile = prof(llama.url, { contextTokens: 40_000 });
    const p = new OpenAICompatProvider(profile, '');
    const { notices, contexts } = await longTask(p, profile, 120);
    // The very first request calibrates the estimate; after that nothing is ever rejected.
    expect(llama.sizes.filter((s) => s > 40_000)).toEqual([]);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.length).toBeLessThan(15); // trims are occasional, not every step
    expect(notices[0]).toMatch(/oldest steps were trimmed to fit the model's 40k context/);
    for (const r of llama.requests) checkValid(r.body.messages);
    // The note keeps what the user said in the removed part.
    const last = llama.requests[llama.requests.length - 1].body.messages;
    const note = last[2].content as string;
    expect(note).toMatch(/earlier steps were removed/);
    expect(note).toContain('your coordinates for the button are wrong');
    expect(note).toContain('- continue');
    expect(contexts[contexts.length - 1].window).toBe(40_000);
  });

  it('learns the window from an overflow error, trims and retries the same step', async () => {
    const llama = await fakeLlama(40_000);
    const profile = prof(llama.url); // no contextTokens configured
    const p = new OpenAICompatProvider(profile, '');
    const { notices } = await longTask(p, profile, 80);
    const rejected = llama.sizes.filter((s) => s > 40_000);
    expect(rejected.length).toBe(1); // only the first overflow, then it knows
    expect(p.contextWindow()).toBe(40_000);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('keeps the request prefix stable between trims (prompt caching keeps working)', async () => {
    const llama = await fakeLlama(40_000);
    const profile = prof(llama.url, { contextTokens: 40_000 });
    const p = new OpenAICompatProvider(profile, '');
    const { notices } = await longTask(p, profile, 80);
    let breaks = 0;
    for (let i = 1; i < llama.requests.length; i++) {
      const a = llama.requests[i - 1].body.messages;
      const b = llama.requests[i].body.messages;
      const same = a.every((m: unknown, k: number) => JSON.stringify(m) === JSON.stringify(b[k]));
      if (!same) breaks++;
    }
    expect(breaks).toBe(notices.length);
  });

  it('does nothing for short tasks', async () => {
    const llama = await fakeLlama(40_000);
    const profile = prof(llama.url, { contextTokens: 40_000 });
    const p = new OpenAICompatProvider(profile, '');
    const { notices, history } = await longTask(p, profile, 5);
    expect(notices).toEqual([]);
    expect(llama.requests[4].body.messages.length).toBe(1 + history.length - 2);
  });

  it('reports cached prompt tokens separately from new ones', async () => {
    const llama = await fakeLlama(40_000);
    const profile = prof(llama.url);
    const p = new OpenAICompatProvider(profile, '');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile }, {}, new AbortController().signal);
    const total = llama.sizes[0];
    expect(res.usage.inputTokens + res.usage.cacheReadTokens).toBe(total);
    expect(res.usage.cacheReadTokens).toBe(Math.floor(total * 0.9));
    expect(res.context).toEqual({ used: total, window: undefined });
  });
});

describe('context window from the provider', () => {
  const ark = [
    { id: 'deepseek-v4-1-flash-260910', name: 'deepseek-v4-1-flash', created: 1, context_window: 524288 },
    { id: 'deepseek-v4-1-flash-261017', name: 'deepseek-v4-1-flash', created: 2, context_window: 1048576 },
    { id: 'deepseek-v4-1-flash-economy-261017', name: 'deepseek-v4-1-flash-economy', created: 2, context_window: 1048576 },
    { id: 'glm-5-3-flash-260828', name: 'glm-5-3-flash', created: 1, context_window: 1048576 },
    { id: 'qwen3-8b-20250429', name: 'qwen3-8b', created: 1, context_window: 131072 },
  ];
  it('matches Ark style dated ids and dotted names, newest first', () => {
    expect(findContextWindow(ark, 'deepseek-v4.1-flash')).toBe(1048576);
    expect(findContextWindow(ark, 'deepseek-v4.1-flash-economy')).toBe(1048576);
    expect(findContextWindow(ark, 'glm-5.3-flash')).toBe(1048576);
    expect(findContextWindow(ark, 'qwen3-8b')).toBe(131072);
    expect(findContextWindow(ark, 'deepseek-v4')).toBeUndefined();
  });
  it('reads NanoGPT / OpenRouter context_length, ignoring a :thinking suffix', () => {
    const nano = [{ id: 'deepseek/deepseek-v4.1-flash-uncensored', context_length: 1048576 }];
    expect(findContextWindow(nano, 'deepseek/deepseek-v4.1-flash-uncensored')).toBe(1048576);
    expect(findContextWindow(nano, 'deepseek/deepseek-v4.1-flash-uncensored:thinking')).toBe(1048576);
  });
  it('uses the reported window for trimming without any configuration', async () => {
    clearDiscoveredWindows();
    const llama = await fakeLlama(40_000, [{ id: 'qwen-20260101', name: 'qwen', context_window: 40_000 }]);
    const profile = prof(llama.url); // no contextTokens
    const p = new OpenAICompatProvider(profile, 'k');
    const { notices, contexts } = await longTask(p, profile, 120);
    expect(llama.modelLookups()).toBe(1);
    expect(p.contextWindow()).toBe(40_000);
    expect(contexts[0].window).toBe(40_000);
    expect(notices.length).toBeGreaterThan(0);
    expect(llama.sizes.filter((s) => s > 40_000)).toEqual([]);
  });
});

describe('context guard helpers', () => {
  const task: Turn = { role: 'user', parts: [{ type: 'text', text: 'task' }] };
  const step = (i: number): Turn[] => [
    { role: 'assistant', parts: [{ type: 'tool_call', id: `c${i}`, name: 'read_page', input: {} }] },
    { role: 'tool_results', results: [{ callId: `c${i}`, member: 'read_page', input: {}, result: { isError: false, content: [{ type: 'text', text: 'x' }] } }] },
  ];
  const history: Turn[] = [task, ...step(1), { role: 'user', parts: [{ type: 'text', text: 'go faster' }] }, ...step(2), ...step(3), ...step(4)];

  it('cuts at an assistant turn and always keeps the last two steps', () => {
    const per = history.map(() => 100);
    const st = chooseCut(history, per, 0, 1, { dropUntil: 0, squeeze: false });
    expect(history[st.dropUntil].role).toBe('assistant');
    expect(st.dropUntil).toBe(6); // steps 3 and 4 kept
    expect(st.squeeze).toBe(true); // still too big for the target
    const roomy = chooseCut(history, per, 0, 100 + 400 + 600, { dropUntil: 0, squeeze: false });
    expect(roomy).toEqual({ dropUntil: 4, squeeze: false });
  });

  it('builds the guarded history with a note carrying the user messages', () => {
    const h = guardedHistory(history, { dropUntil: 6, squeeze: false });
    expect(h[0]).toBe(task);
    expect((h[1] as any).parts[0].text).toMatch(/2 earlier steps were removed[\s\S]*- go faster/);
    expect(h.slice(2)).toEqual(history.slice(6));
    expect((omissionNote(history, 2) as any).parts[0]).toMatchObject({ text: expect.stringMatching(/1 earlier step was removed/) });
  });

  it('parses overflow errors from llama.cpp and OpenAI-style servers', () => {
    expect(parseOverflow('400 request (114697 tokens) exceeds the available context size (114688 tokens), try increasing it')).toEqual({ requested: 114697, window: 114688 });
    expect(parseOverflow("This model's maximum context length is 32768 tokens. However, you requested 40000 tokens")).toEqual({ window: 32768, requested: 40000 });
    expect(parseOverflow('Invalid API Key')).toBeNull();
  });

  it('tool definitions are counted (they are a big fixed cost)', () => {
    expect(JSON.stringify(toolDefinitions(members)).length).toBeGreaterThan(5000);
  });
});
