/**
 * End-to-end: the extension executes every browser member against real pages, driven by the
 * real agent server with a scripted model.
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

const ref = (c: { mustRef(role: string, name: string | RegExp): string }, role: string, name: string | RegExp) => ({ type: 'ref', ref: c.mustRef(role, name) });

test('session begins in a new tab group with the overlay, and read_page returns refs', async () => {
  const s = script([() => [{ name: 'read_page', input: { filter: 'interactive' } }], (c) => c.lastText]);
  const r = await run(env, s, { startUrl: env.fx.url('form.html') });
  expect(r.reason).toBe('end_turn');
  expect(r.final).toMatch(/textbox "Username" \[ref_\d+\]/);
  expect(r.final).toMatch(/button "Sign in" \[ref_\d+\]/);
  expect(r.final).toMatch(/combobox "Country" \[ref_\d+\]/);
  const page = await pageFor(env, 'form.html');
  // Overlay host is injected into the agent's tab while it works (removed/hidden afterwards).
  expect(await page.locator('ba-agent-overlay').count()).toBe(1);
  const groups = await env.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
  expect(groups.some((t) => t?.startsWith('Agent'))).toBe(true);
});

test('fills and submits a form: click+type, form_input select/checkbox, controlled input, password approval', async () => {
  const s = script([
    () => [{ name: 'read_page', input: { filter: 'interactive' } }],
    (c) => [
      { name: 'left_click', input: { target: ref(c, 'textbox', 'Username') } },
      { name: 'type', input: { text: 'alice' } },
      { name: 'form_input', input: { target: ref(c, 'combobox', 'Country'), value: 'Canada' } },
      { name: 'form_input', input: { target: ref(c, 'checkbox', 'Remember me'), value: true } },
      { name: 'left_click', input: { target: ref(c, 'radio', 'Pro') } },
      { name: 'left_click', input: { target: ref(c, 'textbox', /Nickname/) } },
      { name: 'type', input: { text: 'neo' } },
      { name: 'left_click', input: { target: ref(c, 'textbox', 'Bio') } },
      { name: 'type', input: { text: 'line one\nline two' } },
      { name: 'left_click', input: { target: ref(c, 'textbox', 'Password') } },
      { name: 'type', input: { text: 'pw1234' } },
      { name: 'read_page', input: { filter: 'interactive' } },
    ],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Sign in') } }],
    () => [{ name: 'get_page_text' }],
    (c) => c.lastText,
  ]);
  const approvals: string[] = [];
  const r = await run(env, s, { startUrl: env.fx.url('form.html'), onEvent: (e) => e.type === 'approval_request' && approvals.push(`${e.kind}:${e.summary}`) });
  expect(errorTexts(r)).toEqual([]);
  expect(r.text(2)).toMatch(/^Typed "alice" into textbox "Username"\. Its value is now "alice"\./);
  expect(r.text(3)).toBe('Set ref_' + r.text(3).match(/ref_(\d+)/)![1] + ' combobox "Country" to "Canada".');
  expect(r.final).toContain('Welcome alice; pw=6 chars; country=ca; remember=true; plan=pro; nick=neo; bio=line one line two');
  // Typing the password needed confirmation (sensitive field); so did submitting the login form.
  expect(approvals.some((a) => a.startsWith('sensitive:Type into'))).toBe(true);
  expect(approvals.some((a) => a.startsWith('sensitive:Click "Sign in"'))).toBe(true);
  // The typed password never appears in the outline the model sees.
  expect(r.text(12)).not.toContain('pw1234');
});

test('frames: same-origin, nested and cross-origin iframes are stitched and clickable', async () => {
  const s = script([
    () => [{ name: 'read_page' }],
    (c) => [
      { name: 'left_click', input: { target: ref(c, 'button', 'Inner button') } },
      { name: 'left_click', input: { target: ref(c, 'button', 'Nested button') } },
      { name: 'left_click', input: { target: ref(c, 'textbox', 'Card holder') } },
      { name: 'type', input: { text: 'Ann' } },
      { name: 'left_click', input: { target: ref(c, 'button', 'Save card holder') } },
      { name: 'get_page_text' },
    ],
    (c) => c.lastText,
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('frames.html') });
  expect(errorTexts(r)).toEqual([]);
  const outline = r.text(0);
  expect(outline).toMatch(/iframe "Same origin widget" \[ref_\d+\][^\n]*\n\s+heading "Inner frame"/);
  expect(outline).toMatch(/iframe "Nested frame"[^\n]*\n\s+button "Nested button" \[ref_\d+\]/);
  expect(outline).toMatch(/iframe "Payment widget"[^\n]*\n\s+heading "Card details"/);
  const page = await pageFor(env, 'frames.html');
  await expect(page.locator('#log')).toHaveText('cross clicked: Ann');
  await expect(page.frameLocator('#same').locator('#b')).toHaveText('Inner clicked');
  await expect(page.frameLocator('#same').frameLocator('iframe').locator('#n')).toHaveText('Nested clicked');
  expect(r.final).toContain('Embedded frame');
});

test('shadow DOM controls', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'search products field' } }],
    (c) => [
      { name: 'left_click', input: { target: ref(c, 'textbox', 'Search products') } },
      { name: 'type', input: { text: 'mug' } },
      { name: 'find', input: { query: 'Go button' } },
    ],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Go') } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('shadow.html') });
  expect(errorTexts(r)).toEqual([]);
  await expect((await pageFor(env, 'shadow.html')).locator('#log')).toHaveText('searched: mug');
});

test('find + click far down a long page; scroll reports position; inner scroll areas', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'select item 250' } }],
    (c) => [
      { name: 'left_click', input: { target: ref(c, 'button', 'Select item 250') } },
      { name: 'scroll', input: { target: { type: 'coordinate', x: 640, y: 500 }, scroll_direction: 'down', scroll_amount: 5 } },
      { name: 'scroll', input: { target: { type: 'coordinate', x: 150, y: 50 }, scroll_direction: 'up', scroll_amount: 10 } },
    ],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('long.html') });
  expect(errorTexts(r)).toEqual([]);
  await expect((await pageFor(env, 'long.html')).locator('#log')).toHaveText('selected 250');
  expect(r.text(2)).toMatch(/Scrolled down by 5 at \(640, 500\)\. Page scroll position is now \d+px of \d+px vertically\./);
});

test('covered elements produce a clear error; dismissing the overlay then works', async () => {
  const s = script([
    () => [{ name: 'read_page', input: { filter: 'interactive' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Covered button') } }, { name: 'key', input: { text: 'Enter' } }],
    () => [{ name: 'find', input: { query: 'accept cookies' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Accept cookies') } }, { name: 'find', input: { query: 'covered button' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'button', 'Covered button') } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('buttons.html') });
  expect(r.text(1)).toMatch(/cannot left click element ref_\d+ \(button "Covered button"\): it is covered by/);
  expect(r.text(2)).toBe('Not executed: an earlier action in this turn failed.');
  await expect((await pageFor(env, 'buttons.html')).locator('#log')).toHaveText('covered clicked');
});

test('mouse: double/right click, clickable divs, hover menus, drag, hidden checkbox via label', async () => {
  const R: Record<string, { type: string; ref: string }> = {};
  const s = script([
    () => [{ name: 'read_page', input: { filter: 'interactive' } }],
    (c) => {
      for (const [k, role, name] of [['accept', 'button', 'Accept cookies'], ['dbl', 'button', 'Double-click me'], ['ctx', 'button', 'Right-click me'], ['card', 'clickable', 'Open card'], ['menu', 'button', 'Menu'], ['terms', 'checkbox', 'I like tests']] as const) R[k] = ref(c, role, name);
      return [{ name: 'left_click', input: { target: R.accept } }, { name: 'double_click', input: { target: R.dbl } }];
    },
    () => [{ name: 'right_click', input: { target: R.ctx } }],
    () => [{ name: 'left_click', input: { target: R.card } }, { name: 'hover', input: { target: R.menu } }, { name: 'find', input: { query: 'secret item' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'link', 'Secret item') } }],
    () => [{ name: 'left_click', input: { target: R.terms } }],
    () => [{ name: 'left_click_drag', input: { from: { type: 'coordinate', x: 430, y: 190 }, target: { type: 'coordinate', x: 630, y: 290 } } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('buttons.html') });
  if (process.env.DEBUG_E2E) console.log(r.results.map((x, i) => `${i} ${x.member} ${JSON.stringify(x.input)} => ${x.result.content.map((b) => (b.type === 'text' ? b.text : b.type)).join(' | ')}`).join('\n'));
  expect(errorTexts(r)).toEqual([]);
  const page = await pageFor(env, 'buttons.html');
  await expect(page.locator('#card')).toHaveText('Card opened');
  await expect(page.locator('#terms')).toBeChecked();
  await expect(page.locator('#log')).toHaveText(/dropped at 600,260/);
  const all = r.results.map((x) => x.result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).join('\n');
  expect(all).toMatch(/Double-clicked element/);
  expect(all).toMatch(/Right-clicked element/);
  expect(all).toMatch(/Hovered over element/);
});

test('keyboard: chords, sequences, repeat, editing commands', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'key log target' } }],
    (c) => [
      { name: 'left_click', input: { target: ref(c, 'textbox', 'Key log target') } },
      { name: 'type', input: { text: 'ab' } },
      { name: 'key', input: { text: 'ctrl+a' } },
      { name: 'key', input: { text: 'Backspace' } },
      { name: 'type', input: { text: 'Z!' } },
      { name: 'key', input: { text: 'ArrowLeft', repeat: 2 } },
      { name: 'key', input: { text: 'Home End' } },
    ],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('buttons.html') });
  expect(errorTexts(r)).toEqual([]);
  const page = await pageFor(env, 'buttons.html');
  await expect(page.locator('#keys')).toHaveValue('Z!');
  await expect(page.locator('#log')).toHaveText('keys:a,b,ctrl+Control,ctrl+a,Backspace,Z,!,ArrowLeft,ArrowLeft,Home,End');
});

test('typing with nothing focused is an error (text would be lost)', async () => {
  const s = script([() => [{ name: 'type', input: { text: 'lost' } }], () => 'done']);
  const r = await run(env, s, { startUrl: env.fx.url('article.html') });
  expect(r.text(0)).toMatch(/no element has keyboard focus/);
});

test('contenteditable editor', async () => {
  const s = script([
    () => [{ name: 'find', input: { query: 'rich editor' } }],
    (c) => [{ name: 'left_click', input: { target: ref(c, 'textbox', 'Rich editor') } }, { name: 'key', input: { text: 'ctrl+a' } }, { name: 'type', input: { text: 'Hello editor' } }],
    () => 'done',
  ]);
  const r = await run(env, s, { startUrl: env.fx.url('editor.html') });
  expect(errorTexts(r)).toEqual([]);
  await expect((await pageFor(env, 'editor.html')).locator('#log')).toHaveText('editor: Hello editor');
});

