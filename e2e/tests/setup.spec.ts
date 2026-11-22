/**
 * End-to-end: first-run experience and connection security in real Chrome.
 *  - the side panel guides the user when the server isn't running;
 *  - pairing only on a click, with matching codes confirmed in the panel and the server window;
 *  - the extension refuses a fake server squatting on the port (no handshake / forged proof)
 *    and never runs its commands.
 */
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { SERVER_DOWNLOAD_URL } from '@ba/shared';
import { startEnv, type Env } from './harness.ts';

test.describe.configure({ mode: 'serial' });
let env: Env;
let panel: Page;
let serverUrl: string;

const setConfig = (cfg: { serverUrl: string; token: string }) =>
  env.sw.evaluate(async (c) => {
    await (globalThis as any).__ba.bridge.setConfig(c);
  }, cfg);
const stored = () => env.sw.evaluate(async () => chrome.storage.local.get(['token', 'keyType']));

test.beforeAll(async () => {
  env = await startEnv();
  serverUrl = `ws://127.0.0.1:${((env.server as any).httpServer.address() as { port: number }).port}/ws`;
  panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  await expect(panel.locator('#setup')).toBeHidden();
});
test.afterAll(async () => {
  await env?.close();
});

test('shows how to start the server when it is not running', async () => {
  await setConfig({ serverUrl: 'ws://127.0.0.1:1/ws', token: 'e2e-token' });
  const setup = panel.locator('#setup');
  await expect(setup).toBeVisible();
  await expect(setup.locator('h2')).toHaveText('Start the agent server');
  const link = setup.getByRole('link', { name: 'Download the Browser Agent server' });
  await expect(link).toHaveAttribute('href', SERVER_DOWNLOAD_URL);
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(setup).toContainText('Start Browser Agent.cmd');
  await expect(panel.locator('#banner')).toBeHidden();
  await expect(panel.locator('#btn-send')).toBeDisabled();
});

test('never starts pairing by itself: no secret means it waits for a click', async () => {
  let asked = 0;
  (env.server as any).pairPrompt = async () => {
    asked++;
    return false;
  };
  try {
    await setConfig({ serverUrl, token: '' });
    await expect(panel.locator('#conn .conn-label')).toHaveText('Not paired');
    await expect(panel.locator('#setup h2')).toHaveText('Connect to your server');
    await panel.waitForTimeout(2000);
    expect(asked).toBe(0);
  } finally {
    (env.server as any).pairPrompt = undefined;
  }
});

test('without a pairing prompt on the server, it says to use the token', async () => {
  await panel.locator('#setup').getByRole('button', { name: 'Pair this browser' }).click();
  await expect(panel.locator('#setup')).toContainText('Paste the pairing token');
});

test('pairs when the panel and the server window show the same code and both confirm', async () => {
  let approve!: (ok: boolean) => void;
  let serverCode = '';
  (env.server as any).pairPrompt = (req: { code: string }) => {
    serverCode = req.code;
    return new Promise<boolean>((r) => (approve = r));
  };
  try {
    await panel.locator('#setup').getByRole('button', { name: 'Pair this browser' }).click();
    await expect(panel.locator('#conn .conn-label')).toHaveText('Pairing…');
    const code = panel.locator('#setup .pair-code');
    await expect(code).toHaveText(/^\d{6}$/);
    expect(await code.textContent()).toBe(serverCode); // numeric comparison: same code on both sides
    await panel.locator('#setup').getByRole('button', { name: 'Codes match' }).click();
    await expect(panel.locator('#setup h2')).toHaveText('Almost there');
    approve(true);
    await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
    const st = await stored();
    expect(st.keyType).toBe('paired');
    expect(String(st.token).length).toBeGreaterThanOrEqual(40);
    // Reconnect from scratch: the derived secret alone gets through the mutual handshake.
    await env.sw.evaluate(async () => {
      const b = (globalThis as any).__ba.bridge;
      b.disconnect();
      await b.connect();
    });
    await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  } finally {
    (env.server as any).pairPrompt = undefined;
  }
});

test('a pairing declined in the server window stops and does not keep asking', async () => {
  let asks = 0;
  (env.server as any).pairPrompt = async () => {
    asks++;
    return false;
  };
  try {
    await setConfig({ serverUrl, token: '' });
    await panel.locator('#setup').getByRole('button', { name: 'Pair this browser' }).click();
    await expect(panel.locator('#setup')).toContainText('declined');
    await panel.waitForTimeout(2500);
    expect(asks).toBe(1);
    expect((await stored()).token).toBe('');
  } finally {
    (env.server as any).pairPrompt = undefined;
  }
});

test('a fake server answering a pairing request gets nothing without the user confirming the code', async () => {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => fake.on('listening', () => r()));
  const received: any[] = [];
  fake.on('connection', (ws) => {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d));
      received.push(f);
      if (f.type !== 'hello') return;
      const e = crypto.createECDH('prime256v1');
      e.generateKeys();
      ws.send(JSON.stringify({ type: 'pair_pending', publicKey: e.getPublicKey().toString('base64') }));
      ws.send(JSON.stringify({ type: 'hello_ok', serverVersion: 'x', protocol: 2, profiles: [], defaultProfileId: 'x', settings: {} }));
      ws.send(JSON.stringify({ type: 'rpc', id: 'evil-1', method: 'session_begin', params: { sessionId: 'evil' } }));
    });
  });
  const port = (fake.address() as { port: number }).port;
  try {
    await setConfig({ serverUrl: `ws://127.0.0.1:${port}/ws`, token: '' });
    await panel.locator('#setup').getByRole('button', { name: 'Pair this browser' }).click();
    // It skipped straight to hello_ok: refused, without ever showing "Connected" or running the rpc.
    await expect(panel.locator('#conn .conn-label')).not.toHaveText('Connected');
    await panel.waitForTimeout(800);
    await expect(panel.locator('#conn .conn-label')).not.toHaveText('Connected');
    // It may see our public key (harmless), but never a confirmation or a command result.
    expect(received.map((f) => f.type).filter((t) => t !== 'pair_reveal')).toEqual(['hello']);
    expect(received[0].pairCommit).toMatch(/^[0-9a-f]{64}$/);
    expect((await stored()).token).toBe('');
  } finally {
    fake.close();
    await setConfig({ serverUrl, token: 'e2e-token' });
    await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  }
});

test('a wrong token is caught by the extension before it reveals anything', async () => {
  await setConfig({ serverUrl, token: 'wrong-token' });
  await expect(panel.locator('#conn .conn-label')).toHaveText('Error');
  await expect(panel.locator('#banner')).toContainText("doesn't match the server");
  await expect(panel.locator('#banner').getByRole('button', { name: 'Pair again' })).toBeVisible();
  await setConfig({ serverUrl, token: 'e2e-token' });
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
});

for (const variant of ['skips the handshake', 'forges the proof'] as const) {
  test(`refuses a fake server on the port that ${variant}, and never runs its commands`, async () => {
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => fake.on('listening', () => r()));
    const received: any[] = [];
    fake.on('connection', (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        received.push(f);
        if (f.type !== 'hello') return;
        if (variant === 'forges the proof') ws.send(JSON.stringify({ type: 'challenge', serverNonce: 'ab'.repeat(24), proof: '00'.repeat(32) }));
        ws.send(JSON.stringify({ type: 'hello_ok', serverVersion: 'x', protocol: 2, profiles: [], defaultProfileId: 'x', settings: {} }));
        ws.send(JSON.stringify({ type: 'rpc', id: 'evil-1', method: 'session_begin', params: { sessionId: 'evil', tab_id: 'all' } }));
      });
    });
    const port = (fake.address() as { port: number }).port;
    try {
      await setConfig({ serverUrl: `ws://127.0.0.1:${port}/ws`, token: 'e2e-token' });
      await expect(panel.locator('#conn .conn-label')).toHaveText('Error');
      await panel.waitForTimeout(500);
      expect(received.map((f) => f.type)).toEqual(['hello']); // no auth proof, no rpc_result
      expect(JSON.stringify(received)).not.toContain('e2e-token'); // the secret never left the browser
    } finally {
      fake.close();
      await setConfig({ serverUrl, token: 'e2e-token' });
      await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
    }
  });
}
