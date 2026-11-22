/**
 * Starting the agent again must work as a restart: a newer server asks the old one (same token)
 * to shut down and takes over its port.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config.ts';
import { listenReplacingOld } from '../src/index.ts';
import { AgentServer } from '../src/server.ts';

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const cfg = (port: number, token = 'restart-token'): ServerConfig => ({
  host: '127.0.0.1',
  port,
  token,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ba-restart-')),
  extensionIds: [],
  profiles: [{ id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' }],
  defaultProfileId: 'mock',
});

describe('starting the agent again', () => {
  it('replaces an older agent server on the same port', async () => {
    const port = await freePort();
    let oldStopped = false;
    const old: AgentServer = new AgentServer(cfg(port), {
      gpu: false,
      onShutdownRequest: () => void old.close().then(() => (oldStopped = true)),
    });
    await old.listen();
    const fresh = new AgentServer(cfg(port), { gpu: false });
    const logs: string[] = [];
    expect(await listenReplacingOld(fresh, cfg(port), (m) => logs.push(m))).toBe(port);
    expect(oldStopped).toBe(true);
    expect(logs.join()).toMatch(/older agent server is still running/);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.ok).toBe(true);
    await fresh.close();
  });

  it('does not let a request without the token shut the server down', async () => {
    const port = await freePort();
    let asked = false;
    const s = new AgentServer(cfg(port), { gpu: false, onShutdownRequest: () => (asked = true) });
    await s.listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    expect(asked).toBe(false);
    // A server with a different token (another install) is told no, in plain words.
    const other = new AgentServer(cfg(port, 'other-token'), { gpu: false });
    await expect(listenReplacingOld(other, cfg(port, 'other-token'), () => {})).rejects.toThrow(/didn't agree to stop \(HTTP 401\)/);
    await s.close();
  });

  it('explains when a different program holds the port', async () => {
    const port = await freePort();
    const squatter = http.createServer((_q, r) => r.end('hello'));
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
    const s = new AgentServer(cfg(port), { gpu: false });
    await expect(listenReplacingOld(s, cfg(port), () => {})).rejects.toThrow(/used by another program/);
    await new Promise<void>((r) => squatter.close(() => r()));
  });
});
