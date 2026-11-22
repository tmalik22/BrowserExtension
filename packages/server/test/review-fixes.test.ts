/**
 * Regression tests for issues found in the independent security/correctness review.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, checkUrlPolicy, isPrivateHost, type ActionDescription, type AgentEvent, type ApprovalDecision, type PolicySettings, type ToolResult } from '@ba/shared';
import { activationKeys, evaluate } from '../src/agent/policy.ts';
import { Session, type ApprovalRequest, type BrowserLink, type SessionHost } from '../src/agent/session.ts';
import { toAnthropicMessages } from '../src/providers/anthropic.ts';
import type { CompletionResult, ModelProfile, Provider, Turn } from '../src/providers/types.ts';

const S = (patch: Partial<PolicySettings> = {}): PolicySettings => ({ ...DEFAULT_SETTINGS, permissionMode: 'auto', ...patch });
const st = () => ({ sessionSites: new Set<string>() });
const page = (element?: ActionDescription['element'], extra: Partial<ActionDescription> = {}): ActionDescription => ({ tabId: 'tab-1', url: 'https://shop.example/', host: 'shop.example', element, ...extra });

describe('policy: every way of activating a control is checked', () => {
  const sendBtn = { role: 'button', name: 'Send message', tag: 'button' };
  const field = { role: 'textbox', name: 'Message', tag: 'textarea', formSubmitName: 'Post reply' };
  it('detects Enter/Space in key, hold_key and type', () => {
    expect(activationKeys('key', { text: 'Enter Tab' })).toEqual({ enter: true, space: false });
    expect(activationKeys('key', { text: 'KP_Enter' }).enter).toBe(true);
    expect(activationKeys('key', { text: 'ctrl+Return' }).enter).toBe(true);
    expect(activationKeys('hold_key', { text: 'Enter', duration: 1 }).enter).toBe(true);
    expect(activationKeys('type', { text: 'hello\n' }).enter).toBe(true);
    expect(activationKeys('key', { text: 'space' }).space).toBe(true);
    expect(activationKeys('key', { text: 'Tab' })).toEqual({ enter: false, space: false });
  });
  it.each([
    ['type', { text: 'hi\n' }, field],
    ['hold_key', { text: 'Enter', duration: 1 }, field],
    ['key', { text: 'Enter Tab' }, field],
    ['key', { text: 'KP_Enter' }, field],
    ['key', { text: 'Enter' }, sendBtn],
    ['key', { text: 'space' }, sendBtn],
    ['key', { text: 'Enter' }, { role: 'link', name: 'Delete account', tag: 'a' }],
  ] as const)('%s %j on %j asks', (member, input, el) => {
    expect(evaluate(member, input as any, page(el as any), S(), st())).toMatchObject({ kind: 'ask', approvalKind: 'consequential' });
  });
  it('drags and mouse-downs on consequential controls ask', () => {
    const buy = page({ role: 'button', name: 'Buy now', tag: 'button' });
    expect(evaluate('left_click_drag', {}, buy, S(), st()).kind).toBe('ask');
    expect(evaluate('left_mouse_down', {}, buy, S(), st()).kind).toBe('ask');
  });
  it('Enter in a login form asks', () => {
    const pw = { role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', formSubmitName: 'Continue', formHasPassword: true };
    expect(evaluate('key', { text: 'Enter' }, page(pw), S(), st())).toMatchObject({ kind: 'ask', approvalKind: 'sensitive' });
  });
  it('fails closed: unknown targets and missing descriptions ask (except in yolo mode)', () => {
    expect(evaluate('left_click', {}, page(undefined, { unknown: 'could not inspect' }), S(), st()).kind).toBe('ask');
    expect(evaluate('left_click', {}, undefined, S(), st()).kind).toBe('ask');
    expect(evaluate('left_click', {}, undefined, S({ permissionMode: 'yolo' }), st()).kind).toBe('allow');
    expect(evaluate('scroll', {}, page(undefined, { unknown: 'x' }), S(), st()).kind).toBe('allow');
  });
  it('accepting a confirm/prompt dialog asks; dismissing does not', () => {
    const d = page(undefined, { dialog: { type: 'confirm', message: 'Transfer $500?' } });
    expect(evaluate('key', { text: 'Enter' }, d, S(), st())).toMatchObject({ kind: 'ask', reason: expect.stringContaining('Transfer $500?') });
    expect(evaluate('key', { text: 'Escape' }, d, S(), st()).kind).toBe('allow');
    expect(evaluate('type', { text: 'Bob' }, page(undefined, { dialog: { type: 'prompt', message: 'Name?' } }), S(), st()).kind).toBe('allow');
  });
  it('checks the URL of the frame that holds the target', () => {
    expect(evaluate('left_click', {}, page({ role: 'button', name: 'Go', tag: 'button' }, { frameUrl: 'http://192.168.1.1/admin' }), S({ permissionMode: 'yolo' }), st()).kind).toBe('deny');
  });
});

describe('private-host bypasses', () => {
  it.each(['localhost.', 'LOCALHOST..', '::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:c0a8:101', '::ffff:127.0.0.1', '64:ff9b::a00:1', '::ffff:0:a00:1'])('%s is private', (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });
  it('blocks the bypass URLs', () => {
    const p = { allowPrivateNetworks: false, blockedSites: [] };
    expect(checkUrlPolicy('http://localhost./', p)).toMatch(/private/);
    expect(checkUrlPolicy('http://[::ffff:127.0.0.1]/', p)).toMatch(/private/);
    expect(checkUrlPolicy('http://[::ffff:c0a8:101]/', p)).toMatch(/private/);
    expect(checkUrlPolicy('https://[::ffff:808:808]/', p)).toBeNull(); // 8.8.8.8 is public
  });
});

// --- session-level fixes -------------------------------------------------------------------

const profile: ModelProfile = { id: 'p', label: 'P', provider: 'mock', model: 'm', vision: true };
const steps = (list: Partial<CompletionResult>[]): Provider => {
  let i = 0;
  return {
    name: 's',
    async complete(): Promise<CompletionResult> {
      const r = list[Math.min(i++, list.length - 1)];
      return { parts: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...r } as CompletionResult;
    },
  };
};
const call = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_call' as const, id, name, input: input as Record<string, unknown> });

class Link implements BrowserLink {
  calls: string[] = [];
  executed: string[] = [];
  describe: unknown = page({ role: 'button', name: 'Place order', tag: 'button' });
  failExecuteOnce = false;
  failDescribe = false;
  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push(method);
    if (method === 'session_begin') return { activeTabId: 'tab-1', tabs: [{ tab_id: 'tab-1', title: 'Shop', url: 'https://shop.example/', active: true }] } as T;
    if (method === 'describe') {
      if (this.failDescribe) throw new Error('Error: the page did not respond to describe within 5s.');
      return this.describe as T;
    }
    if (method === 'execute') {
      if (this.failExecuteOnce) {
        this.failExecuteOnce = false;
        throw new Error('Error: this agent session is not active in the browser (it may have been closed). Start a new task.');
      }
      this.executed.push(String(params.member));
      return { isError: false, content: [{ type: 'text', text: 'ok' }] } as ToolResult as T;
    }
    return {} as T;
  }
}
class Host implements SessionHost {
  events: AgentEvent[] = [];
  approvals: ApprovalRequest[] = [];
  decisions: ApprovalDecision[] = [];
  throwOnApproval = false;
  constructor(public s: PolicySettings) {}
  emit(_: string, e: AgentEvent) {
    this.events.push(e);
  }
  async requestApproval(_: string, r: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.throwOnApproval) throw new Error('approval channel broke');
    this.approvals.push(r);
    return this.decisions.shift() ?? 'allow_once';
  }
  settings() {
    return this.s;
  }
  allowSitePermanently() {}
  log() {}
}
const lastResult = (s: Session) => {
  const t = [...s.history].reverse().find((x) => x.role === 'tool_results') as Extract<Turn, { role: 'tool_results' }>;
  return (t.results[0].result.content[0] as { text: string }).text;
};

describe('session fixes', () => {
  it('a site approval does not skip the consequential check', async () => {
    const host = new Host(S({ permissionMode: 'ask' }));
    host.decisions = ['allow_once', 'deny'];
    const link = new Link();
    const s = new Session({ profile, provider: steps([{ parts: [call('a', 'left_click', { target: { type: 'ref', ref: 'ref_1' } })], stopReason: 'tool_use' }, { parts: [{ type: 'text', text: 'ok' }] }]), link, host });
    await s.send('x');
    expect(host.approvals.map((a) => a.kind)).toEqual(['site', 'consequential']);
    expect(link.executed).toEqual([]);
    expect(lastResult(s)).toMatch(/declined/);
  });

  it('an exception while handling a call still yields a result and a valid history', async () => {
    const host = new Host(S());
    host.throwOnApproval = true;
    const s = new Session({ profile, provider: steps([{ parts: [call('a', 'left_click', { target: { type: 'ref', ref: 'ref_1' } }), call('b', 'read_page')], stopReason: 'tool_use' }, { parts: [{ type: 'text', text: 'ok' }] }]), link: new Link(), host });
    await s.send('x');
    const tr = s.history.find((t) => t.role === 'tool_results') as Extract<Turn, { role: 'tool_results' }>;
    expect(tr.results.map((r) => r.callId)).toEqual(['a', 'b']);
    expect(tr.results.every((r) => r.result.isError)).toBe(true);
    expect(host.events.find((e) => e.type === 'turn_done')).toMatchObject({ reason: 'end_turn' });
  });

  it('rejects non-object tool arguments', async () => {
    const s = new Session({ profile, provider: steps([{ parts: [call('a', 'navigate', 5)], stopReason: 'tool_use' }, { parts: [{ type: 'text', text: 'ok' }] }]), link: new Link(), host: new Host(S()) });
    await s.send('x');
    expect(lastResult(s)).toBe('Error: tool arguments must be a JSON object.');
  });

  it('a target that cannot be inspected needs approval instead of being allowed', async () => {
    const host = new Host(S());
    host.decisions = ['deny'];
    const link = new Link();
    link.failDescribe = true;
    const s = new Session({ profile, provider: steps([{ parts: [call('a', 'left_click', { target: { type: 'coordinate', x: 1, y: 1 } })], stopReason: 'tool_use' }, { parts: [{ type: 'text', text: 'ok' }] }]), link, host });
    await s.send('x');
    expect(host.approvals[0].reason).toMatch(/could not be inspected/);
    expect(link.executed).toEqual([]);
  });

  it('re-begins the browser session after an extension restart and retries', async () => {
    const link = new Link();
    link.describe = page({ role: 'heading', name: 'Shop', tag: 'h1' });
    link.failExecuteOnce = true;
    const host = new Host(S());
    const s = new Session({ profile, provider: steps([{ parts: [call('a', 'scroll', { target: { type: 'coordinate', x: 1, y: 1 }, scroll_direction: 'down' })], stopReason: 'tool_use' }, { parts: [{ type: 'text', text: 'ok' }] }]), link, host });
    await s.send('x');
    expect(link.calls.filter((c) => c === 'session_begin').length).toBe(2);
    expect(link.executed).toEqual(['scroll']);
    expect(lastResult(s)).toBe('ok');
  });

  it('redacts typed text for sensitive fields in events', async () => {
    const link = new Link();
    link.describe = page({ role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', sensitive: true });
    const host = new Host(S({ permissionMode: 'yolo' }));
    const s = new Session({ profile, provider: steps([{ parts: [call('a', 'type', { text: 'hunter two words' })], stopReason: 'tool_use' }, { parts: [{ type: 'text', text: 'ok' }] }]), link, host });
    await s.send('x');
    const ev = host.events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
    expect(JSON.stringify(ev.input)).not.toContain('hunter');
  });
});

describe('anthropic history', () => {
  it('replaces an empty assistant turn (e.g. a refusal) with a placeholder', () => {
    const m = toAnthropicMessages([
      { role: 'user', parts: [{ type: 'text', text: 'x' }] },
      { role: 'assistant', parts: [], native: { provider: 'anthropic', content: [] } },
      { role: 'user', parts: [{ type: 'text', text: 'y' }] },
    ]);
    expect(m[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '(no response)' }] });
  });
});


describe('messages while the agent works', () => {
  it('delivers a mid-task message with the next tool results, to every provider format', async () => {
    let s!: Session;
    let seenNote = '';
    const provider: Provider = {
      name: 'p',
      async complete(req) {
        const last = req.history[req.history.length - 1];
        if (last.role === 'user') {
          s.interject('use the ref, not coordinates');
          return { parts: [call('a', 'read_page')], stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        }
        if (last.role === 'tool_results') seenNote = (last.notes ?? []).join('|');
        return { parts: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    const host = new Host(S());
    const link = new Link();
    link.describe = page({ role: 'heading', name: 'x', tag: 'h1' });
    s = new Session({ profile, provider, link, host });
    await s.send('go');
    expect(seenNote).toBe('use the ref, not coordinates');
    expect(host.events.filter((e) => e.type === 'user_message').map((e: any) => e.text)).toEqual(['go', 'use the ref, not coordinates']);
    const anth = toAnthropicMessages(s.history);
    expect(JSON.stringify(anth[anth.length - 2])).toContain('[Message from the user, sent while you were working]');
  });

  it('a message that arrives after the last step becomes the next turn', async () => {
    let s!: Session;
    let n = 0;
    const provider: Provider = {
      name: 'p',
      async complete() {
        n++;
        if (n === 1) s.interject('also check the footer');
        return { parts: [{ type: 'text', text: `answer ${n}` }], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    const host = new Host(S());
    s = new Session({ profile, provider, link: new Link(), host });
    await s.send('first');
    await new Promise((r) => setTimeout(r, 50));
    await s.settled();
    expect(n).toBe(2);
    const users = s.history.filter((t) => t.role === 'user').map((t: any) => t.parts[0].text);
    expect(users[1]).toBe('also check the footer');
    expect(host.events.filter((e) => e.type === 'user_message').length).toBe(2);
  });
});
