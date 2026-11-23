/**
 * Starting a local CAPTCHA helper's model server (the optional `startScript`, a PowerShell script).
 * It must never take the agent server down: not on macOS/Linux, where there is no PowerShell to
 * run it, and not on Windows when PowerShell can't be started.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned: { command: string; child: EventEmitter & { unref(): void } }[] = [];
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (command: string) => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    spawned.push({ command, child });
    return child;
  },
}));

const { AgentServer } = await import('../src/server.ts');

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  setPlatform(realPlatform);
  spawned.length = 0;
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A server whose CAPTCHA helper profile has a start script and a model server that is down. */
async function serverWithHelper() {
  // A port nothing listens on: the helper's model server "is down".
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-helper-'));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = new AgentServer(
    {
      host: '127.0.0.1',
      port: 0,
      token: 't',
      dataDir,
      extensionIds: [],
      profiles: [
        { id: 'kraken', label: 'Solver', provider: 'openai', model: 'solver', baseURL: `http://127.0.0.1:${port}/v1`, vision: true, captchaProtocol: 'kraken', startScript: 'C:/somewhere/start-server.ps1' },
        { id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' },
      ],
      defaultProfileId: 'mock',
    },
    { gpu: false, transcripts: false, settings: { captchaHelperProfileId: 'kraken' } },
  );
  cleanup.push(() => server.close());
  return server;
}

describe('starting the CAPTCHA helper model server', () => {
  it('does nothing on macOS/Linux, where the PowerShell start script cannot run', async () => {
    setPlatform('linux');
    const server = await serverWithHelper();
    await server.prepareCaptchaHelper();
    expect(spawned).toEqual([]);
  });

  it('survives PowerShell failing to start on Windows', async () => {
    setPlatform('win32');
    const server = await serverWithHelper();
    const done = server.prepareCaptchaHelper();
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    expect(spawned[0].command).toBe('powershell.exe');
    // What Node does when the program can't be started: an 'error' event, which kills the
    // process unless something listens for it.
    expect(() => spawned[0].child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    // It gives up on the helper rather than waiting minutes for a server that will never start.
    await expect(Promise.race([done.then(() => 'returned'), new Promise((r) => setTimeout(() => r('still waiting'), 4000))])).resolves.toBe('returned');
  });
});
