import { afterEach, describe, expect, it } from 'vitest';
import { selectMembers } from '@ba/shared';
import { AnthropicProvider, buildRequest, buildToolsetEntry, toAnthropicMessages } from '../src/providers/anthropic.ts';
import { OpenAICompatProvider, parseJsonToolCalls, toOpenAIMessages, toolDefinitions } from '../src/providers/openai.ts';
import { MockProvider, findRef, registerScript } from '../src/providers/mock.ts';
import type { ModelProfile, Turn } from '../src/providers/types.ts';
import { anthropicSse, fakeServer, openaiSse } from './fake-servers.ts';

const members = selectMembers({});
const IMG = { type: 'image' as const, mediaType: 'image/jpeg' as const, data: 'AAAA' };

function anthropicProfile(baseURL: string, patch: Partial<ModelProfile> = {}): ModelProfile {
  return { id: 'claude', label: 'Claude', provider: 'anthropic', model: 'claude-opus-5-5', vision: true, baseURL, effort: 'medium', ...patch };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('anthropic: toolset entry', () => {
  it('declares the toolset with no configs for the default member set', () => {
    expect(buildToolsetEntry(members)).toEqual({ type: 'browser_toolset_20260801' });
  });
  it('enables optional members and disables removed ones via configs', () => {
    const e = buildToolsetEntry(selectMembers({ vision: false, enableOptional: { javascript_exec: true } }));
    expect(e.configs).toEqual({ screenshot: { enabled: false }, zoom: { enabled: false }, javascript_exec: { enabled: true } });
  });
});

describe('anthropic: message conversion', () => {
  const native = [
    { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_page', input: {}, toolset_name: 'browser' },
  ];
  const history: Turn[] = [
    { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'toolu_1', name: 'read_page', input: {} }], native: { provider: 'anthropic', content: native } },
    {
      role: 'tool_results',
      results: [
        {
          callId: 'toolu_1',
          member: 'read_page',
          input: {},
          result: { isError: false, content: [{ type: 'text', text: 'link "Docs" [ref_1]' }, IMG, { type: 'browser_state', tabs: [{ tab_id: 'tab-1', title: 'x', url: 'https://x', active: true }] }] },
        },
      ],
    },
  ];
  it('replays assistant content verbatim and echoes toolset_name on results', () => {
    const m = toAnthropicMessages(history);
    expect(m[1]).toEqual({ role: 'assistant', content: native });
    const tr = (m[2].content as any[])[0];
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', toolset_name: 'browser' });
    expect(tr.content.map((b: any) => b.type)).toEqual(['text', 'image', 'browser_state']);
    expect(tr.content[1].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
    expect(tr.is_error).toBeUndefined();
  });
  it('drops browser_state from error results and never sends empty content', () => {
    const h: Turn[] = [
      { role: 'tool_results', results: [{ callId: 't', member: 'left_click', input: {}, result: { isError: true, content: [{ type: 'browser_state', tabs: [] } as any] } }] },
    ];
    const tr = (toAnthropicMessages(h)[0].content as any[])[0];
    expect(tr.is_error).toBe(true);
    expect(tr.content).toEqual([{ type: 'text', text: 'Error.' }]);
  });
  it('is deterministic and append-only (request prefix stays byte-identical)', () => {
    const a = JSON.stringify(toAnthropicMessages(history));
    const longer = [...history, { role: 'assistant', parts: [{ type: 'text', text: 'done' }] } as Turn];
    const b = JSON.stringify(toAnthropicMessages(longer));
    expect(b.startsWith(a.slice(0, -1))).toBe(true);
  });
  it('rebuilds assistant turns from other providers with toolset_name', () => {
    const h: Turn[] = [{ role: 'assistant', parts: [{ type: 'thinking', text: 'x' }, { type: 'text', text: 'ok' }, { type: 'tool_call', id: 'c1', name: 'navigate', input: { url: 'a.com' } }] }];
    expect(toAnthropicMessages(h)[0].content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'c1', name: 'navigate', input: { url: 'a.com' }, toolset_name: 'browser' },
    ]);
  });
  it('builds the request with adaptive thinking, caching, context editing and fallbacks', () => {
    const { body, betas } = buildRequest({ system: 'SYS', history, members, profile: anthropicProfile('http://x') }, { fallbacks: true, stream: true });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.fallbacks).toBe('default');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('tool_choice');
    expect((body.context_management as any).edits[0].type).toBe('clear_tool_uses_20250919');
    expect(betas).toEqual(['context-management-2025-06-27', 'server-side-fallback-2026-07-01']);
  });
});

describe('anthropic: provider against a fake API', () => {
  it('streams thinking/text/tool calls and returns native content', async () => {
    const srv = await fakeServer(() => ({
      sse: anthropicSse([
        { type: 'thinking', thinking: 'Look at the page first.', signature: 'S1' },
        { type: 'text', text: 'Reading the page.' },
        { type: 'tool_use', id: 'toolu_9', name: 'read_page', input: { filter: 'interactive' } },
      ]),
    }));
    closers.push(srv.close);
    const p = new AnthropicProvider(anthropicProfile(srv.url), 'sk-test');
    const deltas: string[] = [];
    const thinking: string[] = [];
    const res = await p.complete({ system: 'SYS', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile: anthropicProfile(srv.url) }, { onText: (d) => deltas.push(d), onThinking: (d) => thinking.push(d) }, new AbortController().signal);
    expect(deltas.join('')).toBe('Reading the page.');
    expect(thinking.join('')).toBe('Look at the page first.');
    expect(res.stopReason).toBe('tool_use');
    expect(res.parts).toEqual([
      { type: 'thinking', text: 'Look at the page first.' },
      { type: 'text', text: 'Reading the page.' },
      { type: 'tool_call', id: 'toolu_9', name: 'read_page', input: { filter: 'interactive' } },
    ]);
    const nativeContent = res.native!.content as any[];
    expect(nativeContent[0]).toMatchObject({ type: 'thinking', signature: 'S1' });
    expect(nativeContent[2]).toMatchObject({ type: 'tool_use', toolset_name: 'browser' });
    expect(res.usage).toMatchObject({ inputTokens: 100, outputTokens: 42, cacheReadTokens: 40, cacheWriteTokens: 10 });
    const req = srv.requests[0];
    expect(req.url).toContain('/v1/messages');
    // The profile's key is used — never ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL from the shell.
    const auth = String(req.headers['x-api-key'] ?? req.headers.authorization ?? '');
    expect(auth.replace(/^Bearer /, '')).toBe('sk-test');
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(req.body.tools).toEqual([{ type: 'browser_toolset_20260801' }]);
    expect(req.body.stream).toBe(true);
  });

  it('retries without fallbacks when the API rejects them', async () => {
    const srv = await fakeServer((r, n) =>
      n === 1 ? { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not supported for this model' } } } : { sse: anthropicSse([{ type: 'text', text: 'ok' }]) },
    );
    closers.push(srv.close);
    const notices: string[] = [];
    const p = new AnthropicProvider(anthropicProfile(srv.url), 'k');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], members, profile: anthropicProfile(srv.url) }, { onNotice: (_l, m) => notices.push(m) }, new AbortController().signal);
    expect(res.parts).toEqual([{ type: 'text', text: 'ok' }]);
    expect(srv.requests.length).toBe(2);
    expect(srv.requests[1].body.fallbacks).toBeUndefined();
    expect(notices[0]).toMatch(/fallbacks/i);
  });

  it('reports refusals with their category', async () => {
    const srv = await fakeServer(() => ({ sse: anthropicSse([{ type: 'text', text: '' }], { stop: 'refusal', stopDetails: { type: 'refusal', category: 'cyber', explanation: 'nope' } }) }));
    closers.push(srv.close);
    const p = new AnthropicProvider(anthropicProfile(srv.url, { fallbacks: 'off' }), 'k');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], members, profile: anthropicProfile(srv.url) }, {}, new AbortController().signal);
    expect(res.stopReason).toBe('refusal');
    expect(srv.requests[0].body.fallbacks).toBeUndefined();
  });

  it('surfaces non-retryable API errors as ProviderError', async () => {
    const srv = await fakeServer(() => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    closers.push(srv.close);
    const p = new AnthropicProvider(anthropicProfile(srv.url, { fallbacks: 'off' }), 'bad');
    await expect(p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], members, profile: anthropicProfile(srv.url) }, {}, new AbortController().signal)).rejects.toThrow(/401/);
  });
});

describe('openai: conversion', () => {
  const profile: ModelProfile = { id: 'o', label: 'O', provider: 'openai', model: 'gpt', vision: true, keepImages: 3 };
  const toolTurn = (id: string, withImage: boolean): Turn[] => [
    { role: 'assistant', parts: [{ type: 'tool_call', id, name: 'screenshot', input: {} }] },
    { role: 'tool_results', results: [{ callId: id, member: 'screenshot', input: {}, result: { isError: false, content: withImage ? [IMG] : [{ type: 'text', text: 'ok' }] } }] },
  ];
  it('defines function tools for every member', () => {
    const defs = toolDefinitions(members);
    expect(defs.length).toBe(members.length);
    expect(defs[0]).toMatchObject({ type: 'function', function: { name: 'navigate' } });
  });
  it('sends tool results as tool messages and images as a following user message', () => {
    const h: Turn[] = [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }, ...toolTurn('c1', true)];
    const m = toOpenAIMessages('SYS', h, profile);
    expect(m.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(m[2].tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } });
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'Screenshot captured.' });
    expect(m[4].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA');
  });
  it('omits images for non-vision models', () => {
    const m = toOpenAIMessages('SYS', [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }, ...toolTurn('c1', true)], { ...profile, vision: false });
    expect(m.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(m[3].content).toMatch(/no vision/);
  });
  it('prunes old screenshots in batches so the prefix is stable between prunes', () => {
    const mk = (n: number) => {
      const h: Turn[] = [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }];
      for (let i = 0; i < n; i++) h.push(...toolTurn(`c${i}`, true));
      return toOpenAIMessages('S', h, profile);
    };
    const count = (msgs: any[]) => msgs.filter((x) => x.role === 'user' && Array.isArray(x.content)).length;
    expect(count(mk(10))).toBe(10); // cutoff floor((10-3)/8)*8 = 0
    expect(count(mk(11))).toBe(3); // cutoff 8
    expect(count(mk(12))).toBe(4);
    // Between prune events, request N is a prefix of request N+1.
    const a = JSON.stringify(mk(11));
    const b = JSON.stringify(mk(12));
    expect(b.startsWith(a.slice(0, -1))).toBe(true);
  });
  it('renders json tool mode as text blocks', () => {
    const m = toOpenAIMessages('S', [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }, ...toolTurn('c1', false)], { ...profile, toolMode: 'json' });
    expect(m[2].content).toContain('```tool\n{"name":"screenshot","input":{}}\n```');
    expect(m[3].role).toBe('user');
    expect(m[3].content).toContain('Result of screenshot (call c1)');
  });
  it('parses json tool calls leniently', () => {
    const r = parseJsonToolCalls('I will click.\n```tool\n{"name":"left_click","input":{"target":{"type":"ref","ref":"ref_2"}}}\n```\n```json\n[{"tool":"key","arguments":{"text":"Enter"}}]\n```');
    expect(r.calls).toEqual([
      { name: 'left_click', input: { target: { type: 'ref', ref: 'ref_2' } } },
      { name: 'key', input: { text: 'Enter' } },
    ]);
    expect(r.rest).toBe('I will click.');
    expect(parseJsonToolCalls('```tool\n{oops}\n```').errors.length).toBe(1);
  });
});

describe('openai: provider against a fake API', () => {
  const prof = (url: string, patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'o', label: 'O', provider: 'openai', model: 'gpt-x', vision: true, baseURL: `${url}/v1`, ...patch });

  it('assembles streamed tool calls, reasoning and usage', async () => {
    const srv = await fakeServer(() => ({ sse: openaiSse({ reasoning: 'think', text: 'On it.', calls: [{ id: 'call_1', name: 'navigate', args: '{"url":"example.com"}' }, { id: 'call_2', name: 'read_page', args: '' }] }) }));
    closers.push(srv.close);
    const p = new OpenAICompatProvider(prof(srv.url), 'sk-o');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile: prof(srv.url) }, {}, new AbortController().signal);
    expect(res.parts).toEqual([
      { type: 'thinking', text: 'think' },
      { type: 'text', text: 'On it.' },
      { type: 'tool_call', id: 'call_1', name: 'navigate', input: { url: 'example.com' } },
      { type: 'tool_call', id: 'call_2', name: 'read_page', input: {} },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toMatchObject({ inputTokens: 8, outputTokens: 7, cacheReadTokens: 3 });
    expect(srv.requests[0].headers.authorization).toBe('Bearer sk-o');
    expect(srv.requests[0].body.tools.length).toBe(members.length);
    expect(srv.requests[0].body.stream).toBe(true);
  });

  it('works non-streaming and strips <think> tags', async () => {
    const srv = await fakeServer(() => ({ json: { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '<think>plan</think>All done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } } }));
    closers.push(srv.close);
    const p = new OpenAICompatProvider(prof(srv.url, { stream: false }), '');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile: prof(srv.url) }, {}, new AbortController().signal);
    expect(res.parts).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'All done.' },
    ]);
    expect(res.stopReason).toBe('end_turn');
  });

  it('flags malformed tool arguments instead of crashing', async () => {
    const srv = await fakeServer(() => ({ sse: openaiSse({ calls: [{ id: 'call_1', name: 'navigate', args: '{"url": ' }] }) }));
    closers.push(srv.close);
    const p = new OpenAICompatProvider(prof(srv.url), 'k');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile: prof(srv.url) }, {}, new AbortController().signal);
    expect((res.parts[0] as any).input.__invalid_arguments__).toMatch(/Invalid JSON/);
  });

  it('json tool mode turns fenced blocks into calls', async () => {
    const srv = await fakeServer(() => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Reading.\n```tool\n{"name": "read_page", "input": {}}\n```' }, finish_reason: 'stop' }] } }));
    closers.push(srv.close);
    const p = new OpenAICompatProvider(prof(srv.url, { toolMode: 'json', stream: false }), '');
    const res = await p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile: prof(srv.url, { toolMode: 'json' }) }, {}, new AbortController().signal);
    expect(res.stopReason).toBe('tool_use');
    expect(res.parts[1]).toMatchObject({ type: 'tool_call', name: 'read_page' });
    expect(srv.requests[0].body.tools).toBeUndefined();
    expect(srv.requests[0].body.messages[0].content).toContain('```tool');
  });

  it('gives a helpful error when a local server is down', async () => {
    const p = new OpenAICompatProvider(prof('http://127.0.0.1:1', { stream: false }), '');
    await expect(p.complete({ system: 'S', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], members, profile: prof('http://127.0.0.1:1') }, {}, new AbortController().signal)).rejects.toThrow(/reach|Connection|connect/i);
  }, 30_000);
});

describe('mock provider', () => {
  it('finds refs in outline text', () => {
    const t = 'heading "Login" [ref_1]\n  textbox "Username" [ref_2] value=""\n  button "Sign \\"in\\"" [ref_3]';
    expect(findRef(t, 'textbox', 'Username')).toBe('ref_2');
    expect(findRef(t, 'button', 'Sign "in"')).toBe('ref_3');
    expect(findRef(t, 'button', /sign/i)).toBe('ref_3');
    expect(findRef(t, 'link', 'x')).toBeUndefined();
  });
  it('runs scripts selected by #script tags', async () => {
    registerScript('t1', (c) => (c.step === 0 ? { calls: [{ name: 'read_page' }] } : { text: 'done' }));
    const m = new MockProvider();
    const r = await m.complete({ system: '', history: [{ role: 'user', parts: [{ type: 'text', text: 'x #script:t1' }] }], members, profile: { id: 'mock', label: 'm', provider: 'mock', model: 'm', vision: false } }, {}, new AbortController().signal);
    expect(r.stopReason).toBe('tool_use');
  });
});
