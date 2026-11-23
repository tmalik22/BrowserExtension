/**
 * Server fixes: a replaced API key is used straight away, finished chats don't pile up in
 * memory, old saved chats can be deleted on start-up, and the data folder is private to the user.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type AgentEvent, type ServerFrame } from '@ba/shared';
import { protectDataDir, type ServerConfig } from '../src/config.ts';
import { ChatHistory } from '../src/history.ts';
import type { ModelProfile } from '../src/providers/types.ts';
import { AgentServer, MAX_LIVE_SESSIONS } from '../src/server.ts';
import { fakeServer, openaiSse } from './fake-servers.ts';

const TOKEN = 'fixes-token';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const tmp = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ba-${name}-`));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const baseConfig = (dataDir: string, profiles: ModelProfile[]): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  token: TOKEN,
  dataDir,
  extensionIds: [],
  profiles: [...profiles, { id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' }],
  defaultProfileId: 'mock',
});

/** A fake extension: answers browser RPCs and can make side-panel requests. */
async function extension(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: ServerFrame[] = [];
  const events: { sessionId: string; event: AgentEvent }[] = [];
  const rpcs: string[] = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as ServerFrame;
    frames.push(f);
    if (f.type === 'agent_event') events.push({ sessionId: f.sessionId, event: f.event });
    if (f.type === 'rpc') {
      rpcs.push(f.method);
      const result = f.method === 'session_begin' ? { activeTabId: 'tab-1', tabs: [{ tab_id: 'tab-1', title: 'T', url: 'https://example.com/', active: true }] } : { ok: true };
      ws.send(JSON.stringify({ type: 'rpc_result', id: f.id, result }));
    }
  });
  await new Promise<void>((r, j) => {
    ws.on('open', () => r());
    ws.on('error', j);
  });
  cleanup.push(() => ws.close());
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN, clientId: 'fixes-client', protocol: PROTOCOL_VERSION, extensionVersion: 'test', userAgent: 'vitest' }));
  let n = 0;
  const call = <T,>(frame: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const requestId = `f${++n}`;
      ws.send(JSON.stringify({ ...frame, requestId }));
      const t0 = Date.now();
      const tick = () => {
        const f = frames.find((x) => x.type === 'response' && x.requestId === requestId) as Extract<ServerFrame, { type: 'response' }> | undefined;
        if (f) return f.ok ? resolve(f.data as T) : reject(new Error(f.error));
        if (Date.now() - t0 > 10_000) return reject(new Error('timeout'));
        setTimeout(tick, 10);
      };
      tick();
    });
  const turnDone = async (sessionId: string, count = 1) => {
    const t0 = Date.now();
    while (events.filter((e) => e.sessionId === sessionId && e.event.type === 'turn_done').length < count) {
      if (Date.now() - t0 > 10_000) throw new Error('turn did not finish');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, events, rpcs, call, turnDone };
}

describe('a replaced API key', () => {
  it('is used by the next message, in old chats and new ones, without restarting the server', async () => {
    const NAME = 'BA_FIXES_API_KEY';
    const provider = await fakeServer(() => ({ sse: openaiSse({ text: 'ok' }) }));
    cleanup.push(() => provider.close());
    cleanup.push(() => delete process.env[NAME]);
    process.env[NAME] = 'first-key-0123456789';
    const profile: ModelProfile = { id: 'p', label: 'P', provider: 'openai', model: 'm', baseURL: `${provider.url}/v1`, apiKeyEnv: NAME, vision: false, toolSet: 'full', contextTokens: 100_000 };
    const server = new AgentServer(baseConfig(tmp('key'), [profile]), { gpu: false, transcripts: false });
    cleanup.push(() => server.close());
    const ext = await extension(await server.listen(0));
    const auth = () => provider.requests.map((r) => r.headers.authorization);

    const { sessionId } = await ext.call<{ sessionId: string }>({ type: 'send_message', text: 'hi', profileId: 'p' });
    await ext.turnDone(sessionId);
    expect(auth()).toEqual(['Bearer first-key-0123456789']);

    // The user pastes a new key in the side panel (the old one was revoked, say).
    await ext.call({ type: 'set_api_key', name: NAME, key: 'second-key-9876543210' });

    await ext.call({ type: 'send_message', text: 'again', sessionId, profileId: 'p' });
    await ext.turnDone(sessionId, 2);
    expect(auth()[1]).toBe('Bearer second-key-9876543210');

    const fresh = await ext.call<{ sessionId: string }>({ type: 'send_message', text: 'new chat', profileId: 'p' });
    await ext.turnDone(fresh.sessionId);
    expect(auth()[2]).toBe('Bearer second-key-9876543210');
  });
});

describe('finished chats', () => {
  it('are let go from memory once there are many, and the browser is told to end them', async () => {
    const dataDir = tmp('prune');
    const server = new AgentServer(baseConfig(dataDir, []), { gpu: false });
    cleanup.push(() => server.close());
    const ext = await extension(await server.listen(0));
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_SESSIONS + 5; i++) {
      const { sessionId } = await ext.call<{ sessionId: string }>({ type: 'send_message', text: `task ${i}`, profileId: 'mock' });
      await ext.turnDone(sessionId);
      ids.push(sessionId);
    }
    const live = ids.filter((id) => server.getSession(id));
    expect(live.length).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
    // The oldest went first; the newest are all still there.
    expect(server.getSession(ids[0])).toBeUndefined();
    expect(server.getSession(ids[ids.length - 1])).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(ext.rpcs.filter((m) => m === 'session_end').length).toBeGreaterThanOrEqual(5);
    // A chat that was let go is still there to read (from its saved transcript)…
    const h = await ext.call<{ archived: boolean; events: unknown[] }>({ type: 'get_history', sessionId: ids[0] });
    expect(h.archived).toBe(true);
    expect(h.events.length).toBeGreaterThan(0);
    // …and to carry on, also from a side panel that still has the old chat open: the message
    // starts a new chat that continues it instead of failing.
    const again = await ext.call<{ sessionId: string }>({ type: 'send_message', text: 'carry on', profileId: 'mock', sessionId: ids[0] });
    expect(again.sessionId).not.toBe(ids[0]);
    await ext.turnDone(again.sessionId);
    const carried = await ext.call<{ events: { event: AgentEvent }[] }>({ type: 'get_history', sessionId: again.sessionId });
    expect(carried.events.map((e) => (e.event.type === 'user_message' ? e.event.text : '')).filter(Boolean)).toEqual(['task 0', 'carry on']);
  });
});

describe('deleting old saved chats', () => {
  const stamp = (when: Date) => when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);
  /** A saved chat begun `startedDaysAgo` days ago and last written `lastWrittenDaysAgo` days ago. */
  const chat = (dir: string, id: string, now: Date, startedDaysAgo: number, lastWrittenDaysAgo = startedDaysAgo) => {
    const d = path.join(dir, 'sessions', `${stamp(daysBefore(now, startedDaysAgo))}_${id}`);
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, 'events.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ t: daysBefore(now, startedDaysAgo).toISOString(), kind: 'user', text: id })}\n`);
    fs.writeFileSync(path.join(d, 'image-0001.jpg'), 'x');
    const last = daysBefore(now, lastWrittenDaysAgo);
    fs.utimesSync(file, last, last);
    return d;
  };

  it('removes chats older than the limit and nothing else', () => {
    const dir = tmp('keep');
    const now = new Date('2026-06-15T12:00:00Z');
    const old = chat(dir, 's_old', now, 40);
    const edge = chat(dir, 's_edge', now, 29);
    const recent = chat(dir, 's_recent', now, 1);
    // Begun long ago but used last week: its age is its last use.
    const revived = chat(dir, 's_revived', now, 200, 7);
    // Things that aren't saved chats are never touched.
    const other = path.join(dir, 'sessions', 'my-notes');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(dir, 'sessions', 'README.txt'), 'keep');
    const h = new ChatHistory(dir);
    expect(h.prune(30, now)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(edge)).toBe(true);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(revived)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sessions', 'README.txt'))).toBe(true);
    expect(h.list().map((c) => c.sessionId).sort()).toEqual(['s_edge', 's_recent', 's_revived']);
  });

  it('keeps everything when no limit (or a nonsense one) is set', () => {
    const dir = tmp('keep-all');
    const now = new Date('2026-06-15T12:00:00Z');
    const old = chat(dir, 's_ancient', now, 400);
    const h = new ChatHistory(dir);
    for (const days of [undefined, 0, -3, Number.NaN]) expect(h.prune(days as number, now)).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('happens when the server starts with a limit', () => {
    const dir = tmp('keep-start');
    const old = chat(dir, 's_old', new Date(), 90);
    const recent = chat(dir, 's_recent', new Date(), 2);
    const server = new AgentServer(baseConfig(dir, []), { gpu: false, keepDays: 30 });
    cleanup.push(() => server.close());
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(server.prunedChats).toBe(1);
  });
});

describe('the data folder', () => {
  it('is readable only by the user who runs the server (and the system)', () => {
    const dir = tmp('private');
    fs.writeFileSync(path.join(dir, 'keys.json'), '{}');
    protectDataDir(dir);
    if (process.platform === 'win32') {
      // No inherited entries (whatever the parent folder allows), and only the user, SYSTEM and Administrators.
      for (const target of [dir, path.join(dir, 'keys.json')]) {
        const acl = execFileSync('icacls', [target], { encoding: 'utf8' });
        const entries = acl.split(/\r?\n/).map((l) => l.replace(target, '').trim()).filter((l) => /:\(/.test(l));
        expect(entries.length, acl).toBeGreaterThan(0);
        const who = entries.map((e) => e.slice(0, e.indexOf(':(')).split('\\').pop()!.toLowerCase());
        const allowed = new Set([os.userInfo().username.toLowerCase(), 'system', 'administrators']);
        expect(who.filter((w) => !allowed.has(w)), acl).toEqual([]);
        expect(who, acl).toContain(os.userInfo().username.toLowerCase());
      }
      // The folder's own entries are set here, not inherited from wherever it was created.
      const own = execFileSync('icacls', [dir], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => /:\(/.test(l));
      expect(own.filter((l) => /\(I\)/.test(l))).toEqual([]);
    } else {
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
    }
    // Still usable by the server itself.
    fs.writeFileSync(path.join(dir, 'token.txt'), 'x');
    expect(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).toBe('{}');
  });
});
