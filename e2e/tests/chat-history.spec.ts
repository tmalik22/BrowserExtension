/**
 * End-to-end: chat history in the side panel. Past chats appear on the start screen and in the
 * History view, can be reopened, and still show (and can be carried on) after the server forgets
 * them, e.g. after a restart.
 */
import { test, expect, type Page } from '@playwright/test';
import { startEnv, type Env } from './harness.ts';

let env: Env;
let panel: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  env = await startEnv({}, { transcripts: true });
  const target = await env.context.newPage();
  await target.goto(env.fx.url('shop.html?history-test'));
  const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, target.url());
  panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html?tabId=${tabId}`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
});

test.afterAll(async () => {
  await env?.close();
});

const shot = async (name: string) => {
  if (process.env.HISTORY_SHOTS) await panel.screenshot({ path: `${process.env.HISTORY_SHOTS}/${name}.png` });
};

test('a finished chat shows under Recent chats on the start screen', async () => {
  await panel.locator('#input').fill('Look up the Grimes rows');
  await panel.locator('#btn-send').click();
  await expect(panel.locator('.msg.assistant')).toContainText('You said:');
  await panel.locator('#btn-new').click();
  await expect(panel.locator('.empty')).toBeVisible();
  const recent = panel.locator('.recent .chat');
  await expect(recent).toHaveCount(1);
  await expect(recent.first()).toContainText('Look up the Grimes rows');
  await shot('1-start-screen');
  await recent.first().click();
  await expect(panel.locator('.msg.user')).toHaveText('Look up the Grimes rows');
  await expect(panel.locator('#archived-note')).toBeHidden();
});

test('the History view lists, searches and opens chats', async () => {
  await panel.locator('#btn-new').click();
  await panel.locator('#input').fill('Check the Waller sheet');
  await panel.locator('#btn-send').click();
  await expect(panel.locator('.msg.assistant')).toContainText('Check the Waller sheet');

  await panel.locator('#btn-history').click();
  const rows = panel.locator('#chat-list .chat');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Check the Waller sheet');
  await expect(rows.first()).toHaveClass(/current/);
  await expect(rows.nth(1)).toContainText('You said:');
  await shot('2-history');

  await panel.locator('#chat-search').fill('grimes');
  await expect(panel.locator('#chat-list .chat:not(.hidden)')).toHaveCount(1);
  await panel.locator('#chat-search').fill('nothing like this');
  await expect(panel.locator('#chat-list-msg')).toHaveText('No chats match.');
  await panel.locator('#chat-search').fill('');

  await rows.nth(1).click();
  await expect(panel.locator('#view-chat')).toBeVisible();
  await expect(panel.locator('.msg.user')).toHaveText('Look up the Grimes rows');
});

test('after a restart the chat is still there and can be carried on', async () => {
  // What a server restart does to chats: they're no longer in memory.
  (env.server as any).sessions.clear();
  await panel.reload();
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  await expect(panel.locator('.msg.user')).toHaveText('Look up the Grimes rows');
  await expect(panel.locator('#archived-note')).toBeVisible();
  await shot('3-after-restart');

  await panel.locator('#input').fill('keep going from row 22');
  await panel.locator('#btn-send').click();
  await expect(panel.locator('#archived-note')).toBeHidden();
  await expect(panel.locator('.msg.user')).toHaveText(['Look up the Grimes rows', 'keep going from row 22']);
  // The (echo) model was given the earlier conversation before the new message.
  const reply = panel.locator('.msg.assistant').last();
  await expect(reply).toContainText('carries on from an earlier conversation');
  await expect(reply).toContainText('User: Look up the Grimes rows');

  await panel.locator('#btn-history').click();
  const rows = panel.locator('#chat-list .chat');
  await expect(rows).toHaveCount(2);
  // The carried-on chat keeps its original title and is folded into one entry.
  await expect(rows.first()).toContainText('Look up the Grimes rows');
  await expect(rows.first()).toHaveClass(/current/);
});
