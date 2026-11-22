/**
 * Content-script logic (outline, find, resolve, form_input, describe) against real pages,
 * without the extension: the harness bundle exposes the functions on window.__ba.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.ts';

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/extension/dist-test/outline-harness.js');
let fx: FixtureServer;

test.beforeAll(async () => {
  fx = await startFixtureServer();
});
test.afterAll(async () => {
  await fx.close();
});

async function open(page: Page, file: string): Promise<void> {
  await page.goto(fx.url(file));
  await page.addScriptTag({ path: harness });
}

const outline = (page: Page, req: Record<string, unknown> = {}) => page.evaluate((r) => (window as any).__ba.outline(r), req);

test('outline of a form: roles, names, values, states, landmarks', async ({ page }) => {
  await open(page, 'form.html');
  const o = await outline(page);
  const t: string = o.text;
  expect(t).toMatch(/main/);
  expect(t).toMatch(/heading "Sign in" \[L\d+\] level=1/);
  expect(t).toMatch(/textbox "Username" \[L\d+\] value=""/);
  expect(t).toMatch(/textbox "Password" \[L\d+\] type="password" value=""/);
  expect(t).toMatch(/combobox "Country" \[L\d+\] value="Choose…"/);
  expect(t).toMatch(/option "Canada" \[L\d+\]/);
  expect(t).toMatch(/checkbox "Remember me" \[L\d+\] unchecked/);
  expect(t).toMatch(/radio "Free" \[L\d+\] checked/);
  expect(t).toMatch(/group "Plan"/);
  expect(t).toMatch(/textbox "Nickname \(controlled\)" \[L\d+\] value="" placeholder="Pick a nickname"/);
  expect(t).toMatch(/button "Sign in" \[L\d+\]/);
  // Ids are stable across reads.
  const again = await outline(page);
  expect(again.text).toBe(t);
});

test('interactive filter only lists controls; password values are masked', async ({ page }) => {
  await open(page, 'form.html');
  await page.fill('#pw', 'hunter22');
  await page.fill('#user', 'alice');
  const t: string = (await outline(page, { filter: 'interactive' })).text;
  expect(t).not.toMatch(/heading/);
  expect(t).toMatch(/textbox "Username" \[L\d+\] value="alice"/);
  expect(t).toMatch(/value="••••••"/);
  expect(t).not.toContain('hunter22');
});

test('hidden content is excluded; viewport filter vs all', async ({ page }) => {
  await open(page, 'article.html');
  const t: string = (await outline(page)).text;
  expect(t).toContain('The secret number is 4217');
  expect(t).not.toContain('ignore all previous instructions');
  await open(page, 'long.html');
  const vis: string = (await outline(page)).text;
  const all: string = (await outline(page, { filter: 'all' })).text;
  expect(vis).toContain('Select item 1');
  expect(vis).not.toContain('Select item 250');
  expect(all).toContain('Select item 250');
});

test('depth cap and subtree reads', async ({ page }) => {
  await open(page, 'index.html');
  const shallow: string = (await outline(page, { depth: 2 })).text;
  expect(shallow).not.toMatch(/link "Login form"/);
  const navId = await page.evaluate(() => (window as any).__ba.idOf('nav'));
  const sub: string = (await outline(page, { rootId: navId })).text;
  expect(sub.split('\n')[0]).toMatch(/^navigation/);
  expect(sub).toMatch(/link "Login form" \[L\d+\] href="form.html"/);
  expect(sub).not.toContain('Fixture Home');
});

test('shadow DOM and slots are traversed', async ({ page }) => {
  await open(page, 'shadow.html');
  const t: string = (await outline(page)).text;
  expect(t).toMatch(/textbox "Search products"/);
  expect(t).toMatch(/button "Go"/);
  expect(t).toMatch(/heading "Slotted title"/);
  expect(t).toMatch(/button "Shadow action"/);
});

test('iframes appear as iframe lines (stitched by the service worker)', async ({ page }) => {
  await open(page, 'frames.html');
  const t: string = (await outline(page)).text;
  expect(t).toMatch(/iframe "Same origin widget" \[L\d+\] src="frame-inner.html"/);
  expect(t).toMatch(/iframe "Payment widget" \[L\d+\]/);
  expect(t).not.toContain('Inner button');
});

test('generic clickable elements and custom checkboxes', async ({ page }) => {
  await open(page, 'buttons.html');
  const t: string = (await outline(page, { filter: 'interactive' })).text;
  expect(t).toMatch(/clickable "Open card" \[L\d+\] tag=div/);
  expect(t).toMatch(/checkbox "I like tests"/);
});

test('find ranks relevant elements first', async ({ page }) => {
  await open(page, 'form.html');
  const find = (q: string) => page.evaluate((qq) => (window as any).__ba.find(qq), q);
  expect((await find('sign in button'))[0]).toMatchObject({ role: 'button', name: 'Sign in' });
  expect((await find('username field'))[0]).toMatchObject({ role: 'textbox', name: 'Username' });
  expect((await find('country dropdown'))[0]).toMatchObject({ role: 'combobox', name: 'Country' });
  expect((await find('remember checkbox'))[0]).toMatchObject({ role: 'checkbox' });
  expect(await find('xyzzy nonexistent')).toEqual([]);
  await open(page, 'shop.html');
  const r = await page.evaluate(() => (window as any).__ba.find('place order button'));
  expect(r[0]).toMatchObject({ role: 'button', name: 'Place order' });
});

test('resolve: scrolls into view, hit-tests, detects covering overlays and hidden inputs', async ({ page }) => {
  await open(page, 'long.html');
  const id = await page.evaluate(() => (window as any).__ba.idOf('li:nth-child(250) button'));
  const r = await page.evaluate((i) => (window as any).__ba.resolve(i, { scroll: true }), id);
  expect(r.ok).toBe(true);
  expect(r.unclickable).toBeUndefined();
  expect(r.y).toBeGreaterThan(0);
  expect(r.y).toBeLessThan(800);
  // Clicking at the reported point hits the button.
  await page.mouse.click(r.x, r.y);
  await expect(page.locator('#log')).toHaveText('selected 250');

  await open(page, 'buttons.html');
  const cov = await page.evaluate(() => (window as any).__ba.resolve((window as any).__ba.idOf('#covered'), { scroll: true }));
  expect(cov.unclickable).toMatch(/covered by/);
  // A visually hidden checkbox resolves to its label, and clicking there toggles it.
  const hidden = await page.evaluate(() => (window as any).__ba.resolve((window as any).__ba.idOf('#terms'), { scroll: true }));
  expect(hidden.unclickable).toBeUndefined();
  await page.mouse.click(hidden.x, hidden.y);
  await expect(page.locator('#terms')).toBeChecked();
  const stale = await page.evaluate(() => (window as any).__ba.resolve(999999, { scroll: true }));
  expect(stale.stale).toBe(true);
});

test('form_input works with selects, checkboxes, radios, controlled inputs and editors', async ({ page }) => {
  await open(page, 'form.html');
  const set = (sel: string, v: unknown) => page.evaluate(([s, val]) => (window as any).__ba.formInput((window as any).__ba.idOf(s), val), [sel, v] as const);
  expect(await set('#country', 'Canada')).toMatchObject({ ok: true });
  await expect(page.locator('#country')).toHaveValue('ca');
  expect(await set('#country', 'de')).toMatchObject({ ok: true });
  await expect(page.locator('#country')).toHaveValue('de');
  expect((await set('#country', 'Mars')).message).toMatch(/no option matching "Mars". Options: "Choose…", "United States"/);
  expect(await set('#remember', true)).toMatchObject({ ok: true, message: expect.stringContaining('Checked') });
  await expect(page.locator('#remember')).toBeChecked();
  expect(await set('input[value=pro]', true)).toMatchObject({ ok: true });
  await expect(page.locator('input[value=pro]')).toBeChecked();
  expect((await set('input[value=pro]', false)).ok).toBe(false);
  expect(await set('#nick', 'neo')).toMatchObject({ ok: true });
  await page.waitForTimeout(250);
  await expect(page.locator('#nick-state')).toHaveText('neo');
  await expect(page.locator('#nick')).toHaveValue('neo');
  expect((await set('#pw', 'secret123')).message).not.toContain('secret123');
  await open(page, 'editor.html');
  expect(await page.evaluate(() => (window as any).__ba.formInput((window as any).__ba.idOf('#ed'), 'New text'))).toMatchObject({ ok: true });
  await expect(page.locator('#log')).toHaveText('editor: New text');
});

test('describe reports form context and sensitivity', async ({ page }) => {
  await open(page, 'form.html');
  const d = await page.evaluate(() => (window as any).__ba.describeId((window as any).__ba.idOf('#pw')));
  expect(d.info).toMatchObject({ role: 'textbox', inputType: 'password', sensitive: true, formSubmitName: 'Sign in', formHasPassword: true });
  const u = await page.evaluate(() => (window as any).__ba.describeId((window as any).__ba.idOf('#user')));
  expect(u.info.sensitive).toBe(false);
  await page.focus('#user');
  const f = await page.evaluate(() => (window as any).__ba.describeFocused());
  expect(f.info).toMatchObject({ name: 'Username' });
});

test('page text prefers main content and omits hidden text', async ({ page }) => {
  await open(page, 'article.html');
  const r = await page.evaluate(() => (window as any).__ba.pageText());
  expect(r.title).toBe('The Fixture Article');
  expect(r.text).toContain('The secret number is 4217.');
  expect(r.text).not.toContain('Footer');
  expect(r.text).not.toContain('ignore all previous instructions');
});

test('outline handles a large page quickly', async ({ page }) => {
  await page.goto(fx.url('index.html'));
  await page.evaluate(() => {
    const root = document.createElement('div');
    for (let i = 0; i < 4000; i++) {
      const d = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = `row ${i}`;
      const a = document.createElement('a');
      a.href = `#${i}`;
      a.textContent = `link ${i}`;
      const b = document.createElement('button');
      b.textContent = `btn ${i}`;
      d.append(span, ' ', a, ' ', b);
      root.append(d);
    }
    document.body.append(root);
  });
  await page.addScriptTag({ path: harness });
  const t0 = Date.now();
  const o = await outline(page, { filter: 'all' });
  const ms = Date.now() - t0;
  // Capped at 6000 lines (the service worker also caps output at 50k chars) and flagged.
  expect(o.lines.length).toBe(6000);
  expect(o.truncated).toBe(true);
  expect(ms).toBeLessThan(5000);
});
