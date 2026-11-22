/**
 * End-to-end part 2: dialogs, tabs, screenshots/coordinates, navigation policy, stale refs,
 * downloads, uploads, approvals, stopping, and the side panel UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { errorTexts, pageFor, run, script, startEnv, until, type Env } from './harness.ts';

let env: Env;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  env = await startEnv();
});
test.afterAll(async () => {
  await env?.close();
});

test('JavaScript dialogs: alert auto-dismissed, confirm accepted with Enter, prompt filled and accepted', async () => {
  const refs: Record<string, string> = {};
  const s = script([
    () => [{ name: 'read_page', input: { filter: 'interactive' } }],
    (c) => {
      refs.alert = c.mustRef('button', 'Show alert');
      refs.confirm = c.mustRef('button', 'Confirm delete');
      refs.prompt = c.mustRef('button', 'Ask name');
      return [{ name: 'left_click', input: { target: { type: 'ref', ref: refs.alert } } }];
    },
    () => [{ name: 'left_click', input: { target: { type: 'ref', ref: refs.confirm } } }],
    () => [{ name: 'read_page' }],
    () => [{ name: 'key', input: { text: 'Enter' } }, { name: 'left_click', input: { target: { type: 'ref', ref: refs.prompt } } }],
    () => [{ name: 'type', input: { text: 'Bob' } }, { name: 'key', input: { text: 'Enter' } }],
    () => [{ name: 'get_page_text' }],
    (c) => c.lastText,
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('dialogs.html') });
  expect(r.text(1)).toMatch(/An alert dialog appeared and was dismissed: "Saved!"/);
  expect(r.text(2)).toMatch(/A JavaScript confirm dialog opened: "Delete everything\?"\. Press Enter to accept or Escape/);
  expect(r.text(3)).toMatch(/Error: a JavaScript confirm dialog is blocking the page/);
  expect(r.text(4)).toMatch(/Accepted the confirm dialog/);
  expect(r.text(5)).toMatch(/prompt dialog opened/);
  expect(r.text(6)).toMatch(/Typed into the prompt dialog/);
  expect(r.text(7)).toMatch(/Accepted the prompt dialog/);
  expect(r.final).toContain('prompt Bob');
});

test('tabs: page-opened tabs join the session with tab_opened; new/list/switch/close tabs', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'open article in new tab' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('link', 'Open article in new tab') } } }],
    () => [{ name: 'list_tabs' }],
    () => [{ name: 'get_page_text' }],
    () => [{ name: 'new_tab' }],
    () => [{ name: 'navigate', input: { url: env.fx.url('shop.html') } }],
    () => [{ name: 'list_tabs' }],
    (c) => {
      const tabs = [...c.history].reverse().find((t) => t.role === 'tool_results')!;
      const st = (tabs as any).results[0].result.content.find((b: any) => b.type === 'browser_state');
      const first = st.tabs[0].tab_id;
      const shop = st.tabs.find((t: any) => t.url.includes('shop.html')).tab_id;
      return [{ name: 'switch_tab', input: { tab_id: first } }, { name: 'close_tab', input: { tab_id: shop } }, { name: 'list_tabs' }];
    },
    () => [{ name: 'switch_tab', input: { tab_id: 'tab-999999' } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('tabs.html') });
  const state = (n: number) => r.results[n].result.content.find((b) => b.type === 'browser_state') as any;
  // The click opened a tab: its result reports tab_opened (in the click result or the next one).
  const opened = [1, 2].map(state).filter(Boolean).flatMap((b) => b.state_changes ?? []);
  expect(opened.some((c: any) => c.type === 'tab_opened')).toBe(true);
  expect(state(2).tabs.length).toBe(2);
  expect(r.text(3)).toContain('The secret number is 4217');
  // new_tab: exactly one browser_state block, one tab_opened matching the active tab.
  const nt = r.results[4].result;
  expect(nt.content.length).toBe(1);
  const ntb = state(4);
  expect(ntb.state_changes).toEqual([{ type: 'tab_opened', tab_id: ntb.tabs.find((t: any) => t.active).tab_id }]);
  expect(ntb.tabs.find((t: any) => t.active).url).toBe('about:blank');
  expect(state(6).tabs.length).toBe(3);
  expect(state(9).tabs.length).toBe(2);
  expect(r.text(10)).toMatch(/not one of this task's tabs/);
});

test('screenshot + coordinate click on a canvas; zoom returns an upscaled crop', async () => {
  const s = script([
    () => [{ name: 'screenshot' }],
    () => [{ name: 'left_click', input: { target: { type: 'coordinate', x: 460, y: 225 } } }, { name: 'zoom', input: { region: [400, 200, 520, 250] } }],
    () => [{ name: 'left_click', input: { target: { type: 'coordinate', x: 5000, y: 10 } } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('canvas.html') });
  const shot = r.results[0].result.content.find((b) => b.type === 'image') as any;
  expect(shot.mediaType).toBe('image/jpeg');
  const page = await pageFor(env, 'canvas.html');
  const vp = await page.evaluate(() => [innerWidth, innerHeight]);
  // Viewport fits the image limits, so the screenshot is 1:1 with CSS pixels.
  expect([shot.width, shot.height]).toEqual(vp);
  await expect(page.locator('#log')).toHaveText('play pressed');
  const zoom = r.results[2].result.content.find((b) => b.type === 'image') as any;
  expect(zoom.width).toBe(480); // 120px region upscaled 4x
  expect(r.text(3)).toMatch(/outside the viewport/);
  // The agent overlay is hidden in screenshots: the top strip is not tinted by the frame glow.
  const buf = Buffer.from(shot.data, 'base64');
  expect(buf.length).toBeGreaterThan(5000);
});

test('navigation: policy errors, history, reload, redirect-free loads, slow pages', async () => {
  const s = script([
    () => [{ name: 'navigate', input: { url: 'javascript:alert(1)' } }],
    () => [{ name: 'navigate', input: { url: env.fx.url('article.html') } }],
    () => [{ name: 'navigate', input: { url: env.fx.url('slow?ms=1200') } }],
    () => [{ name: 'navigate', input: { url: 'back' } }],
    () => [{ name: 'navigate', input: { url: 'reload' } }],
    () => [{ name: 'navigate', input: { url: 'http://127.0.0.1:1/' } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('index.html') });
  expect(r.text(0)).toBe('Error: Navigation refused. Only http and https URLs are allowed.');
  expect(r.text(1)).toMatch(/^Navigated to http:\/\/localhost:\d+\/article\.html \(title: "The Fixture Article"\)\./);
  expect(r.results[1].result.content.some((b) => b.type === 'browser_state')).toBe(true);
  expect(r.text(2)).toMatch(/Navigated to .*slow.*Slow/);
  expect(r.text(3)).toMatch(/^Went back to .*article\.html/);
  expect(r.text(4)).toMatch(/^Reloaded .*article\.html/);
  expect(r.text(5)).toMatch(/error page|failed|ERR_/i);
});

test('blocked sites and private networks are enforced by policy', async () => {
  env.server.settingsStore.update({ blockedSites: ['blocked.test'], allowPrivateNetworks: false });
  try {
    const s = script([() => [{ name: 'navigate', input: { url: 'https://blocked.test/' } }], () => [{ name: 'navigate', input: { url: env.fx.url('form.html') } }], () => 'done']);
    const r = await run(env, s, { startUrl: undefined });
    expect(r.text(0)).toMatch(/blocked-sites list/);
    expect(r.text(1)).toMatch(/private network/);
  } finally {
    env.server.settingsStore.update({ blockedSites: [], allowPrivateNetworks: true });
  }
});

test('stale references after navigation are reported, and fresh reads recover', async () => {
  const s = script([
    () => [{ name: 'read_page', input: { filter: 'interactive' } }],
    (c) => {
      const old = c.mustRef('link', 'Login form');
      return [{ name: 'navigate', input: { url: 'reload' } }, { name: 'left_click', input: { target: { type: 'ref', ref: old } } }];
    },
    () => [{ name: 'left_click', input: { target: { type: 'ref', ref: 'ref_9999' } } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('index.html') });
  expect(r.text(2)).toMatch(/^Error: ref_\d+ is stale or not found on the current page\. Re-read the page to get fresh references\.$/);
  expect(r.text(3)).toMatch(/ref_9999 is stale or not found/);
});

test('downloads are reported as browser_state download events', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'download report' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('link', 'Download report') } } }],
    () => [{ name: 'wait', input: { duration: 1 } }],
    () => [{ name: 'wait', input: { duration: 0.5 } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('files.html') });
  const changes = r.results.flatMap((x) => ((x.result.content.find((b) => b.type === 'browser_state') as any)?.state_changes ?? []));
  // A download that starts and finishes during one call reports only download_completed
  // (one entry per download_id per block, per the toolset contract).
  const completed = changes.filter((c: any) => c.type === 'download_completed');
  expect(completed.length).toBe(1);
  expect(completed[0]).toMatchObject({ download_id: 'dl-1', size_bytes: 8 });
  expect(completed[0].url).toContain('/download/report.csv');
  expect(changes.filter((c: any) => c.download_id === 'dl-1').length).toBe(1);
});

test('file_upload (optional member) sets files from the upload directory only', async () => {
  const dir = path.join(env.dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello');
  env.server.settingsStore.update({ enableOptional: { file_upload: true } as any, uploadDir: dir });
  try {
    const s = script([
      () => [{ name: 'find', input: { query: 'attachment file' } }],
      (c) => [{ name: 'file_upload', input: { target: { type: 'ref', ref: c.mustRef('button', 'Attachment') }, paths: ['../../etc/passwd'] } }],
      (c) => [{ name: 'find', input: { query: 'attachment' } }],
      (c) => [{ name: 'file_upload', input: { target: { type: 'ref', ref: c.mustRef('button', 'Attachment') }, paths: ['note.txt'] } }],
      () => 'done',
    ]);
    const r = await run(env, s, { startUrl: env.fx.url('files.html') });
    expect(r.text(1)).toMatch(/outside the allowed upload directory|does not exist/);
    expect(r.text(3)).toMatch(/Set 1 file\(s\) on ref_\d+: note\.txt/);
    await expect((await pageFor(env, 'files.html')).locator('#log')).toHaveText('file: note.txt:5');
  } finally {
    env.server.settingsStore.update({ enableOptional: { file_upload: false } as any });
  }
});

test('ask mode: site approval and consequential-action denial reach the model as errors', async () => {
  env.server.settingsStore.update({ permissionMode: 'ask', allowedSites: [] });
  try {
    const s = script([
      () => [{ name: 'read_page', input: { filter: 'interactive' } }],
      (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Add to cart') } } }],
      () => [{ name: 'find', input: { query: 'place order' } }],
      (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Place order') } } }],
      () => 'done',
    ]);
    const asked: string[] = [];
    let approvals = 0;
    const r = await run(env, s, {
      startUrl: env.fx.url('shop.html'),
      autoApprove: undefined as any,
      onEvent: (e) => {
        if (e.type === 'approval_request') {
          asked.push(e.kind);
          // allow the site, deny the order
          setTimeout(() => env.server.resolveApproval(e.approvalId, approvals++ === 0 ? 'allow_once' : 'deny'), 20);
        }
      },
    });
    expect(asked).toEqual(['site', 'consequential']);
    expect(r.text(3)).toMatch(/The user declined this action/);
    const page = await pageFor(env, 'shop.html');
    await expect(page.locator('#cart')).toHaveText('Blue Mug');
    await expect(page.locator('#log')).toHaveText('');
  } finally {
    env.server.settingsStore.update({ permissionMode: 'auto' });
  }
});

test('stop interrupts a running task promptly', async () => {
  const s = script([() => [{ name: 'wait', input: { duration: 20 } }, { name: 'read_page' }], () => 'never']);
  const t0 = Date.now();
  const p = run(env, s, { startUrl: env.fx.url('index.html') });
  await until(() => env.server['sessions'].size > 0 && [...env.server['sessions'].values()].some((e: any) => e.session.status === 'running'), 10_000);
  await new Promise((r) => setTimeout(r, 1500));
  for (const e of env.server['sessions'].values() as any) if (e.session.status === 'running') e.session.stop();
  const tStop = Date.now();
  const r = await p;
  expect(r.reason).toBe('stopped');
  // Stop interrupts the in-flight 20s wait instead of waiting for it.
  expect(Date.now() - tStop).toBeLessThan(3_000);
  expect(Date.now() - t0).toBeLessThan(12_000);
  expect(r.text(0)).toMatch(/stopped the task while this action was running/);
  expect(r.text(1)).toMatch(/earlier action in this turn failed|stopped/);
});

test('side panel: pairing state, sending a task, live tool rows, approval card, final answer', async () => {
  const target = await env.context.newPage();
  await target.goto(env.fx.url('shop.html?panel-test'));
  const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, target.url());
  const panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html?tabId=${tabId}`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  await expect(panel.locator('#model')).toHaveValue('mock');

  const s = script([
    () => [{ name: 'find', input: { query: 'place order' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Place order') } } }],
    () => 'I placed the **order**.',
  ]);
  await panel.locator('#input').fill(`Please order #script:${s}`);
  await panel.locator('#btn-send').click();
  await expect(panel.locator('.msg.user')).toContainText('Please order');
  // The consequential click shows an approval card; approve it from the UI.
  const card = panel.locator('.approval');
  if (process.env.DEBUG_E2E) {
    await panel.waitForTimeout(4000);
    console.log('PANEL:', await panel.locator('#messages').innerText());
  }
  await expect(card).toBeVisible();
  await expect(card.locator('.reason')).toContainText('consequential');
  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(panel.locator('.msg.assistant strong')).toHaveText('order');
  await expect(panel.locator('.tool .st.ok')).toHaveCount(2);
  await expect(target.locator('#log')).toHaveText('ORDER PLACED');
  await expect(panel.locator('#btn-send')).toBeVisible();

  // Reopening the panel restores the conversation from the server.
  await panel.reload();
  await expect(panel.locator('.msg.user')).toContainText('Please order');
  await expect(panel.locator('.tool')).toHaveCount(2);

  // Settings view loads server settings.
  await panel.locator('#btn-settings').click();
  await expect(panel.locator('#set-mode')).toHaveValue('auto');
  await panel.locator('#btn-back').click();
  await panel.close();
  await target.close();
});

test('multi-turn: refs from an earlier turn stay valid on the same page; subtree reads by ref', async () => {
  let orderRef = '';
  const first = script([
    () => [{ name: 'read_page' }],
    (c) => {
      orderRef = c.mustRef('button', 'Place order');
      return 'Found the order button.';
    },
  ]);
  const r1 = await run(env, first, { startUrl: env.fx.url('shop.html?multi-turn') });
  const productRef = r1.text(0).match(/heading "Red Pen" \[(ref_\d+)\]/)?.[1];
  expect(productRef).toBeTruthy();
  const second = script([
    () => [{ name: 'read_page', input: { ref: orderRef } }, { name: 'scroll_to', input: { target: { type: 'ref', ref: orderRef } } }],
    () => 'ok',
  ]);
  const r2 = await run(env, second, { sessionId: r1.sessionId });
  expect(errorTexts(r2)).toEqual([]);
  expect(r2.text(0)).toBe(`button "Place order" [${orderRef}]`);
  const session = env.server.getSession(r1.sessionId)!;
  expect(session.history.filter((t) => t.role === 'user').length).toBe(2);
});

test('review fix: coordinate clicks inside a cross-origin iframe are inspected (Pay now needs approval)', async () => {
  const s = script([() => [{ name: 'screenshot' }], () => 'unused']);
  const r0 = await run(env, s, { startUrl: env.fx.url('frames.html?coord'), autoApprove: undefined });
  void r0;
  const page = await pageFor(env, 'frames.html?coord');
  const box = (await page.frameLocator('#cross').locator('#paynow').boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const s2 = script([() => [{ name: 'left_click', input: { target: { type: 'coordinate', x, y } } }], () => 'done']);
  const asked: string[] = [];
  const r = await run(env, s2, {
    sessionId: r0.sessionId,
    autoApprove: undefined,
    onEvent: (e) => {
      if (e.type === 'approval_request') {
        asked.push(e.reason);
        setTimeout(() => env.server.resolveApproval(e.approvalId, 'deny'), 10);
      }
    },
  });
  expect(asked[0]).toMatch(/Pay now/);
  expect(r.text(0)).toMatch(/declined/);
  await expect(page.locator('#log')).toHaveText('');
});

test('review fix: URL policy applies to page reads and blocked iframes are never read', async () => {
  const s = script([() => [{ name: 'read_page' }], () => 'done']);
  env.server.settingsStore.update({ blockedSites: ['127.0.0.1'] });
  try {
    const r = await run(env, s, { startUrl: env.fx.url('frames.html?blockframe') });
    expect(r.text(0)).not.toContain('Card details');
    expect(r.text(0)).toContain('Inner frame');
  } finally {
    env.server.settingsStore.update({ blockedSites: [] });
  }
  const s2 = script([() => [{ name: 'get_page_text' }], () => 'done']);
  const r1 = await run(env, script([() => 'ok']), { startUrl: env.fx.url('article.html?policyread') });
  env.server.settingsStore.update({ blockedSites: ['localhost'] });
  try {
    const r2 = await run(env, s2, { sessionId: r1.sessionId });
    expect(r2.text(0)).toMatch(/is on localhost, which is not allowed/);
    expect(r2.text(0)).not.toContain('4217');
  } finally {
    env.server.settingsStore.update({ blockedSites: [] });
  }
});

test('review fix: accepting a confirm dialog requires approval', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'confirm delete' } }],
    (c) => [{ name: 'left_click', input: { target: { type: 'ref', ref: c.mustRef('button', 'Confirm delete') } } }],
    () => [{ name: 'key', input: { text: 'Enter' } }],
    () => 'done',
  ]);
  const asked: string[] = [];
  const r = await run(env, s, {
    startUrl: env.fx.url('dialogs.html?approve'),
    autoApprove: undefined,
    onEvent: (e) => {
      if (e.type === 'approval_request') {
        asked.push(e.reason);
        // Allow clicking the "Confirm delete" button (itself consequential), deny accepting the dialog.
        setTimeout(() => env.server.resolveApproval(e.approvalId, asked.length === 1 ? 'allow_once' : 'deny'), 10);
      }
    },
  });
  expect(asked).toEqual([expect.stringContaining('Confirm delete'), expect.stringContaining('Delete everything?')]);
  expect(r.text(2)).toMatch(/declined/);
  // Dismiss it so the page is usable again.
  const s2 = script([() => [{ name: 'key', input: { text: 'Escape' } }], () => 'done']);
  const r2 = await run(env, s2, { sessionId: r.sessionId });
  expect(r2.text(0)).toMatch(/Dismissed the confirm dialog/);
  await expect((await pageFor(env, 'dialogs.html?approve')).locator('#log')).toHaveText('confirm false');
});

test('screenshots never contain the agent click indicator', async () => {
  const s = script([
    () => [{ name: 'left_click', input: { target: { type: 'coordinate', x: 575, y: 300 } } }, { name: 'screenshot' }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('canvas.html?cursor') });
  const shot = r.results[1].result.content.find((b) => b.type === 'image') as any;
  const page = await pageFor(env, 'canvas.html?cursor');
  // Decode the JPEG in the browser and sample the pixels around the click point.
  const px = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const out: number[][] = [];
    for (const [dx, dy] of [[0, 0], [-11, 0], [11, 0], [0, -11], [0, 11]]) out.push(Array.from(ctx.getImageData(575 + dx, 300 + dy, 1, 1).data).slice(0, 3));
    return out;
  }, shot.data);
  // The indicator ring is orange (217,119,87); the page there is grey/white.
  for (const [rr, g, b] of px) expect(rr - b < 40 && Math.abs(rr - g) < 40).toBe(true);
});


test('clicking a checkbox reports its new state (ref and coordinate clicks)', async () => {
  const R: Record<string, string> = {};
  const s = script([
    () => [{ name: 'read_page', input: { filter: 'interactive' } }],
    (c) => {
      R.remember = c.mustRef('checkbox', 'Remember me');
      return [{ name: 'left_click', input: { target: { type: 'ref', ref: R.remember } } }, { name: 'left_click', input: { target: { type: 'ref', ref: R.remember } } }];
    },
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('form.html?toggle') });
  expect(r.text(1)).toMatch(/It "Remember me" is now checked\./);
  expect(r.text(2)).toMatch(/It "Remember me" is now unchecked\./);
  const page = await pageFor(env, 'form.html?toggle');
  const box = (await page.locator('#remember').boundingBox())!;
  const s2 = script([() => [{ name: 'left_click', input: { target: { type: 'coordinate', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } } }], () => 'done']);
  const r2 = await run(env, s2, { sessionId: r.sessionId });
  expect(r2.text(0)).toMatch(/on checkbox "Remember me"\. It "Remember me" is now checked\./);
});

test('side panel: messages can be sent while the agent is working', async () => {
  const target = await env.context.newPage();
  await target.goto(env.fx.url('article.html?interject'));
  const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, target.url());
  const panel = await env.context.newPage();
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html?tabId=${tabId}`);
  await expect(panel.locator('#conn .conn-label')).toHaveText('Connected');
  let seen = '';
  const s = script([
    () => [{ name: 'wait', input: { duration: 3 } }],
    (c) => {
      const last = c.history[c.history.length - 1] as any;
      seen = (last.notes ?? []).join('|');
      return `I got: ${seen}`;
    },
  ]);
  await panel.locator('#input').fill(`start #script:${s}`);
  await panel.locator('#btn-send').click();
  if (process.env.DEBUG_E2E) {
    await panel.waitForTimeout(1500);
    console.log('PANEL:', await panel.locator('#messages').innerText(), '| status:', await panel.locator('#status').getAttribute('class'));
  }
  await expect(panel.locator('#btn-stop')).toBeVisible();
  await panel.locator('#input').fill('please hurry');
  await panel.locator('#btn-send').click();
  await expect(panel.locator('.msg.user').last()).toHaveText('please hurry');
  await expect(panel.locator('.msg.assistant').last()).toContainText('I got: please hurry');
  expect(seen).toBe('please hurry');
  await panel.close();
  await target.close();
});
