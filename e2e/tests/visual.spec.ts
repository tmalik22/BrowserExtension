import { test, expect } from '@playwright/test';
import { script, startEnv } from './harness.ts';

test('visual: side panel conversation screenshot', async () => {
  test.skip(!process.env.VISUAL, 'visual check only');
  const env = await startEnv();
  try {
    const target = await env.context.newPage();
    await target.goto(env.fx.url('shop.html?visual'));
    const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, target.url());
    const panel = await env.context.newPage();
    await panel.setViewportSize({ width: 400, height: 760 });
    await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html?tabId=${tabId}`);
    await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
    await panel.screenshot({ path: 'test-results/visual-panel-empty.png' });
    const s = script([
      () => [{ name: 'find', input: { query: 'add to cart' } }],
      (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Add to cart') } } }, { name: 'screenshot' }],
      () => [{ name: 'find', input: { query: 'place order' } }],
      (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Place order') } } }],
      () => 'Added **Blue Mug** to the cart and placed the order.\n\n- Item: Blue Mug ($12.50)\n- Status: `ORDER PLACED`',
    ]);
    await panel.locator('#input').fill(`Buy the blue mug #script:${s}`);
    await panel.locator('#btn-send').click();
    await expect(panel.locator('.approval')).toBeVisible();
    await panel.screenshot({ path: 'test-results/visual-panel-approval.png' });
    await target.screenshot({ path: 'test-results/visual-page-overlay.png' });
    await panel.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await expect(panel.locator('.msg.assistant ul')).toBeVisible();
    await panel.locator('.tool').nth(1).locator('summary').click();
    await panel.screenshot({ path: 'test-results/visual-panel-done.png' });
  } finally {
    await env.close();
  }
});
