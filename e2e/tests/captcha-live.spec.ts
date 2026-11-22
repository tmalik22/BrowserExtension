import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from '@playwright/test';
import { run, script, startEnv, until } from './harness';

// Optional live tests. They need a local CaptchaKraken-compatible server on 127.0.0.1:8082 and:
//   CAPTCHA_PROMPTS_FILE  - path to the model's prompts.json
//   CAPTCHA_API_KEY_FILE  - path to a file holding the server's API key
const PROMPTS_FILE = process.env.CAPTCHA_PROMPTS_FILE ?? '';
const KEY_FILE = process.env.CAPTCHA_API_KEY_FILE ?? '';
let up = false;
test.beforeAll(async () => {
  try {
    up = (await fetch('http://127.0.0.1:8082/health')).ok;
  } catch {
    up = false;
  }
});
test.beforeEach(() => test.skip(!up || !PROMPTS_FILE || !KEY_FILE, 'CaptchaKraken server not running on 127.0.0.1:8082, or CAPTCHA_PROMPTS_FILE / CAPTCHA_API_KEY_FILE not set'));

test('captcha observe and solve a live Turnstile widget', async () => {
  const env = await startEnv({ permissionMode: 'yolo', allowPrivateNetworks: true });
  try {
    const { sessionId } = env.server.startOrContinue({
      text: 'look at the page',
      profileId: 'mock',
      startUrl: env.fx.url('/turnstile.html'),
      autoApprove: 'allow_once',
    });
    await env.server.getSession(sessionId)!.settled();
    await until(() => [...env.context.pages()].some((p) => p.url().includes('turnstile.html')), 30_000, 'page');
    await new Promise((r) => setTimeout(r, 8000));
    const probe = await env.sw.evaluate(
      ([id]) => (globalThis as any).__ba.onRpc('captcha_probe', { sessionId: id }),
      [sessionId],
    );
    expect(probe.challenge).toBe(true);
    const obs: any = await env.sw.evaluate(
      ([id]) => (globalThis as any).__ba.onRpc('captcha_observe', { sessionId: id }),
      [sessionId],
    );
    fs.writeFileSync(path.join(os.tmpdir(), 'captcha-observe.png'), Buffer.from(obs.shot.data, 'base64'));

    const prompt = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8')).templates.action_pixel as string;
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const res = await fetch('http://127.0.0.1:8082/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'captchakraken',
        reasoning_effort: 'none',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${obs.shot.mediaType};base64,${obs.shot.data}` } }] }],
      }),
    });
    const reply = (await res.json()) as any;
    const plan = JSON.parse(reply.choices[0].message.content);
    await env.sw.evaluate(
      ([id, p]) => (globalThis as any).__ba.onRpc('captcha_action', { sessionId: id, plan: p, settings: { allowPrivateNetworks: true, blockedSites: [] } }),
      [sessionId, plan],
    );
    await new Promise((r) => setTimeout(r, 5000));
    const after = await env.sw.evaluate(
      ([id]) => (globalThis as any).__ba.onRpc('captcha_probe', { sessionId: id }),
      [sessionId],
    );
    expect(obs.shot.data.length).toBeGreaterThan(1000);
    expect(after.challenge).toBe(false);
    expect(after.solved).toBe(true);
  } finally {
    await env.close();
  }
});

test('session hands a Turnstile to CaptchaKraken automatically', async () => {
  const env = await startEnv(
    { permissionMode: 'yolo', allowPrivateNetworks: true, captchaHelperProfileId: 'captchakraken' },
    {
      profiles: [
        {
          id: 'captchakraken',
          label: 'CaptchaKraken',
          provider: 'openai',
          model: 'captchakraken',
          baseURL: 'http://127.0.0.1:8082/v1',
          apiKeyFile: KEY_FILE,
          vision: true,
          captchaProtocol: 'kraken',
          contextTokens: 16384,
        },
      ],
    },
  );
  try {
    const s = script([
      () => [{ name: 'navigate', input: { url: env.fx.url('/turnstile.html') } }],
      () => [{ name: 'wait', input: { duration: 6 } }],
      () => 'done',
    ]);
    const r = await run(env, s, { startUrl: env.fx.url('/turnstile.html') });
    const notices = r.events.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message);
    const page = [...env.context.pages()].find((p) => p.url().includes('turnstile.html'))!;
    const token = await page.evaluate(() => (document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement)?.value);
    expect(token).toBeTruthy();
    expect(notices.some((n) => /challenge detected/i.test(n))).toBe(true);
  } finally {
    await env.close();
  }
});

