/**
 * Mutual authentication and code pairing between the extension and the server, plus the
 * DNS-rebinding Host check. The client side is done by hand here, exactly as the extension does it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerFrame } from '@ba/shared';
import type { ServerConfig } from '../src/config.ts';
import { clientProof, newNonce, pairingDerive, serverProof, whoamiProof, type PairPrompter } from '../src/pairing.ts';
import { AgentServer } from '../src/server.ts';

const TOKEN = 'pair-token-xyz-0123456789';
let server: AgentServer;
let port: number;
let dataDir: string;
let prompt: PairPrompter | undefined;
const prompts: { code: string; clientId: string }[] = [];

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-pair-'));
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dataDir,
    extensionIds: [],
    profiles: [{ id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' }],
    defaultProfileId: 'mock',
  };
  server = new AgentServer(config, {
    gpu: false,
    pairPrompt: (req) => {
      prompts.push({ code: req.code, clientId: req.clientId });
      return prompt ? prompt(req) : Promise.resolve(false);
    },
  });
  port = await server.listen(0);
});
afterAll(async () => {
  await server.close();
});

const base = (clientId: string) => ({ type: 'hello', clientId, protocol: PROTOCOL_VERSION, extensionVersion: 't', userAgent: 'Mozilla/5.0 Chrome/140 vitest' });

/** Open a socket and collect frames; resolves once connected. */
async function open(headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const frames: ServerFrame[] = [];
  let closeCode = 0;
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as ServerFrame;
    frames.push(f);
  });
  const closed = new Promise<number>((r) => ws.on('close', (c) => r((closeCode = c))));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  // Read frames in order with a cursor, so bursts (pair_pending, paired, hello_ok) aren't skipped.
  let cursor = 0;
  const nextFrame = (): Promise<ServerFrame> =>
    new Promise<ServerFrame>((r) => {
      const check = () => (frames.length > cursor ? r(frames[cursor++]) : setTimeout(check, 5));
      check();
    });
  return { ws, frames, closed, nextFrame, send: (f: unknown) => ws.send(JSON.stringify(f)), closeCode: () => closeCode };
}

/** The extension's side of the mutual handshake with a given secret. */
async function handshake(secret: string, keyType: 'token' | 'paired' = 'token', clientId = `c-${newNonce().slice(0, 8)}`) {
  const c = await open();
  const clientNonce = newNonce();
  c.send({ ...base(clientId), clientNonce, keyType });
  const ch = await c.nextFrame();
  if (ch.type !== 'challenge') return { c, result: ch.type === 'hello_error' ? ch.message : ch.type, serverOk: false };
  const serverOk = ch.proof === serverProof(secret, clientNonce);
  c.send({ type: 'auth', proof: clientProof(secret, ch.serverNonce) });
  const r = await c.nextFrame();
  return { c, result: r.type === 'hello_ok' ? 'ok' : r.type === 'hello_error' ? r.message : r.type, serverOk };
}

describe('mutual handshake', () => {
  it('connects when both sides hold the token, and the server proves it first', async () => {
    const { c, result, serverOk } = await handshake(TOKEN);
    expect(serverOk).toBe(true);
    expect(result).toBe('ok');
    c.ws.close();
  });
  it('with a wrong secret the server cannot prove itself, and our proof is refused', async () => {
    const { c, result, serverOk } = await handshake('not-the-token');
    expect(serverOk).toBe(false); // the extension would stop here and reveal nothing
    expect(result).toMatch(/Authentication failed/);
    expect(await c.closed).toBe(4003);
  });
  it('never sends the secret: the challenge only carries a nonce and an HMAC', async () => {
    const c = await open();
    c.send({ ...base('c-peek'), clientNonce: newNonce(), keyType: 'token' });
    const ch = await c.nextFrame();
    expect(JSON.stringify(ch)).not.toContain(TOKEN);
    c.ws.close();
  });
  it('rejects auth before a challenge, junk proofs and malformed nonces', async () => {
    const a = await open();
    a.send({ type: 'auth', proof: 'x' });
    expect(await a.closed).toBe(4002);
    const b = await open();
    b.send({ ...base('c-bad'), clientNonce: 'not-hex!' });
    const r = await b.nextFrame();
    expect(r.type).toBe('hello_error');
    const d = await open();
    d.send({ ...base('c-junk'), clientNonce: newNonce(), keyType: 'token' });
    await d.nextFrame();
    d.send({ type: 'auth', proof: { toString: 1 } });
    expect(((await d.nextFrame()) as { message: string }).message).toMatch(/Authentication failed/);
  });
  it('still accepts scripts that send the raw token, and refuses a wrong one', async () => {
    const ok = await open();
    ok.send({ ...base('c-script'), token: TOKEN });
    expect((await ok.nextFrame()).type).toBe('hello_ok');
    ok.ws.close();
    const bad = await open();
    bad.send({ ...base('c-script2'), token: 'nope' });
    expect(((await bad.nextFrame()) as { message: string }).message).toMatch(/Invalid pairing token/);
    const none = await open();
    none.send(base('c-script3'));
    expect(((await none.nextFrame()) as { message: string }).message).toMatch(/needs a pairing token/);
  });
});

/** The extension's side of pairing: ECDH key exchange, derive the same code/secret as the server. */
async function startPair(clientId: string): Promise<{ c: Awaited<ReturnType<typeof open>>; error?: string; code?: string; secret?: string; confirm?: string }> {
  const c = await open();
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey().toString('base64');
  c.send({ ...base(clientId), pairCommit: crypto.createHash('sha256').update(pub).digest('hex') });
  const pending = await c.nextFrame();
  if (pending.type !== 'pair_pending') return { c, error: (pending as { message?: string }).message ?? pending.type };
  c.send({ type: 'pair_reveal', publicKey: pub });
  const shared = ecdh.computeSecret(Buffer.from(pending.publicKey, 'base64'));
  return { c, ...pairingDerive(shared, pub, pending.publicKey) };
}

describe('pairing (key exchange + matching codes)', () => {
  it('pairs only when the panel and the server window both confirm the same code', async () => {
    let shown = '';
    prompt = async (req) => {
      shown = req.code;
      return true;
    };
    const r = await startPair('c-browser-1');
    expect(r.code).toMatch(/^\d{6}$/);
    await new Promise((x) => setTimeout(x, 20));
    expect(shown).toBe(r.code); // the server window shows exactly the code the panel shows
    r.c.send({ type: 'pair_confirm', proof: r.confirm });
    expect((await r.c.nextFrame()).type).toBe('hello_ok');
    // The secret was derived on both sides; it never appeared in any frame.
    expect(JSON.stringify(r.c.frames)).not.toContain(r.secret!);
    r.c.ws.close();
    const again = await handshake(r.secret!, 'paired', 'c-browser-1');
    expect(again.serverOk).toBe(true);
    expect(again.result).toBe('ok');
    const other = await handshake(r.secret!, 'paired', 'c-browser-2');
    expect(other.result).toMatch(/no longer paired/);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dataDir, 'paired.json')).mode & 0o077).toBe(0);
  });
  it('a wrong confirmation (codes did not match) is refused even if the server window said yes', async () => {
    prompt = async () => true;
    const r = await startPair('c-browser-3');
    r.c.send({ type: 'pair_confirm', proof: '00'.repeat(32) });
    expect(((await r.c.nextFrame()) as { message: string }).message).toMatch(/codes did not match/);
    expect(server.paired.secretFor('c-browser-3')).toBeUndefined();
  });
  it('declined in the server window: nothing is paired, even if the panel confirmed', async () => {
    prompt = async () => false;
    const r = await startPair('c-browser-4');
    r.c.send({ type: 'pair_confirm', proof: r.confirm });
    expect(((await r.c.nextFrame()) as { message: string }).message).toMatch(/declined/);
    expect(server.paired.secretFor('c-browser-4')).toBeUndefined();
  });
  it('server says yes but the panel never confirms: not paired', async () => {
    prompt = async () => true;
    const r = await startPair('c-browser-5');
    await new Promise((x) => setTimeout(x, 100));
    expect(r.c.frames.some((f) => f.type === 'hello_ok')).toBe(false);
    expect(server.paired.secretFor('c-browser-5')).toBeUndefined();
    r.c.ws.close();
  });
  it('rejects invalid keys, a second request while one is waiting', async () => {
    (server as any).pairingAttempts = []; // earlier tests used up this minute's attempts
    // A revealed key that isn't the committed one, or isn't a curve point, is refused.
    const e = crypto.createECDH('prime256v1');
    e.generateKeys();
    const swap = await open();
    swap.send({ ...base('c-swap'), pairCommit: crypto.createHash('sha256').update(e.getPublicKey('base64')).digest('hex') });
    await swap.nextFrame();
    const other = crypto.createECDH('prime256v1');
    other.generateKeys();
    swap.send({ type: 'pair_reveal', publicKey: other.getPublicKey('base64') });
    expect(((await swap.nextFrame()) as { message: string }).message).toMatch(/Invalid pairing request/);
    const junk = Buffer.alloc(65, 1).toString('base64');
    const bad = await open();
    bad.send({ ...base('c-bad-key'), pairCommit: crypto.createHash('sha256').update(junk).digest('hex') });
    await bad.nextFrame();
    bad.send({ type: 'pair_reveal', publicKey: junk });
    expect(((await bad.nextFrame()) as { message: string }).message).toMatch(/Invalid pairing request/);
    const noCommit = await open();
    noCommit.send({ ...base('c-nocommit'), pairCommit: 'xyz' });
    expect(((await noCommit.nextFrame()) as { message: string }).message).toMatch(/Invalid pairing request/);
    (server as any).pairingAttempts = [];
    let release!: (v: boolean) => void;
    prompt = () => new Promise<boolean>((r) => (release = r));
    const first = await startPair('c-p1');
    const second = await startPair('c-p2');
    expect(second.error).toMatch(/Another pairing request/);
    release(false);
    await first.c.closed;
  });
});

describe('pairing rate limit', () => {
  it('allows at most 5 pairing attempts a minute', async () => {
    const s2 = new AgentServer({ ...server.config, port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ba-pair3-')) }, { gpu: false, pairPrompt: async () => false });
    const p2 = await s2.listen(0);
    const attempt = () =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws`);
        const e = crypto.createECDH('prime256v1');
        e.generateKeys();
        const pub = e.getPublicKey().toString('base64');
        ws.on('open', () => ws.send(JSON.stringify({ ...base(`c-r-${Math.random()}`.replace('.', '')), pairCommit: crypto.createHash('sha256').update(pub).digest('hex') })));
        ws.on('message', (d) => {
          const f = JSON.parse(String(d));
          if (f.type === 'pair_pending') ws.send(JSON.stringify({ type: 'pair_reveal', publicKey: pub }));
          if (f.type === 'hello_error') resolve(f.message);
        });
      });
    const results: string[] = [];
    for (let i = 0; i < 6; i++) results.push(await attempt());
    expect(results.slice(0, 5).every((m) => /declined/.test(m))).toBe(true);
    expect(results[5]).toMatch(/Too many pairing attempts/);
    await s2.close();
  });
});

describe('without a pairing prompt (background service)', () => {
  it('asks for the token instead', async () => {
    const quiet = new AgentServer({ ...server.config, port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ba-pair2-')) }, { gpu: false });
    const p = await quiet.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`);
    const msg = await new Promise<string>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ ...base('c-q'), pairCommit: 'a'.repeat(64) })));
      ws.on('message', (d) => resolve((JSON.parse(String(d)) as { message: string }).message));
    });
    expect(msg).toMatch(/Paste the pairing token/);
    ws.close();
    await quiet.close();
  });
});

describe('DNS rebinding guard and whoami', () => {
  const get = (p: string, host: string) =>
    new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => resolve(res.statusCode ?? 0)));
  it('refuses HTTP and WebSocket requests addressed to another hostname', async () => {
    expect(await get('/health', `127.0.0.1:${port}`)).toBe(200);
    expect(await get('/health', `localhost:${port}`)).toBe(200);
    expect(await get('/health', `evil.example:${port}`)).toBe(403);
    expect(await get('/api/state', `rebind.attacker.test:${port}`)).toBe(403);
    await expect(open({ host: `evil.example:${port}` })).rejects.toThrow();
  });
  it('whoami proves token knowledge without revealing it, domain-separated from the handshake', async () => {
    const nonce = newNonce();
    const r = (await (await fetch(`http://127.0.0.1:${port}/whoami?nonce=${nonce}`)).json()) as { proof: string };
    expect(r.proof).toBe(whoamiProof(TOKEN, nonce));
    expect(r.proof).not.toBe(serverProof(TOKEN, nonce)); // can't be replayed as a handshake answer
    expect((await fetch(`http://127.0.0.1:${port}/whoami?nonce=zz`)).status).toBe(400);
  });
});
