/**
 * The side panel's "Save & test" explains provider-side failures in plain words: a provider that
 * takes the request but never answers (seen with NVIDIA NIM), and an account without access.
 */
import http from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { testProfile } from '../src/model-test.ts';
import type { ModelProfile } from '../src/providers/types.ts';

const KEY = 'BA_TEST_ERRORS_KEY';
process.env[KEY] = 'nvapi-test';
const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`;
}

const profile = (baseURL: string): ModelProfile => ({ id: 'nim', label: 'NIM', provider: 'openai', model: 'deepseek-ai/deepseek-v4.1-flash', baseURL, apiKeyEnv: KEY, vision: false, toolSet: 'full' });

afterAll(async () => {
  delete process.env[KEY];
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('model test messages', () => {
  it('says the provider never answered when it hangs up without a reply', async () => {
    const url = await serve((req, res) => {
      if (req.url?.includes('/models')) return void res.writeHead(404).end();
      req.resume();
      req.on('end', () => setTimeout(() => res.socket?.destroy(), 50));
    });
    const r = await testProfile(profile(url), 20_000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/The key was accepted, but the provider never answered \(it closed the connection after \d+s\)/);
  });

  it('says so when nothing comes back before the time limit', async () => {
    const url = await serve((req) => req.resume());
    const r = await testProfile(profile(url), 1_500);
    expect(r.message).toMatch(/never answered \(stopped waiting after \d+s\)/);
  });

  it('explains an account without access to the model', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 404, title: 'Not Found', detail: "Function 'abc': Not found for account 'xyz'" }));
    });
    const r = await testProfile(profile(url), 20_000);
    expect(r.message).toMatch(/your account doesn't have access to "deepseek-ai\/deepseek-v4.1-flash"/);
  });
});
