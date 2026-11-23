/**
 * Policy hardening: site approvals cover one site (not every subdomain), local files are off
 * limits, pasting the clipboard needs a yes, and consequential buttons are recognised in more
 * languages than English.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIRM, DEFAULT_SETTINGS, isRestrictedUrl, siteApproved, type ActionDescription, type PolicySettings } from '@ba/shared';
import { categorize, evaluate } from '../src/agent/policy.ts';

const S = (patch: Partial<PolicySettings> = {}): PolicySettings => ({ ...DEFAULT_SETTINGS, ...patch, enableOptional: { ...DEFAULT_SETTINGS.enableOptional, ...(patch.enableOptional ?? {}) } });
const fresh = () => ({ sessionSites: new Set<string>() });
const page = (host: string, element?: ActionDescription['element']): ActionDescription => ({ tabId: 'tab-1', url: `https://${host}/p`, host, element });
const textbox = { role: 'textbox', name: 'Notes', tag: 'textarea' };

describe('site approvals', () => {
  it('an approved site covers itself and its www. form, not its other subdomains', () => {
    expect(siteApproved('google.com', ['google.com'])).toBe(true);
    expect(siteApproved('www.google.com', ['google.com'])).toBe(true);
    expect(siteApproved('google.com', ['www.google.com'])).toBe(true);
    expect(siteApproved('mail.google.com', ['google.com'])).toBe(false);
    expect(siteApproved('pay.google.com', ['www.google.com'])).toBe(false);
    expect(siteApproved('example.com', ['https://Example.com/path'])).toBe(true);
    expect(siteApproved('example.com', [])).toBe(false);
  });
  it('a "*." entry is how the user approves every subdomain on purpose', () => {
    expect(siteApproved('mail.google.com', ['*.google.com'])).toBe(true);
    expect(siteApproved('google.com', ['*.google.com'])).toBe(true);
    expect(siteApproved('badgoogle.com', ['*.google.com'])).toBe(false);
  });
  it('the policy asks for a subdomain the user did not approve', () => {
    const v = evaluate('navigate', { url: 'https://mail.google.com/' }, undefined, S({ allowedSites: ['google.com'] }), fresh());
    expect(v).toMatchObject({ kind: 'ask', approvalKind: 'site', site: 'mail.google.com' });
    expect(evaluate('navigate', { url: 'https://www.google.com/' }, undefined, S({ allowedSites: ['google.com'] }), fresh()).kind).toBe('allow');
    expect(evaluate('navigate', { url: 'https://mail.google.com/' }, undefined, S({ allowedSites: ['*.google.com'] }), fresh()).kind).toBe('allow');
    const read = evaluate('get_page_text', {}, page('mail.google.com'), S({ allowedSites: ['google.com'] }), fresh());
    expect(read).toMatchObject({ kind: 'ask', approvalKind: 'site', site: 'mail.google.com' });
  });
});

describe('local files', () => {
  const file: ActionDescription = { tabId: 'tab-1', url: 'file:///C:/Users/someone/Documents/taxes.html', host: '' };
  it('file: pages count as off limits', () => {
    expect(isRestrictedUrl('file:///etc/passwd')).toBe(true);
    expect(isRestrictedUrl('FILE:///C:/x.txt')).toBe(true);
    expect(isRestrictedUrl('https://example.com/file:///x')).toBe(false);
  });
  it('the policy refuses to read or act on a file: tab in every mode', () => {
    for (const mode of ['ask', 'auto', 'yolo'] as const) {
      for (const m of ['get_page_text', 'read_page', 'screenshot', 'left_click']) {
        expect(evaluate(m, {}, file, S({ permissionMode: mode }), fresh()).kind, `${m} ${mode}`).toBe('deny');
      }
    }
  });
});

describe('pasting the clipboard', () => {
  const auto = S({ permissionMode: 'auto' });
  it('asks before a paste shortcut, wherever the focus is', () => {
    for (const keys of ['ctrl+v', 'cmd+v', 'Control+V', 'ctrl+shift+v', 'shift+Insert', 'a ctrl+v']) {
      const v = evaluate('key', { text: keys }, page('x.com', textbox), auto, fresh());
      expect(v, keys).toMatchObject({ kind: 'ask', approvalKind: 'sensitive', category: 'sensitiveFields' });
    }
  });
  it('does not ask for copy, select-all or a plain "v"', () => {
    for (const keys of ['ctrl+c', 'ctrl+a', 'v', 'shift+v', 'Insert']) {
      expect(evaluate('key', { text: keys }, page('x.com', textbox), auto, fresh()).kind, keys).toBe('allow');
    }
  });
  it('follows the sensitive-fields switch and yolo mode', () => {
    const off = S({ permissionMode: 'auto', confirm: { ...DEFAULT_CONFIRM, sensitiveFields: false } });
    expect(evaluate('key', { text: 'ctrl+v' }, page('x.com', textbox), off, fresh()).kind).toBe('allow');
    expect(evaluate('key', { text: 'ctrl+v' }, page('x.com', textbox), S({ permissionMode: 'yolo' }), fresh()).kind).toBe('allow');
  });
});

describe('consequential buttons in other languages', () => {
  const c = DEFAULT_CONFIRM;
  it('recognises purchases', () => {
    for (const label of ['Jetzt kaufen', 'Zahlungspflichtig bestellen', 'Comprar ahora', 'Finalizar compra', 'Acheter', 'Passer la commande', 'Pagar', 'Acquista ora', 'Afrekenen', '立即购买', '支付', '購入する', '注文を確定する']) {
      expect(categorize(label, c), label).toBe('payments');
    }
  });
  it('recognises sending and posting', () => {
    for (const label of ['Enviar', 'Envoyer', 'Senden', 'Absenden', 'Publicar', 'Veröffentlichen', 'Invia', 'Verzenden', '发送', '送信']) {
      expect(categorize(label, c), label).toBe('messages');
    }
  });
  it('recognises deleting', () => {
    for (const label of ['Löschen', 'Konto löschen', 'Eliminar', 'Supprimer', 'Excluir conta', 'Elimina', 'Verwijderen', '删除', '削除']) {
      expect(categorize(label, c), label).toBe('deletions');
    }
  });
  it('recognises agreeing to terms', () => {
    for (const label of ['Ich stimme zu', "J'accepte", 'Acepto los términos', 'Aceito', 'Accetto', '同意']) {
      expect(categorize(label, c), label).toBe('agreements');
    }
  });
  it('leaves ordinary navigation alone', () => {
    for (const label of ['Weiter', 'Suivant', 'Buscar', 'Zurück', 'Mostrar más', '下一页', '検索', 'Envoy', 'Compras recientes y más']) {
      expect(categorize(label, c), label).toBeUndefined();
    }
  });
  it('a switched-off category stays off', () => {
    expect(categorize('Jetzt kaufen', { ...c, payments: false })).toBeUndefined();
  });
});
