import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, HALT_TEXT, type AgentEvent, type ApprovalDecision, type PolicySettings, type ToolResult } from '@ba/shared';
import { Session, normalizeResult, type ApprovalRequest, type BrowserLink, type SessionHost } from '../src/agent/session.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { ProviderError, type CompletionResult, type ModelProfile, type Provider, type Turn } from '../src/providers/types.ts';

const profile: ModelProfile = { id: 'p', label: 'P', provider: 'mock', model: 'm', vision: true };

/** Provider that replays a list of steps (each a function of the history). */
function scripted(steps: ((h: Turn[]) => Partial<CompletionResult> | Error)[]): Provider & { calls: number } {
  const p = {
    name: 'scripted',
    calls: 0,
    async complete(req: { history: Turn[] }, _cb: unknown, signal: AbortSignal): Promise<CompletionResult> {
      if (signal.aborted) throw new Error('aborted');
      const step = steps[Math.min(p.calls, steps.length - 1)];
      p.calls++;
      const r = step(req.history);
      if (r instanceof Error) throw r;
      return { parts: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...r } as CompletionResult;
    },
  };
  return p as any;
}

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_call' as const, id, name, input });

class FakeLink implements BrowserLink {
  executed: { member: string; input: Record<string, unknown> }[] = [];
  describe: Record<string, unknown> = { tabId: 'tab-1', url: 'https://shop.example/x', host: 'shop.example' };
  results: Record<string, ToolResult> = {};
  delayMs = 0;
  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === 'session_begin') return { activeTabId: 'tab-1', tabs: [{ tab_id: 'tab-1', title: 'Shop', url: 'https://shop.example/', active: true }] } as T;
    if (method === 'describe') return this.describe as T;
    if (method === 'execute') {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      this.executed.push({ member: String(params.member), input: params.input as Record<string, unknown> });
      return (this.results[String(params.member)] ?? { isError: false, content: [{ type: 'text', text: `${params.member} ok` }] }) as T;
    }
    return { ok: true } as T;
  }
}

class FakeHost implements SessionHost {
  events: AgentEvent[] = [];
  settingsValue: PolicySettings = { ...DEFAULT_SETTINGS, permissionMode: 'auto' };
  approvals: ApprovalRequest[] = [];
  decision: ApprovalDecision = 'allow_once';
  allowed: string[] = [];
  emit(_id: string, e: AgentEvent): void {
    this.events.push(e);
  }
  async requestApproval(_id: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    this.approvals.push(req);
    return this.decision;
  }
  settings(): PolicySettings {
    return this.settingsValue;
  }
  allowSitePermanently(site: string): void {
    this.allowed.push(site);
  }
  log(): void {}
}

function make(provider: Provider, opts: { link?: FakeLink; host?: FakeHost } = {}) {
  const link = opts.link ?? new FakeLink();
  const host = opts.host ?? new FakeHost();
  const s = new Session({ profile, provider, link, host, now: () => new Date('2026-11-03T12:00:00Z') });
  return { s, link, host };
}

const lastResults = (s: Session) => {
  const t = [...s.history].reverse().find((x) => x.role === 'tool_results');
  return t && t.role === 'tool_results' ? t.results : [];
};

describe('Session loop', () => {
  it('runs tool calls until the model replies in text, with a dated first message', async () => {
    const p = scripted([() => ({ parts: [call('a', 'read_page')], stopReason: 'tool_use' }), () => ({ parts: [{ type: 'text', text: 'Done!' }] })]);
    const { s, link, host } = make(p);
    await s.send('Summarize');
    expect(link.executed.map((e) => e.member)).toEqual(['read_page']);
    const first = s.history[0] as Extract<Turn, { role: 'user' }>;
    expect((first.parts[0] as { text: string }).text).toMatch(/^Current date: 2026-11-03\. The task starts in tab tab-1 \(https:\/\/shop\.example\/ — "Shop"\)\.\n\nSummarize$/);
    const done = host.events.find((e) => e.type === 'turn_done');
    expect(done).toMatchObject({ reason: 'end_turn', finalText: 'Done!' });
    expect(s.status).toBe('idle');
  });

  it('halts a batch at the first failure and answers every call', async () => {
    const p = scripted([() => ({ parts: [call('a', 'left_click', { target: { type: 'ref', ref: 'ref_1' } }), call('b', 'type', { text: 'x' }), call('c', 'key', { text: 'Enter' })], stopReason: 'tool_use' }), () => ({ parts: [{ type: 'text', text: 'ok' }] })]);
    const link = new FakeLink();
    link.results.left_click = { isError: true, content: [{ type: 'text', text: 'Error: ref_1 is stale' }] };
    const { s } = make(p, { link });
    await s.send('go');
    const r = lastResults(s);
    expect(r.map((x) => x.callId)).toEqual(['a', 'b', 'c']);
    expect(r[1].result).toEqual({ isError: true, content: [{ type: 'text', text: HALT_TEXT }] });
    expect(r[2].result.isError).toBe(true);
    expect(link.executed.map((e) => e.member)).toEqual(['left_click']);
  });

  it('rejects unknown, disabled and malformed calls without executing them', async () => {
    const p = scripted([
      () => ({ parts: [call('a', 'teleport')], stopReason: 'tool_use' }),
      () => ({ parts: [call('b', 'javascript_exec', { text: '1' })], stopReason: 'tool_use' }),
      () => ({ parts: [call('c', 'navigate', { __invalid_arguments__: 'bad json' })], stopReason: 'tool_use' }),
      () => ({ parts: [{ type: 'text', text: 'ok' }] }),
    ]);
    const { s, link } = make(p);
    await s.send('go');
    const all = s.history.filter((t) => t.role === 'tool_results').flatMap((t) => (t.role === 'tool_results' ? t.results : []));
    expect(all.map((r) => (r.result.content[0] as { text: string }).text)).toEqual([
      'Error: unknown tool "teleport".',
      'Error: javascript_exec is not enabled in this environment.',
      'Error: bad json. Retry with valid JSON arguments.',
    ]);
    expect(link.executed).toEqual([]);
  });

  it('asks for approval on consequential actions; deny becomes an error the model sees', async () => {
    const p = scripted([() => ({ parts: [call('a', 'left_click', { target: { type: 'ref', ref: 'ref_9' } })], stopReason: 'tool_use' }), () => ({ parts: [{ type: 'text', text: 'ok' }] })]);
    const link = new FakeLink();
    link.describe = { tabId: 'tab-1', url: 'https://shop.example/cart', host: 'shop.example', element: { role: 'button', name: 'Place order', tag: 'button' } };
    const host = new FakeHost();
    host.decision = 'deny';
    const { s } = make(p, { link, host });
    await s.send('buy it');
    expect(host.approvals[0]).toMatchObject({ kind: 'consequential', member: 'left_click' });
    expect(link.executed).toEqual([]);
    expect((lastResults(s)[0].result.content[0] as { text: string }).text).toMatch(/declined/);
    expect(host.events.some((e) => e.type === 'status' && e.status === 'waiting_approval')).toBe(true);
  });

  it('remembers site approvals for the session and persists "always"', async () => {
    const p = scripted([
      () => ({ parts: [call('a', 'navigate', { url: 'https://news.example' })], stopReason: 'tool_use' }),
      () => ({ parts: [call('b', 'navigate', { url: 'https://news.example/2' })], stopReason: 'tool_use' }),
      () => ({ parts: [{ type: 'text', text: 'ok' }] }),
    ]);
    const host = new FakeHost();
    host.settingsValue = { ...DEFAULT_SETTINGS, permissionMode: 'ask' };
    host.decision = 'allow_site';
    const { s, link } = make(p, { host });
    await s.send('read news');
    expect(host.approvals.length).toBe(1);
    expect(host.allowed).toEqual(['news.example']);
    expect(link.executed.length).toBe(2);
  });

  it('stops after maxSteps', async () => {
    const p = scripted([() => ({ parts: [call(`x${Math.random()}`, 'wait', { duration: 0 })], stopReason: 'tool_use' })]);
    const host = new FakeHost();
    host.settingsValue = { ...host.settingsValue, maxSteps: 3 };
    const { s, link } = make(p, { host });
    await s.send('loop');
    expect(link.executed.length).toBe(3);
    expect(host.events.find((e) => e.type === 'turn_done')).toMatchObject({ reason: 'max_steps' });
  });

  it('stop() during a batch answers the remaining calls and ends the turn', async () => {
    const p = scripted([() => ({ parts: [call('a', 'wait', { duration: 0 }), call('b', 'wait', { duration: 0 }), call('c', 'wait', { duration: 0 })], stopReason: 'tool_use' })]);
    const link = new FakeLink();
    link.delayMs = 80;
    const { s, host } = make(p, { link });
    const done = s.send('go');
    await new Promise((r) => setTimeout(r, 40));
    s.stop();
    await done;
    const r = lastResults(s);
    expect(r.length).toBe(3);
    expect(r.slice(1).every((x) => x.result.isError)).toBe(true);
    expect(host.events.find((e) => e.type === 'turn_done')).toMatchObject({ reason: 'stopped' });
    // The model's last tool calls are all answered, so the conversation stays valid.
    expect(s.history[s.history.length - 1].role).toBe('tool_results');
  });

  it('retries retryable provider errors and gives up on others', async () => {
    const p = scripted([() => new ProviderError('overloaded', true, 529), () => ({ parts: [{ type: 'text', text: 'recovered' }] })]);
    const { s, host } = make(p);
    await s.send('go');
    expect(host.events.find((e) => e.type === 'turn_done')).toMatchObject({ reason: 'end_turn', finalText: 'recovered' });

    const p2 = scripted([() => new ProviderError('bad key', false, 401)]);
    const { s: s2, host: h2 } = make(p2);
    await s2.send('go');
    expect(h2.events.find((e) => e.type === 'turn_done')).toMatchObject({ reason: 'error' });
    expect(h2.events.some((e) => e.type === 'notice' && /bad key/.test(e.message))).toBe(true);
  }, 15_000);

  it('handles refusals by answering pending calls', async () => {
    const p = scripted([() => ({ parts: [call('a', 'read_page')], stopReason: 'refusal', stopDetail: 'cyber' })]);
    const { s, host, link } = make(p);
    await s.send('x');
    expect(host.events.find((e) => e.type === 'turn_done')).toMatchObject({ reason: 'refusal' });
    expect(link.executed).toEqual([]);
    expect(lastResults(s)[0].result.isError).toBe(true);
  });

  it('supports multi-turn conversations and refuses concurrent sends', async () => {
    const p = scripted([() => ({ parts: [{ type: 'text', text: 'first' }] })]);
    const { s } = make(p);
    await s.send('one');
    await s.send('two');
    expect(s.history.filter((t) => t.role === 'user').length).toBe(2);
    const slow = scripted([() => ({}) as any]);
    const { s: s3 } = make(slow);
    const a = s3.send('a');
    await expect(s3.send('b')).rejects.toThrow(/already working/);
    await a;
  });

  it('keeps tool-call/result pairing for every assistant turn (API validity invariant)', async () => {
    const p = scripted([
      () => ({ parts: [call('a', 'read_page'), call('b', 'screenshot')], stopReason: 'tool_use' }),
      () => ({ parts: [call('c', 'left_click', { target: { type: 'coordinate', x: 1, y: 1 } })], stopReason: 'tool_use' }),
      () => ({ parts: [{ type: 'text', text: 'ok' }] }),
    ]);
    const { s } = make(p);
    await s.send('go');
    for (let i = 0; i < s.history.length; i++) {
      const t = s.history[i];
      if (t.role !== 'assistant') continue;
      const ids = t.parts.filter((x) => x.type === 'tool_call').map((x: any) => x.id);
      if (!ids.length) continue;
      const next = s.history[i + 1];
      expect(next?.role).toBe('tool_results');
      expect(next.role === 'tool_results' && next.results.map((r) => r.callId)).toEqual(ids);
    }
  });
});

describe('normalizeResult', () => {
  it('drops invalid blocks and duplicate browser_state, never returns empty', () => {
    expect(normalizeResult(undefined).isError).toBe(true);
    const r = normalizeResult({
      isError: false,
      content: [{ type: 'browser_state', tabs: [] }, { type: 'browser_state', tabs: [] }, { type: 'image', mediaType: 'image/png', data: '' } as any, { type: 'weird' } as any],
    });
    expect(r.content.filter((b) => b.type === 'browser_state').length).toBe(1);
    expect(normalizeResult({ isError: true, content: [{ type: 'browser_state', tabs: [] }] }).content).toEqual([{ type: 'text', text: 'Error.' }]);
  });
});

describe('provider construction', () => {
  it('pins the Anthropic endpoint instead of inheriting ANTHROPIC_BASE_URL', () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://proxy.invalid';
    try {
      const p = new AnthropicProvider({ ...profile, provider: 'anthropic' }, 'k') as any;
      expect(p.client.baseURL).toBe('https://api.anthropic.com');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });
});

describe('approved targets', () => {
  const clickPlaceOrder = () =>
    scripted([() => ({ parts: [call('a', 'left_click', { target: { type: 'ref', ref: 'ref_9' } })], stopReason: 'tool_use' }), () => ({ parts: [{ type: 'text', text: 'ok' }] })]);
  const target = (name: string) => ({ tabId: 'tab-1', url: 'https://shop.example/cart', host: 'shop.example', element: { role: 'button', name, tag: 'button' } });

  it('runs the approved action when the target is unchanged', async () => {
    const link = new FakeLink();
    link.describe = target('Place order');
    const { s, host } = make(clickPlaceOrder(), { link });
    await s.send('buy it');
    expect(host.approvals.length).toBe(1);
    expect(link.executed.map((e) => e.member)).toEqual(['left_click']);
  });

  it('refuses when the page swapped the target while the user was deciding', async () => {
    const link = new FakeLink();
    link.describe = target('Place order');
    const host = new FakeHost();
    host.requestApproval = async (_id, req) => {
      host.approvals.push(req);
      link.describe = target('Pay $500 now'); // the page changes during the approval wait
      return 'allow_once';
    };
    const { s } = make(clickPlaceOrder(), { link, host });
    await s.send('buy it');
    expect(link.executed).toEqual([]);
    expect((lastResults(s)[0].result.content[0] as { text: string }).text).toMatch(/page changed after this action was approved/);
  });

  it('refuses when the target cannot be inspected again after approval', async () => {
    const link = new FakeLink();
    link.describe = target('Place order');
    const host = new FakeHost();
    const orig = link.call.bind(link);
    let describes = 0;
    link.call = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === 'describe' && ++describes > 1) throw new Error('Error: ref_9 is stale or not found');
      return orig<T>(method as never, params);
    };
    const { s } = make(clickPlaceOrder(), { link, host });
    await s.send('buy it');
    expect(link.executed).toEqual([]);
    expect((lastResults(s)[0].result.content[0] as { text: string }).text).toMatch(/page changed after this action was approved/);
  });

  it('does not re-inspect actions that needed no approval', async () => {
    const link = new FakeLink();
    link.describe = target('Search');
    let describes = 0;
    const orig = link.call.bind(link);
    link.call = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === 'describe') describes++;
      return orig<T>(method as never, params);
    };
    const { s, host } = make(clickPlaceOrder(), { link });
    await s.send('search');
    expect(host.approvals.length).toBe(0);
    expect(describes).toBe(1);
    expect(link.executed.length).toBe(1);
  });

  it('turned-off categories run without asking', async () => {
    const link = new FakeLink();
    link.describe = target('Place order');
    const host = new FakeHost();
    host.settingsValue = { ...DEFAULT_SETTINGS, permissionMode: 'auto', confirm: { ...DEFAULT_SETTINGS.confirm, payments: false } };
    const { s } = make(clickPlaceOrder(), { link, host });
    await s.send('buy it');
    expect(host.approvals.length).toBe(0);
    expect(link.executed.map((e) => e.member)).toEqual(['left_click']);
  });
});
