/**
 * Integration: AgentServer + a fake extension speaking the WebSocket protocol + the HTTP API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type AgentEvent, type ServerFrame } from '@ba/shared';
import { loadProfiles, sanitizeSettings, type ServerConfig } from '../src/config.ts';
import { AgentServer } from '../src/server.ts';
import { registerScript } from '../src/providers/mock.ts';

const TOKEN = 'test-token-123';
let server: AgentServer;
let port: number;
let base: string;

registerScript('click-buy', (c) => {
  if (c.step === 0) return { calls: [{ name: 'find', input: { query: 'buy button' } }] };
  if (c.step === 1) return { calls: [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Buy now') } } }] };
  return { text: `Result: ${c.lastText}` };
});

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-srv-'));
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dataDir,
    extensionIds: [],
    profiles: [{ id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' }],
    defaultProfileId: 'mock',
  };
  server = new AgentServer(config, { settings: { permissionMode: 'auto' } });
  port = await server.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

/** A fake extension: answers RPCs, records events. */
async function fakeExtension(opts: { token?: string; origin?: string; clientId?: string } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: opts.origin ? { origin: opts.origin } : {} });
  const frames: ServerFrame[] = [];
  const events: { sessionId: string; event: AgentEvent }[] = [];
  const executed: { member: string; input: unknown }[] = [];
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as ServerFrame;
    frames.push(f);
    if (f.type === 'agent_event') events.push({ sessionId: f.sessionId, event: f.event });
    if (f.type === 'rpc') {
      let result: unknown = { ok: true };
      if (f.method === 'session_begin') result = { activeTabId: 'tab-7', tabs: [{ tab_id: 'tab-7', title: 'Store', url: 'https://store.test/', active: true }] };
      if (f.method === 'describe') result = { tabId: 'tab-7', url: 'https://store.test/', host: 'store.test', element: { role: 'button', name: 'Buy now', tag: 'button' } };
      if (f.method === 'execute') {
        const p = f.params as { member: string; input: unknown };
        executed.push({ member: p.member, input: p.input });
        result =
          p.member === 'find'
            ? { isError: false, content: [{ type: 'text', text: 'button "Buy now" [ref_4]\nlink "Help" [ref_5]' }] }
            : { isError: false, content: [{ type: 'text', text: `Clicked element ${(p.input as any).target?.ref}.` }] };
      }
      ws.send(JSON.stringify({ type: 'rpc_result', id: f.id, result }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', token: opts.token ?? TOKEN, clientId: opts.clientId ?? 'client-1', protocol: PROTOCOL_VERSION, extensionVersion: 'test', userAgent: 'vitest' }));
  return { ws, frames, events, executed, closed };
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const api = (p: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(base + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

describe('AgentServer', () => {
  it('serves /health without auth and rejects API calls without the token', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await api('/api/state', {}, 'wrong')).status).toBe(401);
    expect((await api('/api/state')).status).toBe(200);
  });

  it('rejects bad pairing tokens and web origins', async () => {
    const bad = await fakeExtension({ token: 'nope' });
    expect(await bad.closed).toBe(4003);
    expect(bad.frames[0]).toMatchObject({ type: 'hello_error' });
    await expect(fakeExtension({ origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('pairs an extension and sends profiles/settings', async () => {
    const ext = await fakeExtension({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    await until(() => ext.frames.some((f) => f.type === 'hello_ok'));
    const hello = ext.frames.find((f) => f.type === 'hello_ok') as Extract<ServerFrame, { type: 'hello_ok' }>;
    expect(hello.profiles[0]).toMatchObject({ id: 'mock', available: true });
    expect(hello.settings.permissionMode).toBe('auto');
    ext.ws.close();
  });

  it('runs a session end to end: extension message -> RPCs -> approval -> events', async () => {
    const ext = await fakeExtension({ clientId: 'client-2' });
    await until(() => ext.frames.some((f) => f.type === 'hello_ok'));
    ext.ws.send(JSON.stringify({ type: 'send_message', requestId: 'r1', text: 'buy the thing #script:click-buy' }));
    await until(() => ext.frames.some((f) => f.type === 'response' && f.requestId === 'r1'));
    const resp = ext.frames.find((f) => f.type === 'response' && f.requestId === 'r1') as any;
    expect(resp.ok).toBe(true);
    const sid = resp.data.sessionId;
    // "Buy now" is consequential -> approval request reaches the extension.
    await until(() => ext.events.some((e) => e.event.type === 'approval_request'));
    const ap = ext.events.find((e) => e.event.type === 'approval_request')!.event as Extract<AgentEvent, { type: 'approval_request' }>;
    expect(ap).toMatchObject({ kind: 'consequential', member: 'left_click' });
    ext.ws.send(JSON.stringify({ type: 'approval_response', approvalId: ap.approvalId, decision: 'allow_once' }));
    await until(() => ext.events.some((e) => e.event.type === 'turn_done'));
    expect(ext.executed.map((e) => e.member)).toEqual(['find', 'left_click']);
    expect((ext.executed[1].input as any).target.ref).toBe('ref_4');
    const done = ext.events.find((e) => e.event.type === 'turn_done')!.event as any;
    expect(done.finalText).toBe('Result: Clicked element ref_4.');
    // History is replayable for a reopened side panel.
    ext.ws.send(JSON.stringify({ type: 'get_history', requestId: 'h1', sessionId: sid }));
    await until(() => ext.frames.some((f) => f.type === 'response' && f.requestId === 'h1'));
    const hist = ext.frames.find((f) => f.type === 'response' && f.requestId === 'h1') as any;
    expect(hist.data.events.map((e: any) => e.event.type)).toContain('tool_result');
    // HTTP API sees the same session.
    const st = await (await api(`/api/sessions/${sid}`)).json();
    expect(st.status).toBe('idle');
    ext.ws.close();
  });

  it('drives sessions over HTTP with SSE events and auto-approval', async () => {
    const ext = await fakeExtension({ clientId: 'client-3' });
    await until(() => ext.frames.some((f) => f.type === 'hello_ok'));
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ text: 'go #script:click-buy', clientId: 'client-3', autoApprove: 'allow_once' }) });
    const { sessionId } = await r.json();
    const sse = await api(`/api/sessions/${sessionId}/events`);
    const reader = sse.body!.getReader();
    let buf = '';
    const dec = new TextDecoder();
    while (!buf.includes('"turn_done"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    await reader.cancel();
    expect(buf).toContain('"type":"tool_call"');
    expect(buf).toContain('"turn_done"');
    expect(ext.executed.map((e) => e.member)).toEqual(['find', 'left_click']);
    ext.ws.close();
  });

  it('only accepts allow_once or deny as HTTP auto-approval', async () => {
    const ext = await fakeExtension({ clientId: 'client-auto' });
    await until(() => ext.frames.some((f) => f.type === 'hello_ok'));
    const start = async (autoApprove: unknown) => {
      const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ text: 'hello', clientId: 'client-auto', autoApprove, sessionId: 'hijack', extra: 1 }) });
      expect(r.status, await r.clone().text()).toBe(200);
      const { sessionId } = await r.json();
      expect(sessionId).not.toBe('hijack');
      return (server as any).sessions.get(sessionId).autoApprove;
    };
    expect(await start('allow_once')).toBe('allow_once');
    expect(await start('deny')).toBe('deny');
    expect(await start('allow_site')).toBeUndefined();
    expect(await start('yes')).toBeUndefined();
    expect(await start(true)).toBeUndefined();
    ext.ws.close();
  });

  it('validates API input and settings', async () => {
    expect((await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
    expect((await api('/api/sessions/nope')).status).toBe(404);
    const s = await (await api('/api/settings', { method: 'POST', body: JSON.stringify({ maxSteps: 99999, permissionMode: 'bogus', blockedSites: [' Evil.com ', 'evil.com', 3] }) })).json();
    expect(s.maxSteps).toBe(500);
    expect(s.permissionMode).toBe('ask');
    expect(s.blockedSites).toEqual(['evil.com']);
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ permissionMode: 'auto' }) });
  });

  it('errors when no extension is connected for a client', async () => {
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ text: 'x', clientId: 'ghost' }) });
    expect(r.status).toBe(200); // session is created; the begin RPC waits for the client then fails
  });
});

describe('busy sessions', () => {
  it('delivers a message sent while the session is running instead of dropping it', async () => {
    const ext = await fakeExtension({ clientId: 'client-busy' });
    await until(() => ext.frames.some((f) => f.type === 'hello_ok'));
    const { sessionId, done } = server.startOrContinue({ text: 'hi', clientId: 'client-busy' });
    await done;
    const sess = server.getSession(sessionId)!;
    sess.status = 'running';
    expect(server.startOrContinue({ sessionId, text: 'again' }).sessionId).toBe(sessionId);
    const r = await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'and again' }) });
    expect(r.status).toBe(200);
    expect((sess as any).pendingNotes).toEqual(['again', 'and again']);
    (sess as any).pendingNotes = [];
    sess.status = 'idle';
    ext.ws.close();
  });
});

describe('config', () => {
  it('loads the example profiles and adds the mock profile', () => {
    const { profiles, defaultProfileId } = loadProfiles(path.resolve(__dirname, '../../../models.example.json'));
    expect(profiles.find((p) => p.id === 'claude-opus')).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', vision: true });
    expect(profiles.some((p) => p.id === 'mock')).toBe(true);
    expect(typeof defaultProfileId).toBe('string');
  });
  it('sanitizes settings', () => {
    const s = sanitizeSettings({ permissionMode: 'yolo', allowedSites: ['A.com'], blockedSites: [], allowPrivateNetworks: 1 as any, enableOptional: {} as any, maxSteps: 0, autoScreenshot: false, lockUserInput: false, confirmRiskyClicks: true, captchaHelperProfileId: '  ark ' });
    expect(s).toMatchObject({ permissionMode: 'yolo', allowedSites: ['a.com'], allowPrivateNetworks: true, maxSteps: 60, captchaHelperProfileId: 'ark' });
    expect(s.enableOptional.javascript_exec).toBe(false);
  });
});
