/**
 * End-to-end: the "Ask me before…" switches in the side panel settings decide which actions
 * stop for the user's approval. Real extension + server + fixture store page, scripted model.
 */
import { test, expect, type Page } from '@playwright/test';
import { CONFIRM_CATEGORIES, type AgentEvent } from '@ba/shared';
import { run, script, startEnv, type Env } from './harness.ts';

test.describe.configure({ mode: 'serial' });
let env: Env;
let panel: Page;

test.beforeAll(async () => {
  env = await startEnv({ permissionMode: 'auto' });
  panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
});
test.afterAll(async () => {
  await env?.close();
});

async function openSettings(): Promise<void> {
  await panel.reload();
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  await panel.locator('#btn-settings').click();
  await expect(panel.locator('#view-settings')).toBeVisible();
}

async function save(): Promise<void> {
  await panel.locator('#btn-save-settings').click();
  await expect(panel.locator('#settings-msg')).not.toHaveText('');
}

/** Run "buy the blue mug" on the store page; returns which approval categories were asked. */
async function buyMug(): Promise<string[]> {
  const s = script([
    () => [{ name: 'find', input: { query: 'add to cart' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Add to cart') } } }],
    () => [{ name: 'find', input: { query: 'place order' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Place order') } } }],
    () => 'done',
  ]);
  const asked: string[] = [];
  const r = await run(env, s, {
    startUrl: env.fx.url('demo-store.html'),
    autoApprove: undefined,
    onEvent: (e: AgentEvent) => {
      if (e.type === 'approval_request') {
        asked.push(e.reason);
        setTimeout(() => env.server.resolveApproval(e.approvalId, 'allow_once'), 50);
      }
    },
  });
  expect(r.reason).not.toBe('error');
  return asked;
}

test('every category is listed and switched on by default', async () => {
  await openSettings();
  const boxes = panel.locator('#confirm-list input[type=checkbox]');
  await expect(boxes).toHaveCount(CONFIRM_CATEGORIES.length);
  for (const c of CONFIRM_CATEGORIES) {
    await expect(panel.locator(`#set-confirm-${c.id}`), c.id).toBeChecked();
    await expect(panel.locator('#confirm-list')).toContainText(c.label);
  }
  expect(Object.values(env.server.settings().confirm).every(Boolean)).toBe(true);
});

test('with purchases on, placing an order waits for approval', async () => {
  const asked = await buyMug();
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('Purchases & payments');
});

test('unticking purchases is saved, survives a reload, and the order goes through unasked', async () => {
  await openSettings();
  await panel.locator('#set-confirm-payments').uncheck();
  await save();
  expect(env.server.settings().confirm.payments).toBe(false);
  expect(env.server.settings().confirm.logins).toBe(true);
  await openSettings();
  await expect(panel.locator('#set-confirm-payments')).not.toBeChecked();
  await expect(panel.locator('#set-confirm-logins')).toBeChecked();
  expect(await buyMug()).toEqual([]);
  const store = await env.context.pages().find((p) => p.url().includes('demo-store.html'))!;
  await expect(store.locator('#status')).toHaveText('ORDER PLACED');
});

test('"All off" and "All on" flip every switch', async () => {
  await openSettings();
  await panel.locator('#btn-confirm-none').click();
  await save();
  expect(Object.values(env.server.settings().confirm).some(Boolean)).toBe(false);
  await openSettings();
  for (const c of CONFIRM_CATEGORIES) await expect(panel.locator(`#set-confirm-${c.id}`)).not.toBeChecked();
  await panel.locator('#btn-confirm-all').click();
  await save();
  expect(Object.values(env.server.settings().confirm).every(Boolean)).toBe(true);
  expect(await buyMug()).toHaveLength(1);
});
