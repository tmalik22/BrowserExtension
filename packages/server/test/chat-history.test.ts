/**
 * Chat history: past chats are listed, shown again after a restart (from their saved transcript),
 * and can be carried on in a new chat that gets a summary of the old one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type AgentEvent, type ChatInfo, type ServerFrame } from '@ba/shared';
import type { ServerConfig } from '../src/config.ts';
import { ChatHistory } from '../src/history.ts';
import { registerScript } from '../src/providers/mock.ts';
import { AgentServer } from '../src/server.ts';

const TOKEN = 'history-token';

registerScript('open-a', (c) => (c.step === 0 ? { calls: [{ name: 'navigate', input: { url: 'https://store.test/a' } }] } : { text: 'Opened page A and found 3 rows.' }));

let dataDir: string;
let config: ServerConfig;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-history-'));
  config = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dataDir,
    extensionIds: [],
    profiles: [
      { id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' },
      { id: 'mock-open', label: 'Mock open', provider: 'mock', model: 'mock', vision: false, script: 'open-a' },
    ],
    defaultProfileId: 'mock',
  };
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<{ server: AgentServer; port: number }> {
  const server = new AgentServer(config, { gpu: false, settings: { allowedSites: ['store.test'] } });
  return { server, port: await server.listen(0) };
}

/** A fake extension that answers browser RPCs and can make panel requests. */
async function extension(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: ServerFrame[] = [];
  const events: { sessionId: string; event: AgentEvent }[] = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as ServerFrame;
    frames.push(f);
    if (f.type === 'agent_event') events.push({ sessionId: f.sessionId, event: f.event });
    if (f.type === 'rpc') {
      let result: unknown = { ok: true };
      if (f.method === 'session_begin') result = { activeTabId: 'tab-7', tabs: [{ tab_id: 'tab-7', title: 'Store', url: 'https://store.test/', active: true }] };
      if (f.method === 'execute') {
        const p = f.params as { member: string; input: { url?: string } };
        result = { isError: false, content: [{ type: 'text', text: p.member === 'navigate' ? `Navigated to ${p.input.url} (title: "A").` : 'Done.' }] };
      }
      ws.send(JSON.stringify({ type: 'rpc_result', id: f.id, result }));
    }
  });
  await new Promise<void>((r, j) => {
    ws.on('open', () => r());
    ws.on('error', j);
  });
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN, clientId: 'history-client', protocol: PROTOCOL_VERSION, extensionVersion: 'test', userAgent: 'vitest' }));
  let n = 0;
  const call = <T,>(frame: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const requestId = `h${++n}`;
      ws.send(JSON.stringify({ ...frame, requestId }));
      const t0 = Date.now();
      const tick = () => {
        const f = frames.find((x) => x.type === 'response' && x.requestId === requestId) as Extract<ServerFrame, { type: 'response' }> | undefined;
        if (f) return f.ok ? resolve(f.data as T) : reject(new Error(f.error));
        if (Date.now() - t0 > 10_000) return reject(new Error('timeout'));
        setTimeout(tick, 15);
      };
      tick();
    });
  const turnDone = async (sessionId: string, count = 1) => {
    const t0 = Date.now();
    while (events.filter((e) => e.sessionId === sessionId && e.event.type === 'turn_done').length < count) {
      if (Date.now() - t0 > 10_000) throw new Error('turn did not finish');
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return { ws, events, call, turnDone };
}

type History = { events: { seq: number; event: AgentEvent }[]; status: string; archived: boolean };

describe('chat history', () => {
  let firstId = '';
  let secondId = '';

  it('lists a chat while it is in memory', async () => {
    const { server, port } = await start();
    const ext = await extension(port);
    const { sessionId } = await ext.call<{ sessionId: string }>({ type: 'send_message', text: 'Fill in the Grimes rows', profileId: 'mock-open' });
    firstId = sessionId;
    await ext.turnDone(sessionId);
    const chats = await ext.call<ChatInfo[]>({ type: 'list_chats' });
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ sessionId, title: 'Fill in the Grimes rows', profileId: 'mock-open', messages: 1, live: true, running: false, lastReply: 'Opened page A and found 3 rows.' });
    ext.ws.close();
    await server.close();
  });

  it('shows a saved chat again after the server restarts', async () => {
    const { server, port } = await start();
    const ext = await extension(port);
    const [chat] = await ext.call<ChatInfo[]>({ type: 'list_chats' });
    expect(chat).toMatchObject({ sessionId: firstId, live: false });
    const h = await ext.call<History>({ type: 'get_history', sessionId: firstId });
    expect(h.archived).toBe(true);
    expect(h.status).toBe('idle');
    const types = h.events.map((e) => e.event.type);
    expect(types).toEqual(['user_message', 'tool_call', 'tool_result', 'text', 'turn_done']);
    expect(h.events[1].event).toMatchObject({ type: 'tool_call', member: 'navigate', summary: expect.stringContaining('store.test/a') });
    expect(h.events[2].event).toMatchObject({ type: 'tool_result', isError: false, text: expect.stringContaining('Navigated to') });
    ext.ws.close();
    await server.close();
  });

  it('carries a saved chat on in a new chat that gets a summary of it', async () => {
    const { server, port } = await start();
    const ext = await extension(port);
    const { sessionId } = await ext.call<{ sessionId: string }>({ type: 'send_message', text: 'keep going', profileId: 'mock', continueFrom: firstId });
    secondId = sessionId;
    expect(sessionId).not.toBe(firstId);
    await ext.turnDone(sessionId);
    const mine = ext.events.filter((e) => e.sessionId === sessionId).map((e) => e.event);
    // The user sees only what they typed; the model got the summary first.
    expect(mine.find((e) => e.type === 'user_message')).toEqual({ type: 'user_message', text: 'keep going' });
    const reply = (mine.find((e) => e.type === 'text') as { text: string }).text;
    expect(reply).toContain('carries on from an earlier conversation');
    expect(reply).toContain('User: Fill in the Grimes rows');
    expect(reply).toContain('You (agent): Opened page A and found 3 rows.');
    expect(reply).toContain('(You opened https://store.test/a)');
    expect(reply.indexOf('carries on')).toBeLessThan(reply.indexOf('keep going'));

    // One entry: the old chat is folded into the new one, which keeps its title.
    const chats = await ext.call<ChatInfo[]>({ type: 'list_chats' });
    expect(chats.map((c) => c.sessionId)).toEqual([sessionId]);
    expect(chats[0]).toMatchObject({ title: 'Fill in the Grimes rows', live: true });

    // Opening it shows the old conversation above the new one.
    const h = await ext.call<History>({ type: 'get_history', sessionId });
    expect(h.archived).toBe(false);
    const ev = h.events.map((e) => e.event);
    expect(ev[0]).toMatchObject({ type: 'user_message', text: 'Fill in the Grimes rows' });
    const notice = ev.findIndex((e) => e.type === 'notice' && /Continued in a new chat/.test(e.message));
    expect(notice).toBeGreaterThan(0);
    expect(ev.slice(notice + 1).find((e) => e.type === 'user_message')).toEqual({ type: 'user_message', text: 'keep going' });
    // Replayed events carry seq 0 so the panel's live-event bookkeeping isn't thrown off.
    expect(h.events.slice(0, notice + 1).every((e) => e.seq === 0)).toBe(true);
    expect(h.events[h.events.length - 1].seq).toBeGreaterThan(0);
    ext.ws.close();
    await server.close();
  });

  it('keeps the whole chain after another restart', async () => {
    const { server, port } = await start();
    const ext = await extension(port);
    const chats = await ext.call<ChatInfo[]>({ type: 'list_chats' });
    expect(chats.map((c) => c.sessionId)).toEqual([secondId]);
    const h = await ext.call<History>({ type: 'get_history', sessionId: secondId });
    expect(h.archived).toBe(true);
    const users = h.events.filter((e) => e.event.type === 'user_message').map((e) => (e.event as { text: string }).text);
    expect(users).toEqual(['Fill in the Grimes rows', 'keep going']);
    ext.ws.close();
    await server.close();
  });

  it('refuses unknown chats and odd ids', async () => {
    const { server, port } = await start();
    const ext = await extension(port);
    await expect(ext.call({ type: 'get_history', sessionId: '../../keys' })).rejects.toThrow(/Unknown session/);
    await expect(ext.call({ type: 'get_history', sessionId: 's_nothere' })).rejects.toThrow(/Unknown session/);
    await expect(ext.call({ type: 'send_message', text: 'hi', continueFrom: 's_nothere' })).rejects.toThrow(/couldn't be found/);
    ext.ws.close();
    await server.close();
  });
});

describe('ChatHistory', () => {
  it('marks a chat that was cut off and trims long summaries from the start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-history-unit-'));
    const chat = path.join(dir, 'sessions', '2026-01-02T03-04-05_s_cut');
    fs.mkdirSync(chat, { recursive: true });
    const recs = [
      { t: '2026-01-02T03:04:05Z', kind: 'user', text: 'old request', profile: 'mock' },
      ...Array.from({ length: 30 }, (_, i) => ({ t: '2026-01-02T03:05:00Z', kind: 'turn_done', reason: 'end_turn', finalText: `reply ${i} ${'x'.repeat(900)}` })),
      { t: '2026-01-02T03:06:00Z', kind: 'user', text: 'newest request' },
      { t: '2026-01-02T03:06:01Z', kind: 'assistant', parts: [{ type: 'thinking', text: 'hmm' }, { type: 'tool_call', id: 'c1', name: 'read_page' }] },
    ];
    fs.writeFileSync(path.join(chat, 'events.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n{"torn');
    const h = new ChatHistory(dir);
    const [info] = h.list();
    expect(info).toMatchObject({ sessionId: 's_cut', title: 'old request', messages: 2, profileId: 'mock' });
    const ev = h.replay('s_cut')!;
    expect(ev[ev.length - 1]).toMatchObject({ type: 'notice', level: 'warn', message: expect.stringContaining('interrupted') });
    const recap = h.recap('s_cut', 5000)!;
    expect(recap).toContain('User: newest request');
    expect(recap).toContain('(earlier messages left out)');
    expect(recap).not.toContain('User: old request');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
