/**
 * Regenerates the images used in README.md (docs/screenshots/). Drives the real extension and
 * server with the scripted mock model, so no API keys are needed:
 *
 *   SHOTS=1 npx playwright test -c e2e/playwright.config.ts readme-shots
 *   python scripts/readme-images.py          # composes hero.png, demo.gif, captcha.png
 *
 * Raw page/panel captures go to docs/screenshots/raw/ (gitignored); the panel-*.png files are
 * used directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { fakeServer, openaiSse } from '../../packages/server/test/fake-servers.ts';
import { run, script, startEnv, type Env } from './harness.ts';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/screenshots');
const RAW = path.join(OUT, 'raw');
const LINE = '0, NVIDIA GeForce RTX 4090, 67, N/A, 58, 312.4, 450.00, 94, 19870, 24564, 2520, 0x0000000000000000, P2';
const GPU_SOURCE = `let i=0;setInterval(()=>{i++;const t=60+Math.round(6*Math.sin(i/9))+(i%4);const p=(300+40*Math.sin(i/7)).toFixed(1);console.log(${JSON.stringify(LINE)}.replace(', 67,', ', '+t+',').replace('312.4',p))},120)`;

const PROFILES = [
  { id: 'local-qwen', label: 'Qwen3-VL 32B (Ollama, local)', provider: 'openai' as const, model: 'qwen3-vl:32b', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', vision: true },
  { id: 'cloud', label: 'OpenRouter (cloud)', provider: 'openai' as const, model: 'x', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', vision: true },
];

test.describe.configure({ mode: 'serial' });
let env: Env;
let helperServer: Awaited<ReturnType<typeof fakeServer>> | undefined;

/**
 * Stand-in for the CAPTCHA helper model: an OpenAI-compatible endpoint that reads the page,
 * then ticks the "I am human" box. Goes through the real provider and policy path.
 */
async function startHelperModel() {
  return fakeServer((req) => {
    const msgs = (req.body?.messages ?? []) as { role: string; content: unknown }[];
    const tools = msgs.filter((m) => m.role === 'tool');
    if (!tools.length) return { sse: openaiSse({ calls: [{ id: 'h1', name: 'read_page', args: JSON.stringify({ filter: 'interactive' }) }] }) };
    if (tools.length === 1) {
      const text = String(tools[0].content);
      const ref = text.split('\n').find((l) => l.includes('I am human'))?.match(/ref_\d+/)?.[0] ?? 'ref_1';
      return { sse: openaiSse({ calls: [{ id: 'h2', name: 'left_click', args: JSON.stringify({ target: { type: 'ref', ref } }) }] }) };
    }
    return { sse: openaiSse({ text: 'DONE' }) };
  });
}

test.beforeAll(async () => {
  test.skip(!process.env.SHOTS, 'README screenshots only');
  fs.mkdirSync(RAW, { recursive: true });
  helperServer = await startHelperModel();
  const helper = { id: 'helper', label: 'Gemma 3 12B (local)', provider: 'openai' as const, model: 'gemma3:12b', baseURL: `${helperServer.url}/v1`, apiKey: 'x', vision: true, stream: true };
  env = await startEnv({}, { transcripts: true, profiles: [...PROFILES, helper], gpu: { command: process.execPath, args: ['-e', GPU_SOURCE], intervalMs: 120 } });
});
test.afterAll(async () => {
  await env?.close();
  await helperServer?.close();
});

/** Hide the mock-model plumbing so the shots read like a real session with a local model. */
async function scrub(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue?.includes('#script:')) n.nodeValue = n.nodeValue.replace(/\s*#script:[\w-]+/g, '');
      if (n.nodeValue?.startsWith('Mock ·')) n.nodeValue = n.nodeValue.replace('Mock', 'Qwen3-VL 32B');
      if (n.nodeValue && /localhost:\d+/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/https?:\/\/localhost:\d+\/demo-challenge\.html/g, 'https://kilnandco.example/shop').replace(/https?:\/\/localhost:\d+\//g, 'https://kilnandco.example/');
      if (n.nodeValue?.includes('hcaptcha challenge')) n.nodeValue = n.nodeValue.replace('hcaptcha challenge', 'CAPTCHA challenge');
    }
    const model = document.getElementById('model') as HTMLSelectElement | null;
    if (model && [...model.options].some((o) => o.value === 'local-qwen')) model.value = 'local-qwen';
    const usage = document.getElementById('usage');
    if (usage) usage.textContent = '';
    const url = document.getElementById('set-url') as HTMLInputElement | null;
    if (url) url.value = 'ws://127.0.0.1:7878/ws';
  });
  await panel.waitForTimeout(300);
}

async function openPanel(tabId?: number): Promise<Page> {
  const panel = await env.context.newPage();
  await panel.setViewportSize({ width: 420, height: 820 });
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html${tabId ? `?tabId=${tabId}` : ''}`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  return panel;
}

async function openPage(file: string): Promise<{ target: Page; tabId: number }> {
  const target = await env.context.newPage();
  await target.setViewportSize({ width: 1000, height: 820 });
  await target.goto(env.fx.url(file));
  const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, target.url());
  return { target, tabId: tabId! };
}

/** Save a matching page + panel pair for one stage of a flow. */
async function pair(name: string, target: Page, panel: Page): Promise<void> {
  await scrub(panel);
  await panel.screenshot({ path: path.join(RAW, `${name}-panel.png`) });
  await target.bringToFront();
  await target.screenshot({ path: path.join(RAW, `${name}-page.png`) });
  await panel.bringToFront();
}

test('shopping flow: ask, approve, done', async () => {
  test.skip(!process.env.SHOTS, 'README screenshots only');
  const { target, tabId } = await openPage('demo-store.html');
  const panel = await openPanel(tabId);
  const s = script([
    () => [{ name: 'find', input: { query: 'blue mug add to cart' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Add to cart') } } }, { name: 'screenshot' }],
    () => [{ name: 'find', input: { query: 'place order' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Place order') } } }],
    () => 'Done — the **Blue Mug** is in your cart and the order is placed.\n\n- Item: Blue Mug ($12.50)\n- Status: `ORDER PLACED`',
  ]);
  await panel.locator('#input').fill('Buy the blue mug');
  await pair('flow-1', target, panel);

  await panel.locator('#model').selectOption('mock'); // the scripted demo runs on the mock model
  await panel.locator('#input').fill(`Buy the blue mug #script:${s}`);
  await panel.locator('#btn-send').click();
  await expect(panel.locator('.approval')).toBeVisible();
  await pair('flow-2', target, panel);
  await scrub(panel);
  await panel.screenshot({ path: path.join(OUT, 'panel-approval.png') });

  await panel.locator('.approval').getByRole('button', { name: 'Allow' }).click();
  await expect(panel.locator('.msg.assistant ul')).toBeVisible();
  await panel.locator('.tool').nth(1).locator('summary').click();
  await pair('flow-3', target, panel);
  await scrub(panel);
  await panel.screenshot({ path: path.join(OUT, 'panel-done.png') });
});

test('CAPTCHA helper hand-off', async () => {
  test.skip(!process.env.SHOTS, 'README screenshots only');
  env.server.settingsStore.update({ captchaHelperProfileId: 'helper' });
  const { target, tabId } = await openPage('demo-store.html');
  const panel = await openPanel(tabId);
  const s = script([
    () => [{ name: 'navigate', input: { url: env.fx.url('demo-challenge.html') } }],
    () => "Got past the human check — I'm on the shop now. What would you like me to do next?",
  ]);
  await panel.locator('#btn-new').click(); // fresh chat for this demo
  await panel.locator('#model').selectOption('mock');
  await panel.locator('#input').fill(`Open the Kiln & Co. shop #script:${s}`);
  await panel.locator('#btn-send').click();
  await expect(panel.locator('.msg.assistant').last()).toContainText('human check', { timeout: 30_000 });
  const page = env.context.pages().filter((p) => p.url().includes('demo-challenge.html')).pop() ?? target;
  await expect(page.locator('#status')).toContainText('Verified');
  await pair('captcha', page, panel);
  env.server.settingsStore.update({ captchaHelperProfileId: undefined });
});

test('chat history', async () => {
  test.skip(!process.env.SHOTS, 'README screenshots only');
  const chats: [string, string][] = [
    ['Which of these is the cheapest?', 'The **Terracotta Cup** at $9.00 is the cheapest item on the page.'],
    ['Compare the three products in a table', 'Blue Mug $12.50 (350 ml), Terracotta Cup $9.00 (220 ml), Sage Planter $18.00 (12 cm).'],
    ['Summarize this store in two sentences', 'Kiln & Co. sells small-batch handmade stoneware: mugs, cups and planters, all glazed and fired in their own studio.'],
  ];
  for (const [text, answer] of chats) {
    const name = script([() => answer]);
    await run(env, name, { text: `${text} #script:${name}`, startUrl: env.fx.url('demo-store.html') });
  }
  const panel = await openPanel();
  await panel.locator('#btn-history').click();
  await expect(panel.locator('#chat-list > *').first()).toBeVisible();
  await panel.locator('#chat-search').blur();
  await scrub(panel);
  await panel.screenshot({ path: path.join(OUT, 'panel-history.png'), clip: { x: 0, y: 0, width: 420, height: 560 } });
});

test('settings and GPU monitor', async () => {
  test.skip(!process.env.SHOTS, 'README screenshots only');
  const panel = await openPanel();
  await expect(panel.locator('#gpu')).toBeVisible();
  await panel.waitForTimeout(6000); // let the sparkline and charts fill in
  await panel.locator('#gpu-toggle').click();
  await expect(panel.locator('#gpu-chart-temp .chart-line')).toHaveCount(1);
  await scrub(panel);
  await panel.screenshot({ path: path.join(OUT, 'panel-gpu.png'), clip: { x: 0, y: 0, width: 420, height: 480 } });
  await panel.locator('#gpu-toggle').click();
  await panel.locator('#btn-settings').click();
  await expect(panel.locator('#view-settings')).toBeVisible();
  await panel.setViewportSize({ width: 420, height: 1600 });
  await panel.locator('#set-confirm-forms').uncheck(); // show that switches can be turned off
  await panel.locator('#set-confirm-messages').uncheck();
  await scrub(panel);
  await panel.locator('#view-settings section', { hasText: 'Ask me before' }).screenshot({ path: path.join(OUT, 'panel-settings.png') });
  // The CAPTCHA helper picker, with a model selected.
  await panel.evaluate(() => {
    const sel = document.getElementById('set-captcha-helper') as HTMLSelectElement;
    sel.append(new Option('Gemma 3 12B (Ollama, local)', 'shot'));
    sel.value = 'shot';
  });
  await panel.locator('#view-settings section', { hasText: 'CAPTCHA helper' }).screenshot({ path: path.join(OUT, 'panel-captcha-setting.png') });
});
