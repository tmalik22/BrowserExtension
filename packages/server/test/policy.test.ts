import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIRM, DEFAULT_SETTINGS, type ActionDescription, type ConfirmSettings, type PolicySettings } from '@ba/shared';
import { SettingsStore, sanitizeConfirm } from '../src/config.ts';
import { checkUploadPaths, evaluate, needsDescription } from '../src/agent/policy.ts';

const S = (patch: Partial<PolicySettings> = {}): PolicySettings => ({ ...DEFAULT_SETTINGS, ...patch, enableOptional: { ...DEFAULT_SETTINGS.enableOptional, ...(patch.enableOptional ?? {}) } });
const fresh = () => ({ sessionSites: new Set<string>() });
const page = (host: string, element?: ActionDescription['element']): ActionDescription => ({ tabId: 'tab-1', url: `https://${host}/p`, host, element });

describe('policy.evaluate', () => {
  it('asks before opening a new site in ask mode, allows approved sites', () => {
    const v = evaluate('navigate', { url: 'shop.example.com' }, undefined, S(), fresh());
    expect(v).toMatchObject({ kind: 'ask', approvalKind: 'site', site: 'shop.example.com' });
    const st = fresh();
    st.sessionSites.add('shop.example.com');
    expect(evaluate('navigate', { url: 'https://shop.example.com/x' }, undefined, S(), st).kind).toBe('allow');
    expect(evaluate('navigate', { url: 'https://www.example.com/' }, undefined, S({ allowedSites: ['example.com'] }), fresh()).kind).toBe('allow');
    // An approved site does not cover its other subdomains unless the entry says so with "*.".
    expect(evaluate('navigate', { url: 'https://a.example.com/' }, undefined, S({ allowedSites: ['example.com'] }), fresh()).kind).toBe('ask');
    expect(evaluate('navigate', { url: 'https://a.example.com/' }, undefined, S({ allowedSites: ['*.example.com'] }), fresh()).kind).toBe('allow');
  });
  it('allows any site in auto mode but still blocks policy violations', () => {
    expect(evaluate('navigate', { url: 'https://x.org' }, undefined, S({ permissionMode: 'auto' }), fresh()).kind).toBe('allow');
    expect(evaluate('navigate', { url: 'javascript:alert(1)' }, undefined, S({ permissionMode: 'yolo' }), fresh()).kind).toBe('deny');
    expect(evaluate('navigate', { url: 'http://192.168.1.1' }, undefined, S({ permissionMode: 'yolo' }), fresh()).kind).toBe('deny');
    expect(evaluate('navigate', { url: 'https://evil.com' }, undefined, S({ permissionMode: 'yolo', blockedSites: ['evil.com'] }), fresh()).kind).toBe('deny');
    expect(evaluate('navigate', { url: 'back' }, undefined, S(), fresh()).kind).toBe('allow');
  });
  it('asks before acting on an unapproved site', () => {
    const v = evaluate('left_click', { target: { type: 'ref', ref: 'ref_1' } }, page('news.site', { role: 'link', name: 'Story', tag: 'a' }), S(), fresh());
    expect(v).toMatchObject({ kind: 'ask', approvalKind: 'site', site: 'news.site' });
  });
  it('requires confirmation for consequential clicks in auto mode', () => {
    for (const name of ['Place order', 'Buy now', 'Send', 'Delete account', 'Confirm purchase', 'Pay $10.00', 'Post']) {
      const v = evaluate('left_click', { target: { type: 'ref', ref: 'ref_1' } }, page('x.com', { role: 'button', name, tag: 'button' }), S({ permissionMode: 'auto' }), fresh());
      expect(v, name).toMatchObject({ kind: 'ask', approvalKind: 'consequential' });
    }
    for (const name of ['Search', 'Next page', 'Show more', 'Sort by price']) {
      const v = evaluate('left_click', { target: { type: 'ref', ref: 'ref_1' } }, page('x.com', { role: 'button', name, tag: 'button' }), S({ permissionMode: 'auto' }), fresh());
      expect(v.kind, name).toBe('allow');
    }
  });
  it('treats Enter in a form with a consequential submit as consequential', () => {
    const el = { role: 'textbox', name: 'Message', tag: 'textarea', formSubmitName: 'Send message' };
    expect(evaluate('key', { text: 'Enter' }, page('x.com', el), S({ permissionMode: 'auto' }), fresh()).kind).toBe('ask');
    expect(evaluate('key', { text: 'Enter' }, page('x.com', { ...el, formSubmitName: 'Search' }), S({ permissionMode: 'auto' }), fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'Tab' }, page('x.com', el), S({ permissionMode: 'auto' }), fresh()).kind).toBe('allow');
  });
  it('asks before typing into sensitive fields', () => {
    const v = evaluate('type', { text: 'hunter2' }, page('x.com', { role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', sensitive: true }), S({ permissionMode: 'auto' }), fresh());
    expect(v).toMatchObject({ kind: 'ask', approvalKind: 'sensitive' });
  });
  it('never asks in yolo mode (except hard denies)', () => {
    const v = evaluate('left_click', { target: { type: 'ref', ref: 'ref_1' } }, page('x.com', { role: 'button', name: 'Buy now', tag: 'button' }), S({ permissionMode: 'yolo' }), fresh());
    expect(v.kind).toBe('allow');
  });
  it('denies disabled optional members regardless of mode', () => {
    expect(evaluate('javascript_exec', { text: '1' }, page('x.com'), S({ permissionMode: 'yolo' }), fresh())).toMatchObject({ kind: 'deny', message: 'Error: javascript_exec is not enabled in this environment.' });
    expect(evaluate('read_console', {}, page('x.com'), S(), fresh()).kind).toBe('deny');
  });
  it('confirms javascript_exec when enabled', () => {
    expect(evaluate('javascript_exec', { text: 'document.title' }, page('x.com'), S({ permissionMode: 'auto', enableOptional: { javascript_exec: true } as any }), fresh()).kind).toBe('ask');
  });
  it('blocks acting on pages in blocked or private hosts', () => {
    const v = evaluate('left_click', {}, { tabId: 'tab-1', url: 'http://10.0.0.5/admin', host: '10.0.0.5' }, S({ permissionMode: 'yolo' }), fresh());
    expect(v.kind).toBe('deny');
  });
  it('knows which members need a description', () => {
    expect(needsDescription('left_click')).toBe(true);
    expect(needsDescription('read_page')).toBe(false);
    expect(needsDescription('list_tabs')).toBe(false);
  });
});

describe('risky clicks', () => {
  const click = (name: string, settings: PolicySettings) =>
    evaluate('left_click', { target: { type: 'ref', ref: 'ref_1' } }, page('x.com', { role: 'button', name, tag: 'button' }), settings, fresh());
  it('ignores action words that only appear in a long description', () => {
    expect(click('Match for Opens the receivables folder, matches every invoice to payment records', S({ permissionMode: 'auto' })).kind).toBe('allow');
    expect(click('Pay now', S({ permissionMode: 'auto' })).kind).toBe('ask');
  });
});

describe('approval categories', () => {
  const ALL_OFF = Object.fromEntries(Object.keys(DEFAULT_CONFIRM).map((k) => [k, false])) as ConfirmSettings;
  const only = (patch: Partial<ConfirmSettings>) => S({ permissionMode: 'auto', confirm: { ...ALL_OFF, ...patch } });
  const off = (patch: Partial<ConfirmSettings>) => S({ permissionMode: 'auto', confirm: { ...DEFAULT_CONFIRM, ...patch } });
  const button = (name: string) => page('x.com', { role: 'button', name, tag: 'button' });
  const clickOn = (name: string, settings: PolicySettings) => evaluate('left_click', { target: { type: 'ref', ref: 'ref_1' } }, button(name), settings, fresh());
  const pw = page('x.com', { role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', sensitive: true });
  const loginBtn = page('x.com', { role: 'button', name: 'Sign in', tag: 'button', formHasPassword: true });

  it('labels each question with the category that triggered it', () => {
    const cases: [string, string][] = [
      ['Place order', 'payments'],
      ['Pay $10.00', 'payments'],
      ['Send', 'messages'],
      ['Delete account', 'deletions'],
      ['Change password', 'accountChanges'],
      ['Turn off two-factor', 'accountChanges'],
      ['I agree', 'agreements'],
      ['Submit', 'forms'],
    ];
    for (const [name, category] of cases) expect(clickOn(name, S({ permissionMode: 'auto' })), name).toMatchObject({ kind: 'ask', category });
    expect(clickOn('Place order', S({ permissionMode: 'auto' }))).toMatchObject({ reason: expect.stringContaining('Purchases & payments') });
  });
  it('switching one category off only stops those questions', () => {
    const s = off({ payments: false });
    expect(clickOn('Place order', s).kind).toBe('allow');
    expect(clickOn('Buy now', s).kind).toBe('allow');
    expect(clickOn('Send', s).kind).toBe('ask');
    expect(clickOn('Delete account', s).kind).toBe('ask');
    expect(evaluate('type', { text: 'x' }, pw, s, fresh()).kind).toBe('ask');
  });
  it('a label in two categories still asks while either is on', () => {
    expect(clickOn('Remove card', only({ accountChanges: true })).kind).toBe('ask');
    expect(clickOn('Delete card', only({ deletions: true })).kind).toBe('ask');
    expect(clickOn('Delete card', only({ payments: true })).kind).toBe('allow');
  });
  it('logins and sensitive fields can be switched off separately', () => {
    expect(evaluate('left_click', {}, loginBtn, off({ logins: false }), fresh()).kind).toBe('allow');
    expect(evaluate('type', { text: 'x' }, pw, off({ logins: false }), fresh()).kind).toBe('ask');
    expect(evaluate('type', { text: 'x' }, pw, off({ sensitiveFields: false }), fresh()).kind).toBe('allow');
    expect(evaluate('left_click', {}, loginBtn, off({ sensitiveFields: false }), fresh())).toMatchObject({ kind: 'ask', category: 'logins' });
  });
  it('dialogs, unknown targets and scripts each have their own switch', () => {
    const dlg: ActionDescription = { ...page('x.com'), dialog: { type: 'confirm', message: 'Really?' } };
    expect(evaluate('key', { text: 'Enter' }, dlg, S({ permissionMode: 'auto' }), fresh())).toMatchObject({ kind: 'ask', category: 'dialogs' });
    expect(evaluate('key', { text: 'Enter' }, dlg, off({ dialogs: false }), fresh()).kind).toBe('allow');
    expect(evaluate('left_click', {}, undefined, S({ permissionMode: 'auto' }), fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    expect(evaluate('left_click', {}, undefined, off({ uninspectable: false }), fresh()).kind).toBe('allow');
    const js = { enableOptional: { ...DEFAULT_SETTINGS.enableOptional, javascript_exec: true } };
    expect(evaluate('javascript_exec', { text: '1' }, page('x.com'), S({ permissionMode: 'auto', ...js }), fresh())).toMatchObject({ kind: 'ask', category: 'scriptsAndUploads' });
    expect(evaluate('javascript_exec', { text: '1' }, page('x.com'), S({ permissionMode: 'auto', ...js, confirm: { ...DEFAULT_CONFIRM, scriptsAndUploads: false } }), fresh()).kind).toBe('allow');
  });
  it('with every category off nothing is confirmed, but site permission and hard denies still apply', () => {
    for (const name of ['Place order', 'Send', 'Delete account', 'Submit', 'I agree']) expect(clickOn(name, only({})).kind, name).toBe('allow');
    expect(evaluate('type', { text: 'x' }, pw, only({}), fresh()).kind).toBe('allow');
    expect(evaluate('left_click', {}, button('Buy'), S({ permissionMode: 'ask', confirm: ALL_OFF }), fresh())).toMatchObject({ kind: 'ask', approvalKind: 'site' });
    expect(evaluate('navigate', { url: 'https://evil.com' }, undefined, S({ permissionMode: 'auto', confirm: ALL_OFF, blockedSites: ['evil.com'] }), fresh()).kind).toBe('deny');
  });
});

describe('confirmation settings migration', () => {
  it('fills missing categories with defaults and ignores junk', () => {
    expect(sanitizeConfirm({ payments: false, bogus: true, logins: 'no' })).toEqual({ ...DEFAULT_CONFIRM, payments: false });
    expect(sanitizeConfirm(undefined)).toEqual(DEFAULT_CONFIRM);
  });
  it('turns the old "risky clicks off" switch into categories, keeping credentials on', () => {
    const c = sanitizeConfirm(undefined, false);
    expect(c.payments).toBe(false);
    expect(c.messages).toBe(false);
    expect(c.logins).toBe(true);
    expect(c.sensitiveFields).toBe(true);
    expect(c.scriptsAndUploads).toBe(true);
  });
  it('migrates an old settings file and merges partial updates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-set-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ permissionMode: 'auto', confirmRiskyClicks: false }));
    const store = new SettingsStore(dir);
    expect(store.get().confirm.payments).toBe(false);
    expect(store.get().confirm.logins).toBe(true);
    expect(store.update({ confirm: { payments: true } as ConfirmSettings }).confirm).toMatchObject({ payments: true, messages: false, logins: true });
    expect(store.update({ confirmRiskyClicks: true }).confirm.messages).toBe(true);
    expect(new SettingsStore(dir).get().confirm).toMatchObject({ payments: true, messages: true });
  });
});

describe('checkUploadPaths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-up-'));
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  it('accepts files inside the upload dir', () => {
    expect(checkUploadPaths(['ok.txt'], dir)).toBeNull();
    expect(checkUploadPaths([path.join(dir, 'ok.txt')], dir)).toBeNull();
  });
  it('rejects traversal, missing files and directories', () => {
    expect(checkUploadPaths(['../etc/passwd'], dir)).toMatch(/outside|does not exist/);
    expect(checkUploadPaths(['missing.txt'], dir)).toMatch(/does not exist/);
    expect(checkUploadPaths(['sub'], dir)).toMatch(/not a file/);
    expect(checkUploadPaths([], dir)).toMatch(/at least one/);
    expect(checkUploadPaths(['ok.txt'], undefined)).toMatch(/no upload directory/);
  });
});

describe('reads, embedded frames and key tricks (security sweep)', () => {
  const ask = () => S({ permissionMode: 'ask' });
  it('asks before reading a site that was not approved (redirects, popups, back/forward)', () => {
    for (const m of ['get_page_text', 'read_page', 'screenshot', 'find', 'zoom']) {
      expect(evaluate(m, {}, page('mail.example'), ask(), fresh()), m).toMatchObject({ kind: 'ask', approvalKind: 'site', site: 'mail.example' });
    }
    const st = fresh();
    st.sessionSites.add('mail.example');
    expect(evaluate('get_page_text', {}, page('mail.example'), ask(), st).kind).toBe('allow');
    expect(evaluate('get_page_text', {}, page('mail.example'), S({ permissionMode: 'auto' }), fresh()).kind).toBe('allow');
    expect(evaluate('wait', {}, page('mail.example'), ask(), fresh()).kind).toBe('allow');
    expect(evaluate('list_tabs', {}, undefined, ask(), fresh()).kind).toBe('allow');
  });
  it('asks before acting inside an embedded frame from an unapproved site', () => {
    const st = fresh();
    st.sessionSites.add('shop.example');
    const d: ActionDescription = { ...page('shop.example', { role: 'button', name: 'Continue', tag: 'button' }), frameUrl: 'https://bank.example/widget' };
    expect(evaluate('left_click', {}, d, ask(), st)).toMatchObject({ kind: 'ask', approvalKind: 'site', site: 'bank.example' });
    st.sessionSites.add('bank.example');
    expect(evaluate('left_click', {}, d, ask(), st).kind).toBe('allow');
  });
  it('asks when keys move focus and then press Enter/Space', () => {
    const field = page('x.com', { role: 'textbox', name: 'Search', tag: 'input' });
    const auto = S({ permissionMode: 'auto' });
    for (const text of ['Tab Enter', 'shift+Tab Return', 'Down space', 'Tab Tab Tab Enter']) {
      expect(evaluate('key', { text }, field, auto, fresh()), text).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    }
    expect(evaluate('type', { text: 'abc\t\n' }, field, auto, fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    expect(evaluate('key', { text: 'Tab' }, field, auto, fresh()).kind).toBe('allow');
    // Plain Enter in a search field that's part of a form is fine (Enter in a form-less text box asks: chat apps send on Enter).
    expect(evaluate('key', { text: 'Enter' }, page('x.com', { role: 'textbox', name: 'Search', tag: 'input', formSubmitName: 'Search' }), auto, fresh()).kind).toBe('allow');
    expect(evaluate('type', { text: 'hello world' }, field, auto, fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'Tab Enter' }, field, S({ permissionMode: 'auto', confirm: { ...DEFAULT_CONFIRM, uninspectable: false, messages: false } }), fresh()).kind).toBe('allow');
  });
  it('treats key presses into a password field as typing into it', () => {
    const pw = page('x.com', { role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', sensitive: true });
    const auto = S({ permissionMode: 'auto' });
    expect(evaluate('key', { text: 'h u n t e r' }, pw, auto, fresh())).toMatchObject({ kind: 'ask', category: 'sensitiveFields' });
    expect(evaluate('key', { text: 'Tab' }, pw, auto, fresh()).kind).toBe('allow');
  });
});

describe('security sweep round 2', () => {
  const auto = S({ permissionMode: 'auto' });
  const box = (extra: Record<string, unknown> = {}) => page('chat.example', { role: 'textbox', name: 'Message', tag: 'div', ...extra } as any);
  it('Tab then typing is checked (the field it lands in was never inspected)', () => {
    const f = page('x.com', { role: 'textbox', name: 'Name', tag: 'input' });
    expect(evaluate('key', { text: 'Tab 4 1 1 1' }, f, auto, fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    expect(evaluate('type', { text: 'Jane\t4111111111111111' }, f, auto, fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    expect(evaluate('type', { text: 'Jane Doe' }, f, auto, fresh()).kind).toBe('allow');
  });
  it('Enter in a chat box (no form) and Ctrl/Cmd+Enter count as sending', () => {
    expect(evaluate('key', { text: 'Enter' }, box(), auto, fresh())).toMatchObject({ kind: 'ask', category: 'messages' });
    expect(evaluate('type', { text: 'hi there\n' }, box(), auto, fresh())).toMatchObject({ kind: 'ask', category: 'messages' });
    expect(evaluate('key', { text: 'ctrl+Return' }, page('mail.example', { role: 'textbox', name: 'Body', tag: 'textarea', formSubmitName: 'Save draft' }), auto, fresh())).toMatchObject({ kind: 'ask', category: 'messages' });
    expect(evaluate('key', { text: 'shift+Enter' }, box(), auto, fresh()).kind).toBe('allow'); // new line, not send
    expect(evaluate('key', { text: 'Enter' }, box({ role: 'searchbox' }), auto, fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'Enter' }, box(), S({ permissionMode: 'auto', confirm: { ...DEFAULT_CONFIRM, messages: false } }), fresh()).kind).toBe('allow');
  });
  it('single-key shortcuts outside text fields are checked', () => {
    const list = page('mail.example', { role: 'row', name: 'Invoice from ACME', tag: 'tr' });
    expect(evaluate('key', { text: '#' }, list, auto, fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    expect(evaluate('key', { text: 'r' }, undefined as any, auto, fresh()).kind).toBe('ask');
    expect(evaluate('key', { text: 'Escape' }, list, auto, fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'Page_Down' }, list, auto, fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'ctrl+c' }, list, auto, fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'h e l l o' }, page('x.com', { role: 'textbox', name: 'Search', tag: 'input' }), auto, fresh()).kind).toBe('allow');
    // `type` outside a text field sends the same key events, and Backspace/Alt+key are shortcuts too.
    expect(evaluate('type', { text: '#' }, list, auto, fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
    expect(evaluate('key', { text: 'BackSpace' }, list, auto, fresh())).toMatchObject({ kind: 'ask' });
    expect(evaluate('key', { text: 'alt+shift+s' }, list, auto, fresh())).toMatchObject({ kind: 'ask' });
    expect(evaluate('type', { text: 'hello' }, page('x.com', { role: 'textbox', name: 'Search', tag: 'input' }), auto, fresh()).kind).toBe('allow');
  });
  it('reads fail closed when the page could not be identified', () => {
    const d: ActionDescription = { tabId: 'tab-1', url: '', host: '', unknown: 'tab is gone' };
    expect(evaluate('get_page_text', {}, d, S({ permissionMode: 'ask' }), fresh())).toMatchObject({ kind: 'ask', category: 'uninspectable' });
  });
});

describe('browser-internal and extension pages', () => {
  const at = (url: string): ActionDescription => ({ tabId: 't1', url, host: '' });
  it('refuses to read or act on them in every mode, without asking', () => {
    for (const url of ['chrome-extension://abcdefghijklmnop/sidepanel.html', 'chrome://settings/passwords', 'devtools://devtools/x', 'https://chromewebstore.google.com/detail/x']) {
      for (const mode of ['ask', 'auto', 'yolo'] as const) {
        for (const m of ['read_page', 'get_page_text', 'screenshot', 'left_click', 'type']) {
          const r = evaluate(m, { text: 'x' }, at(url), S({ permissionMode: mode }), fresh());
          expect(r.kind, `${m} ${mode} ${url}`).toBe('deny');
        }
      }
    }
  });
  it('still allows about:blank and ordinary sites, and waiting anywhere', () => {
    expect(evaluate('read_page', {}, at('about:blank'), S({ permissionMode: 'auto' }), fresh()).kind).toBe('allow');
    expect(evaluate('wait', {}, at('chrome://newtab/'), S({ permissionMode: 'ask' }), fresh()).kind).toBe('allow');
  });
});
