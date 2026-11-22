/**
 * End-to-end: the searchable model picker in the side panel (live model lists can be hundreds
 * long, so the composer uses a picker that drives the hidden <select id="model">).
 */
import { test, expect, type Page } from '@playwright/test';
import { startEnv, type Env } from './harness.ts';

test.describe.configure({ mode: 'serial' });
let env: Env;
let panel: Page;

const many = Array.from({ length: 60 }, (_, i) => ({
  id: `nim/vendor/model-${i}`,
  label: `vendor/model-${i}`,
  provider: 'openai' as const,
  model: `vendor/model-${i}`,
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'x',
  vision: i % 3 === 0,
  group: 'NVIDIA NIM',
  catalog: 'nvidia',
}));

test.beforeAll(async () => {
  env = await startEnv({}, {
    profiles: [
      { id: 'local-qwen', label: 'qwen3-vl:8b (Ollama)', provider: 'openai', model: 'qwen3-vl:8b', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', vision: true, detected: true },
      { id: 'needs-key', label: 'Locked model', provider: 'openai', model: 'locked', baseURL: 'https://api.example/v1', apiKeyEnv: 'E2E_PICKER_MISSING_KEY', vision: false },
      ...many,
    ] as any,
  });
  panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
});
test.afterAll(async () => {
  await env?.close();
});

test('opens with groups, badges and a ready count', async () => {
  await panel.locator('#model-btn').click();
  const menu = panel.locator('#model-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.model-group').first()).toContainText('Local');
  await expect(menu).toContainText('NVIDIA NIM · 60');
  await expect(menu.locator('.model-item', { hasText: 'qwen3-vl:8b' }).locator('.badge.local')).toBeVisible();
  await expect(menu.locator('.model-item.disabled', { hasText: 'Locked model' }).locator('.badge.warn')).toHaveText('needs key');
  await expect(menu.locator('.model-foot')).toContainText('models ready');
});

test('search filters across all groups and a click picks the model', async () => {
  const menu = panel.locator('#model-menu');
  await panel.locator('.model-search').fill('model-42');
  await expect(menu.locator('.model-item')).toHaveCount(1);
  await menu.locator('.model-item', { hasText: 'model-42' }).click();
  await expect(menu).toBeHidden();
  await expect(panel.locator('#model')).toHaveValue('nim/vendor/model-42');
  await expect(panel.locator('#model-btn')).toContainText('vendor/model-42');
  await expect(panel.locator('#model-btn')).toContainText('NVIDIA NIM');
});

test('keyboard: type, arrow down, Enter; Escape closes', async () => {
  await panel.locator('#model-btn').click();
  await panel.locator('.model-search').fill('qwen');
  await panel.locator('.model-search').press('ArrowDown');
  await panel.locator('.model-search').press('Enter');
  await expect(panel.locator('#model')).toHaveValue('local-qwen');
  await panel.locator('#model-btn').click();
  await panel.locator('.model-search').press('Escape');
  await expect(panel.locator('#model-menu')).toBeHidden();
});

test('recently used models are listed first; locked models cannot be picked', async () => {
  await panel.locator('#model-btn').click();
  const menu = panel.locator('#model-menu');
  await expect(menu.locator('.model-group').first()).toHaveText('Recent');
  const recent = await menu.locator('.model-item').evaluateAll((els) => els.slice(0, 2).map((e) => (e as HTMLElement).dataset.id));
  expect(recent).toEqual(['local-qwen', 'nim/vendor/model-42']);
  await menu.locator('.model-item.disabled', { hasText: 'Locked model' }).click({ force: true });
  await expect(panel.locator('#model')).toHaveValue('local-qwen');
  await panel.locator('.model-search').press('Escape');
});

test('no matches shows a hint', async () => {
  await panel.locator('#model-btn').click();
  await panel.locator('.model-search').fill('zzzz-nothing');
  await expect(panel.locator('.model-empty')).toContainText('No models match');
  await panel.locator('.model-search').press('Escape');
});
