import type { BrowserStateBlock, BrowserTab, ResultBlock, ToolResult } from './protocol.ts';

// ---------------------------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------------------------

export type NavigateTarget =
  | { kind: 'history'; action: 'back' | 'forward' | 'reload' }
  | { kind: 'url'; url: string }
  | { kind: 'error'; message: string };

/** Normalise a navigate `url` argument: history keywords, default https://, http(s) only. */
export function parseNavigateUrl(raw: unknown): NavigateTarget {
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'error', message: 'Error: navigate requires a non-empty url.' };
  const s = raw.trim();
  if (s === 'back' || s === 'forward' || s === 'reload') return { kind: 'history', action: s };
  let candidate = s;
  // No scheme -> https. "host:port/path" parses as scheme "host:", so treat it as scheme-less.
  const schemeMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  const looksLikeHostPort = /^[^\s/:]+:\d+(\/|$)/.test(s);
  if (!schemeMatch || looksLikeHostPort) candidate = 'https://' + s;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { kind: 'error', message: `Error: "${truncate(s, 200)}" is not a valid URL.` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { kind: 'error', message: 'Error: Navigation refused. Only http and https URLs are allowed.' };
  }
  return { kind: 'url', url: u.href };
}

/** True for loopback, link-local, private (RFC1918/ULA) and similar non-public hosts. */
export function isPrivateHost(hostname: string): boolean {
  // Normalise: brackets, trailing dot(s) ("localhost." resolves like "localhost").
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (h.includes(':')) {
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    // IPv4-mapped / IPv4-compatible / NAT64 addresses embed an IPv4 address in the last 32 bits,
    // either dotted ("::ffff:127.0.0.1") or as hex groups ("::ffff:7f00:1").
    const embedded = h.match(/^(?:::ffff:(?:0:)?|::|64:ff9b::)(.+)$/);
    if (embedded) {
      const tail = embedded[1];
      if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateHost(tail) || tail === '0.0.0.0';
      const g = tail.split(':');
      if (g.length === 2 && g.every((x) => /^[0-9a-f]{1,4}$/.test(x))) {
        const hi = parseInt(g[0], 16);
        const lo = parseInt(g[1], 16);
        return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
  }
  return false;
}

/** "example.com" in a site list matches example.com and any subdomain. */
export function hostMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const s = site
    .toLowerCase()
    .trim()
    .replace(/^\*\./, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!s) return false;
  return h === s || h.endsWith('.' + s);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Site key used for per-site approvals (strip "www."). */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

export interface UrlPolicy {
  allowPrivateNetworks: boolean;
  blockedSites: string[];
}

/** Returns an error message when the URL may not be visited, else null. */
export function checkUrlPolicy(url: string, policy: UrlPolicy): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Error: invalid URL.';
  }
  if (u.href === 'about:blank' || u.href === 'about:srcdoc') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Error: Navigation refused. Only http and https URLs are allowed.';
  const host = u.hostname;
  if (policy.blockedSites.some((s) => hostMatches(host, s))) return `Error: ${host} is on the blocked-sites list. Choose a different site.`;
  if (!policy.allowPrivateNetworks && isPrivateHost(host)) {
    return `Error: ${host} is a local/private network address, which is blocked by policy. The user can enable "Allow private networks" in settings.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sanitising page-supplied strings (prompt-injection surface)
// ---------------------------------------------------------------------------------------------

// C0/C1 controls, line/paragraph separators, zero-width and bidi-override characters.
const CONTROL_RANGES: [number, number][] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const CONTROL = new RegExp(
  '[' + CONTROL_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('') + ']',
  'g',
);

export function stripControl(s: string): string {
  return s.replace(CONTROL, ' ');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Titles render into text the model reads: strip control chars, collapse whitespace, cap length. */
export function sanitizeTitle(title: string, max = 200): string {
  return truncate(stripControl(title).replace(/\s+/g, ' ').trim(), max);
}

const SECRET_PARAM =
  /^(access_?token|id_?token|refresh_?token|token|auth|authorization|code|key|api_?key|apikey|secret|client_secret|password|passwd|pwd|sig|signature|session|sessionid|sid|jwt|x-amz-[a-z-]+|x-goog-[a-z-]+|credential|otp)$/i;

/** Redact credential-like query parameters and userinfo from a URL; strip control chars. */
export function sanitizeUrl(url: string, max = 1000): string {
  const clean = stripControl(url).trim();
  try {
    const u = new URL(clean);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    if (/(access_token|id_token|token)=/i.test(u.hash)) u.hash = '#REDACTED';
    return truncate(u.href, max);
  } catch {
    return truncate(clean, max);
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering browser_state the way the Anthropic API does (for other providers + UI)
// ---------------------------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tabLine(t: BrowserTab, markCurrent: boolean): string {
  return `  • tab_id ${t.tab_id}: "${esc(t.title)}" (${t.url})${markCurrent && t.active ? ' (current)' : ''}`;
}

export function renderTabManagement(member: string, input: Record<string, unknown>, block: BrowserStateBlock): string {
  switch (member) {
    case 'switch_tab':
      return `Switched to tab ${String(input.tab_id)}`;
    case 'close_tab':
      return `Closed tab ${String(input.tab_id)}`;
    case 'new_tab': {
      const a = block.tabs.find((t) => t.active);
      return `Created new tab with tab_id: ${a?.tab_id}, URL: ${a?.url}. It is now the current tab.`;
    }
    default:
      return block.tabs.length ? `Available tabs:\n${block.tabs.map((t) => tabLine(t, true)).join('\n')}` : 'No tabs available';
  }
}

export function renderStateChanges(block: BrowserStateBlock): string[] {
  const out: string[] = [];
  for (const c of block.state_changes ?? []) {
    if (c.type === 'download_started') out.push(`Download started with download_id: ${c.download_id}, URL: "${esc(c.url)}".`);
    else if (c.type === 'download_completed')
      out.push(
        `Download completed with download_id: ${c.download_id}, URL: "${esc(c.url)}".${c.path ? ` Saved to "${esc(c.path)}".` : ''}${
          c.size_bytes != null ? ` Size: ${c.size_bytes} bytes.` : ''
        }`,
      );
    else if (c.type === 'download_failed')
      out.push(`Download failed with download_id: ${c.download_id}, URL: "${esc(c.url)}".${c.error ? ` Error: "${esc(c.error)}".` : ''}`);
  }
  return out;
}

export function renderTabContext(block: BrowserStateBlock, executedOn: string | undefined): string {
  const on = executedOn ?? block.tabs.find((t) => t.active)?.tab_id;
  return `Tab Context:\n- Executed on tab_id: ${on}\n- Available tabs:\n${block.tabs.map((t) => tabLine(t, false)).join('\n')}`;
}

/**
 * Flatten a tool result into text + images for providers that don't understand browser_state.
 * `dedupe.lastTabContext` suppresses repeated identical Tab Context footers like the Anthropic API.
 */
export function renderResultForText(
  member: string,
  input: Record<string, unknown>,
  result: ToolResult,
  dedupe: { lastTabContext?: string },
): { text: string; images: Extract<ResultBlock, { type: 'image' }>[] } {
  const images = result.content.filter((b): b is Extract<ResultBlock, { type: 'image' }> => b.type === 'image');
  const texts = result.content.filter((b): b is Extract<ResultBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text);
  const state = result.content.find((b): b is BrowserStateBlock => b.type === 'browser_state');
  if (state && !result.isError && ['new_tab', 'list_tabs', 'switch_tab', 'close_tab'].includes(member)) {
    const lines = [renderTabManagement(member, input, state), ...renderStateChanges(state)];
    return { text: lines.join('\n\n'), images };
  }
  let text = texts.join('\n');
  if (state && !result.isError) {
    const changes = renderStateChanges(state);
    if (changes.length) text = [text, changes.join('\n')].filter(Boolean).join('\n\n');
    if (member !== 'zoom' && text && state.tabs.length) {
      const ctx = renderTabContext(state, result.executedOn);
      if (ctx !== dedupe.lastTabContext) {
        text += `\n\n${ctx}`;
        dedupe.lastTabContext = ctx;
      }
    }
  }
  if (!text) text = images.length ? 'Screenshot captured.' : 'Done.';
  return { text, images };
}

/** One-line human summary of a member call, for the UI. */
export function summarizeCall(member: string, input: Record<string, unknown>): string {
  const t = input.target as { type?: string; ref?: string; x?: number; y?: number } | undefined;
  const where = t ? (t.type === 'ref' ? t.ref : `(${t.x}, ${t.y})`) : '';
  switch (member) {
    case 'navigate':
      return `Navigate to ${String(input.url)}`;
    case 'type':
      return `Type "${truncate(String(input.text ?? ''), 60)}"`;
    case 'key':
      return `Press ${String(input.text)}${input.repeat ? ` ×${input.repeat}` : ''}`;
    case 'find':
      return `Find "${truncate(String(input.query ?? ''), 60)}"`;
    case 'form_input':
      return `Set ${where} to ${truncate(JSON.stringify(input.value), 60)}`;
    case 'scroll':
      return `Scroll ${String(input.scroll_direction)} ${input.scroll_amount ?? 3}`;
    case 'read_page':
      return `Read page${input.filter ? ` (${input.filter})` : ''}`;
    case 'wait':
      return `Wait ${input.duration}s`;
    case 'switch_tab':
      return `Switch to ${String(input.tab_id)}`;
    case 'close_tab':
      return `Close ${String(input.tab_id)}`;
    case 'javascript_exec':
      return 'Run JavaScript';
    default:
      return `${member.replace(/_/g, ' ')}${where ? ' ' + where : ''}`;
  }
}

export function newId(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${r}` : r;
}

// ---------------------------------------------------------------------------------------------
// Sensitive fields (shared by the extension's describe step and the server policy)
// ---------------------------------------------------------------------------------------------

const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;
const SENSITIVE_NAME = /(password|passcode|card ?number|credit ?card|cvv|cvc|security code|ssn|social security|iban|routing number|account number|\bpin\b)/i;

export function isSensitiveField(autocomplete: string | undefined, name: string, inputType: string | undefined): boolean {
  if (inputType === 'password') return true;
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.test(autocomplete.trim())) return true;
  return SENSITIVE_NAME.test(name);
}
