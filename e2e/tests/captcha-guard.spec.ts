/**
 * End-to-end: guards on the CAPTCHA helper's direct-click path ("kraken" protocol), which acts
 * without the per-action policy. It must only act inside a located challenge widget, and never
 * on a page the URL policy forbids. No external CAPTCHA service is used.
 */
import { test, expect } from '@playwright/test';
import { startEnv, until, type Env } from './harness.ts';

test.describe.configure({ mode: 'serial' });
let env: Env;

test.beforeAll(async () => {
  env = await startEnv({ permissionMode: 'auto' });
});
test.afterAll(async () => {
  await env?.close();
});

const OPEN = { allowPrivateNetworks: true, blockedSites: [] as string[] };

async function openSession(path: string): Promise<string> {
  const { sessionId } = env.server.startOrContinue({ text: 'look', profileId: 'mock', startUrl: env.fx.url(path), autoApprove: 'allow_once' });
  await env.server.getSession(sessionId)!.settled();
  await until(() => env.context.pages().some((p) => p.url().includes(path)), 15_000, path);
  await new Promise((r) => setTimeout(r, 500));
  return sessionId;
}

const rpc = (method: string, params: Record<string, unknown>) =>
  env.sw.evaluate(async ([m, p]) => {
    try {
      return { ok: true, value: await (globalThis as any).__ba.onRpc(m, p) };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }, [method, params] as const);

const clickCenter = { action: 'click', points: [[500, 500]] };

test('refuses to click when the "challenge" is only a page title', async () => {
  const sessionId = await openSession('fake-challenge.html');
  const probe = await rpc('captcha_probe', { sessionId });
  expect(probe.value.challenge).toBe(true); // the title alone looks like a challenge…
  const obs = await rpc('captcha_observe', { sessionId });
  expect(obs.ok).toBe(true);
  expect(obs.value.located).toBe(false); // …but there is no widget to confine clicks to
  const act = await rpc('captcha_action', { sessionId, plan: clickCenter, settings: OPEN });
  expect(act.ok).toBe(false);
  expect(act.error).toMatch(/could not be located/);
  const page = env.context.pages().find((p) => p.url().includes('fake-challenge.html'))!;
  await expect(page.locator('#buy')).toHaveText('Buy everything');
});

test('clicks only inside a located widget', async () => {
  const sessionId = await openSession('local-challenge.html');
  const obs = await rpc('captcha_observe', { sessionId });
  expect(obs.value.located).toBe(true);
  const act = await rpc('captcha_action', { sessionId, plan: clickCenter, settings: OPEN });
  expect(act.ok, act.error).toBe(true);
  const page = env.context.pages().find((p) => p.url().includes('local-challenge.html'))!;
  await expect(page.frameLocator('#widget').locator('#box')).toHaveText('VERIFIED');
  await expect(page.locator('#outside')).toHaveText('Outside button');
});

test('refuses on a page the URL policy forbids, and without a policy', async () => {
  const sessionId = await openSession('local-challenge.html');
  await rpc('captcha_observe', { sessionId });
  const blocked = await rpc('captcha_action', { sessionId, plan: clickCenter, settings: { allowPrivateNetworks: false, blockedSites: [] } });
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toMatch(/not allowed/);
  await rpc('captcha_observe', { sessionId });
  const none = await rpc('captcha_action', { sessionId, plan: clickCenter });
  expect(none.ok).toBe(false);
  expect(none.error).toMatch(/no URL policy/);
  const page = env.context.pages().filter((p) => p.url().includes('local-challenge.html')).pop()!; // this test's tab
  await expect(page.frameLocator('#widget').locator('#box')).toHaveText('I am human');
});

test('a same-site frame that merely has "recaptcha" in its URL is not a challenge widget', async () => {
  const sessionId = await openSession('lookalike-challenge.html');
  const obs = await rpc('captcha_observe', { sessionId });
  expect(obs.value.located).toBe(false);
  const act = await rpc('captcha_action', { sessionId, plan: clickCenter, settings: OPEN });
  expect(act.ok).toBe(false);
  expect(act.error).toMatch(/could not be located/);
});

test('refuses to click when the page lays something over the widget', async () => {
  const sessionId = await openSession('overlay-challenge.html');
  const obs = await rpc('captcha_observe', { sessionId });
  expect(obs.value.located).toBe(true);
  const act = await rpc('captcha_action', { sessionId, plan: clickCenter, settings: OPEN });
  expect(act.ok).toBe(false);
  expect(act.error).toMatch(/not on the challenge widget/);
  const page = env.context.pages().filter((p) => p.url().includes('overlay-challenge.html')).pop()!;
  await expect(page.locator('#trap')).toHaveText('Buy now');
});
