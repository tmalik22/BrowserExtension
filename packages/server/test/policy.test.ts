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
    expect(evaluate('navigate', { url: 'https://a.example.com/' }, undefined, S({ allowedSites: ['example.com'] }), fresh()).kind).toBe('allow');
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
