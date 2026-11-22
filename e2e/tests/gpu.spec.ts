/**
 * End-to-end: the GPU strip in the side panel, its alerts, details charts and desktop
 * notifications, fed by a fake nvidia-smi whose temperature the test controls.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { startEnv, until, type Env } from './harness.ts';

let env: Env;
const tempFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ba-gpu-')), 'temp.txt');
const LINE = '0, NVIDIA GeForce RTX 3090, @@, N/A, 64, 352.5, 370.00, 97, 23650, 24576, 1800, 0x0000000000000004, P2';
const SOURCE = `const fs=require('fs');const f=process.argv[1];setInterval(()=>{let t='61';try{t=fs.readFileSync(f,'utf8').trim()||t}catch{}console.log(${JSON.stringify(LINE)}.replace('@@',t))},150)`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.writeFileSync(tempFile, '61');
  env = await startEnv({}, { gpu: { command: process.execPath, args: ['-e', SOURCE, tempFile], intervalMs: 150 } });
});
test.afterAll(async () => {
  await env?.close();
});

let panel: Page;

test('the side panel shows live GPU readings', async () => {
  panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
  await expect(panel.locator('#gpu')).toBeVisible();
  await expect(panel.locator('#gpu-summary')).toHaveText('GPU 61°C · fan 64% · 353 W · 23.1/24.0 GB · load 97%');
  await expect(panel.locator('#gpu')).toHaveAttribute('data-level', 'ok');
  await expect(panel.locator('#gpu-spark path')).toHaveCount(1);
  await expect(panel.locator('.gpu-alert')).toHaveCount(0);
});

test('details open with stats and both charts, with a hover tooltip', async () => {
  await panel.locator('#gpu-toggle').click();
  await expect(panel.locator('#gpu-details')).toBeVisible();
  await expect(panel.locator('#gpu-stats')).toContainText('RTX 3090');
  await expect(panel.locator('#gpu-stats')).toContainText('353 W of 370 W limit');
  await expect(panel.locator('#gpu-stats')).toContainText('at its power limit (normal under full load)');
  await expect(panel.locator('#gpu-chart-temp .chart-line')).toHaveCount(1);
  await expect(panel.locator('#gpu-chart-power .chart-line')).toHaveCount(1);
  const box = (await panel.locator('#gpu-chart-temp svg').boundingBox())!;
  await panel.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(panel.locator('#gpu-chart-temp .chart-tip')).toContainText('61°C at');
});

test('overheating raises an alert in the panel and a desktop notification, then clears', async () => {
  fs.writeFileSync(tempFile, '90');
  await expect(panel.locator('.gpu-alert.critical')).toContainText('GPU is very hot (90°C)');
  await expect(panel.locator('#gpu')).toHaveAttribute('data-level', 'critical');
  await until(async () => await env.sw.evaluate(() => (globalThis as any).__ba.notified.has('temp')), 5000, 'notification');
  if (process.env.GPU_SHOT) await panel.screenshot({ path: process.env.GPU_SHOT });
  fs.writeFileSync(tempFile, '60');
  await expect(panel.locator('.gpu-alert')).toHaveCount(0, { timeout: 10_000 });
  await expect(panel.locator('#gpu')).toHaveAttribute('data-level', 'ok');
  await until(async () => !(await env.sw.evaluate(() => (globalThis as any).__ba.notified.has('temp'))), 5000, 'notification cleared');
  await panel.close();
});

test('a reopened panel gets the current readings immediately', async () => {
  const p = await env.context.newPage();
  await p.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
  await expect(p.locator('#gpu-summary')).toContainText('GPU 60°C');
  await p.close();
});
