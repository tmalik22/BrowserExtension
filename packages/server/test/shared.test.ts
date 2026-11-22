import { describe, expect, it } from 'vitest';
import {
  BROWSER_MEMBERS,
  checkUrlPolicy,
  hostMatches,
  isPrivateHost,
  isSensitiveField,
  memberSpecs,
  parseNavigateUrl,
  renderResultForText,
  sanitizeTitle,
  sanitizeUrl,
  selectMembers,
  summarizeCall,
  type ToolResult,
} from '@ba/shared';

describe('parseNavigateUrl', () => {
  it('accepts history keywords', () => {
    expect(parseNavigateUrl('back')).toEqual({ kind: 'history', action: 'back' });
    expect(parseNavigateUrl('forward')).toEqual({ kind: 'history', action: 'forward' });
    expect(parseNavigateUrl('reload')).toEqual({ kind: 'history', action: 'reload' });
  });
  it('defaults to https for scheme-less URLs, including host:port', () => {
    expect(parseNavigateUrl('example.com/docs')).toEqual({ kind: 'url', url: 'https://example.com/docs' });
    expect(parseNavigateUrl('localhost:3000/x')).toEqual({ kind: 'url', url: 'https://localhost:3000/x' });
    expect(parseNavigateUrl('  http://a.b/c ')).toEqual({ kind: 'url', url: 'http://a.b/c' });
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'ftp://x.com', 'JAVASCRIPT:alert(1)'])('refuses %s', (u) => {
    const r = parseNavigateUrl(u);
    expect(r.kind).toBe('error');
  });
  it('rejects empty input', () => {
    expect(parseNavigateUrl('').kind).toBe('error');
    expect(parseNavigateUrl(undefined).kind).toBe('error');
  });
});

describe('isPrivateHost', () => {
  it.each(['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.4', '172.31.0.1', '169.254.1.1', '::1', '[::1]', 'fd00::1', 'printer.local', '0.0.0.0', '100.64.0.1'])('%s is private', (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });
  it.each(['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111'])('%s is public', (h) => {
    expect(isPrivateHost(h)).toBe(false);
  });
});

describe('hostMatches / checkUrlPolicy', () => {
  it('matches domains and subdomains only', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('www.example.com', 'example.com')).toBe(true);
    expect(hostMatches('badexample.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com', 'https://example.com/path')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(true);
    expect(hostMatches('localhost', 'localhost:8080')).toBe(true);
  });
  it('enforces blocked sites and private networks', () => {
    const p = { allowPrivateNetworks: false, blockedSites: ['bank.com'] };
    expect(checkUrlPolicy('https://online.bank.com/x', p)).toMatch(/blocked/);
    expect(checkUrlPolicy('http://127.0.0.1:3000', p)).toMatch(/private/);
    expect(checkUrlPolicy('https://example.com', p)).toBeNull();
    expect(checkUrlPolicy('about:blank', p)).toBeNull();
    expect(checkUrlPolicy('file:///c:/x', p)).toMatch(/Only http/);
    expect(checkUrlPolicy('http://127.0.0.1:3000', { ...p, allowPrivateNetworks: true })).toBeNull();
  });
});

describe('sanitizers', () => {
  it('strips control and bidi characters from titles', () => {
    const t = sanitizeTitle('Hello\nWorld\u202e\u0007 \u2028x');
    expect(t).toBe('Hello World x');
  });
  it('redacts credentials in URLs', () => {
    const u = sanitizeUrl('https://user:pw@x.com/cb?code=abc&state=1&access_token=zzz#id_token=qq');
    expect(u).not.toContain('pw');
    expect(u).toContain('code=REDACTED');
    expect(u).toContain('access_token=REDACTED');
    expect(u).toContain('state=1');
    expect(u).toContain('#REDACTED');
  });
  it('detects sensitive fields', () => {
    expect(isSensitiveField(undefined, 'Email', 'password')).toBe(true);
    expect(isSensitiveField('cc-number', 'Number', 'text')).toBe(true);
    expect(isSensitiveField(undefined, 'Credit card number', 'text')).toBe(true);
    expect(isSensitiveField(undefined, 'CVV', 'text')).toBe(true);
    expect(isSensitiveField('email', 'Email address', 'email')).toBe(false);
    expect(isSensitiveField(undefined, 'Search', 'search')).toBe(false);
  });
});

describe('member selection', () => {
  it('has the 31 toolset members', () => {
    expect(BROWSER_MEMBERS.length).toBe(31);
  });
  it('disables optional members by default and honours vision/compact', () => {
    const all = selectMembers({});
    expect(all).not.toContain('javascript_exec');
    expect(all).not.toContain('file_upload');
    expect(all).toContain('screenshot');
    expect(all.length).toBe(27);
    expect(selectMembers({ vision: false })).not.toContain('screenshot');
    expect(selectMembers({ enableOptional: { javascript_exec: true } })).toContain('javascript_exec');
    expect(selectMembers({ toolSet: 'compact' }).length).toBeLessThan(20);
  });
  it('produces JSON schemas with object types', () => {
    for (const s of memberSpecs(selectMembers({ enableOptional: { javascript_exec: true, file_upload: true, read_console: true, read_network: true } }))) {
      expect(s.parameters.type).toBe('object');
      expect(typeof s.description).toBe('string');
    }
  });
});

describe('renderResultForText', () => {
  const tabs = [
    { tab_id: 'tab-1', title: 'Docs "A"', url: 'https://e.com/docs', active: true },
    { tab_id: 'tab-2', title: 'Pricing', url: 'https://e.com/pricing' },
  ];
  it('renders tab-management results like the API', () => {
    const r: ToolResult = { isError: false, content: [{ type: 'browser_state', tabs }] };
    expect(renderResultForText('list_tabs', {}, r, {}).text).toBe(
      'Available tabs:\n  • tab_id tab-1: "Docs \\"A\\"" (https://e.com/docs) (current)\n  • tab_id tab-2: "Pricing" (https://e.com/pricing)',
    );
    expect(renderResultForText('switch_tab', { tab_id: 'tab-2' }, r, {}).text).toBe('Switched to tab tab-2');
    expect(renderResultForText('new_tab', {}, r, {}).text).toMatch(/^Created new tab with tab_id: tab-1, URL: https:\/\/e.com\/docs\. It is now the current tab\.$/);
  });
  it('appends and dedupes the Tab Context footer', () => {
    const r: ToolResult = { isError: false, content: [{ type: 'text', text: 'Clicked element ref_5.' }, { type: 'browser_state', tabs, state_changes: [{ type: 'tab_opened', tab_id: 'tab-2' }] }], executedOn: 'tab-1' };
    const dedupe = {};
    const first = renderResultForText('left_click', {}, r, dedupe).text;
    expect(first).toContain('Tab Context:\n- Executed on tab_id: tab-1');
    expect(first).not.toContain('(current)');
    const second = renderResultForText('left_click', {}, r, dedupe).text;
    expect(second).toBe('Clicked element ref_5.');
  });
  it('renders download events', () => {
    const r: ToolResult = {
      isError: false,
      content: [
        { type: 'text', text: 'Screenshot captured.' },
        { type: 'browser_state', tabs, state_changes: [{ type: 'download_completed', download_id: 'dl-1', url: 'https://e.com/a.csv', size_bytes: 10 }] },
      ],
    };
    expect(renderResultForText('screenshot', {}, r, {}).text).toContain('Download completed with download_id: dl-1, URL: "https://e.com/a.csv". Size: 10 bytes.');
  });
  it('never renders state on errors', () => {
    const r: ToolResult = { isError: true, content: [{ type: 'text', text: 'Error: x' }] };
    expect(renderResultForText('left_click', {}, r, {}).text).toBe('Error: x');
  });
});

describe('summarizeCall', () => {
  it('summarizes common calls', () => {
    expect(summarizeCall('navigate', { url: 'https://x.com' })).toBe('Navigate to https://x.com');
    expect(summarizeCall('left_click', { target: { type: 'ref', ref: 'ref_3' } })).toBe('left click ref_3');
    expect(summarizeCall('left_click', { target: { type: 'coordinate', x: 1, y: 2 } })).toBe('left click (1, 2)');
  });
});
