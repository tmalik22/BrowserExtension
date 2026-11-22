/**
 * End-to-end: Settings → API keys. Paste a key, see each model's test result, pick a suggested
 * model id, and the model picker unlocks — against a fake OpenAI-compatible provider.
 */
import http from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import { startEnv, type Env } from './harness.ts';

const NAME = 'E2E_PLAN_API_KEY';
const SECRET = 'sk-e2e-plan-key-1234abcd';
let env: Env;
let fake: http.Server;
let fakeUrl = '';

function sse(res: http.ServerResponse) {
  const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of [
    chunk({ role: 'assistant' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{}' } }] }),
    chunk({}, 'tool_calls'),
  ])
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.end('data: [DONE]\n\n');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  delete process.env[NAME];
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    if (/\/models(\?|$)/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'deepseek-v4-1-flash-251101' }, { id: 'deepseek-v4-flash' }] }));
      return;
    }
    const model = JSON.parse(body).model;
    if (model === 'deepseek-v4.1-flash') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `The model ${model} does not exist` } }));
      return;
    }
    sse(res);
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
  env = await startEnv({}, {
    profiles: [{ id: 'plan', label: 'DeepSeek V4.1 Flash (plan)', provider: 'openai', model: 'deepseek-v4.1-flash', baseURL: fakeUrl, apiKeyEnv: NAME, vision: false, toolSet: 'full' }],
  });
});

test.afterAll(async () => {
  await env?.close();
  await new Promise<void>((r) => fake.close(() => r()));
  delete process.env[NAME];
});

let panel: Page;

test('a model without a key is locked and the key is listed as not set', async () => {
  panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
  await expect(panel.locator('#model option[value="plan"]')).toBeDisabled();
  await panel.locator('#btn-settings').click();
  const row = panel.locator(`.key[data-name="${NAME}"]`);
  await expect(row).toContainText('Not set');
  await expect(row).toContainText('Used by: DeepSeek V4.1 Flash (plan)');
});

test('saving a key tests the model and offers the right model id', async () => {
  const row = panel.locator(`.key[data-name="${NAME}"]`);
  await row.locator('input').fill(SECRET);
  await row.getByRole('button', { name: 'Save & test' }).click();
  await expect(row.locator('.key-status')).toHaveText('Saved (…abcd)');
  await expect(row.locator('input')).toHaveValue('');
  await expect(row.locator('.key-test.bad')).toContainText('The key works, but the model "deepseek-v4.1-flash" was not accepted');
  await expect(row.locator('.key-suggest button').first()).toHaveText('deepseek-v4-1-flash-251101');
  if (process.env.KEYS_SHOT) await panel.screenshot({ path: process.env.KEYS_SHOT });
});

test('picking the suggestion retests and unlocks the model', async () => {
  const row = panel.locator(`.key[data-name="${NAME}"]`);
  await row.locator('.key-suggest button').first().click();
  await expect(row.locator('.key-test.ok')).toContainText('Works');
  await expect(panel.locator('#model option[value="plan"]')).toBeEnabled();
  // The key itself is never in the page.
  expect(await panel.content()).not.toContain(SECRET);
});
