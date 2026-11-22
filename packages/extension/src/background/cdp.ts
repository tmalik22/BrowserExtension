/**
 * chrome.debugger (CDP 1.3) attachment per tab, event routing, network-idle tracking, and
 * console/network buffers for read_console / read_network.
 */
import { checkUrlPolicy, sanitizeUrl, truncate, type UrlPolicy } from '@ba/shared';

/** URL policy per agent tab, enforced on document requests (incl. redirects) while running. */
const tabPolicy = new Map<number, UrlPolicy>();
const tabActive = new Map<number, () => boolean>();
export function setTabPolicy(tabId: number, policy: UrlPolicy, isActive?: () => boolean): void {
  tabPolicy.set(tabId, policy);
  if (isActive) tabActive.set(tabId, isActive);
}

type Listener = (method: string, params: any) => void;

interface TabCdp {
  attached: boolean;
  attaching?: Promise<void>;
  inflight: Map<string, { t: number; type?: string }>;
  lastNetworkActivity: number;
  loading: boolean;
  console: string[];
  network: Map<string, { method: string; url: string; type?: string; status?: number; mime?: string; t0: number; ms?: number; failed?: string }>;
  networkOrder: string[];
  dialog?: { type: string; message: string };
  runtimeEnabled: boolean;
}

const tabs = new Map<number, TabCdp>();
const listeners = new Set<(tabId: number, method: string, params: any) => void>();
let detachHandler: ((tabId: number, reason: string) => void) | null = null;

export const CDP_VERSION = '1.3';

export class CdpError extends Error {}

function state(tabId: number): TabCdp {
  let s = tabs.get(tabId);
  if (!s) {
    s = { attached: false, inflight: new Map(), lastNetworkActivity: 0, loading: false, console: [], network: new Map(), networkOrder: [], runtimeEnabled: false };
    tabs.set(tabId, s);
  }
  return s;
}

export function onCdpEvent(fn: (tabId: number, method: string, params: any) => void): void {
  listeners.add(fn);
}

export function onDetach(fn: (tabId: number, reason: string) => void): void {
  detachHandler = fn;
}

/** Pages extensions may not control. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    /^(chrome|edge|brave|opera|vivaldi|about|devtools|chrome-extension|chrome-search|view-source|chrome-untrusted):/i.test(url) && url !== 'about:blank'
  ) || /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

export async function attach(tabId: number): Promise<void> {
  const s = state(tabId);
  if (s.attached) return;
  if (s.attaching) return s.attaching;
  s.attaching = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      if (!/already attached/i.test(m)) {
        if (/Cannot access|Cannot attach|chrome:\/\//i.test(m)) throw new CdpError(`Error: This page cannot be controlled (${m}). Navigate to a regular website first.`);
        if (/another debugger/i.test(m)) throw new CdpError('Error: Another debugger (e.g. DevTools or another extension) is attached to this tab. Close DevTools on this tab and retry.');
        throw new CdpError(`Error: could not attach to the tab: ${m}`);
      }
    }
    s.attached = true;
    await send(tabId, 'Page.enable');
    await send(tabId, 'Network.enable', { maxPostDataSize: 0 }).catch(() => {});
    // Act in background tabs without stealing the user's focus.
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await send(tabId, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
    // Check every document request (navigations, redirects, same-process iframes) against the
    // URL policy before it is sent, so private/blocked hosts are never fetched with cookies.
    await send(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }).catch(() => {});
    // Attaching shows Chrome's "is debugging this browser" bar, which shrinks the viewport a
    // moment later. Wait for the size to settle so the first screenshot matches later ones.
    await waitViewportStable(tabId);
  })();
  try {
    await s.attaching;
  } finally {
    s.attaching = undefined;
  }
}

async function viewportSize(tabId: number): Promise<string> {
  const m = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics').catch(() => null) as any;
  const v = m?.cssVisualViewport ?? m?.visualViewport;
  return v ? `${Math.round(v.clientWidth)}x${Math.round(v.clientHeight)}` : '';
}

async function waitViewportStable(tabId: number, maxMs = 1200): Promise<void> {
  const t0 = Date.now();
  let last = await viewportSize(tabId);
  let stableSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 75));
    const cur = await viewportSize(tabId);
    if (cur !== last) {
      last = cur;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 300) return;
  }
}

/** Runtime.enable is only turned on when console reading is requested (it is detectable by pages). */
export async function enableConsole(tabId: number): Promise<void> {
  const s = state(tabId);
  if (s.runtimeEnabled) return;
  await attach(tabId);
  await send(tabId, 'Runtime.enable');
  await send(tabId, 'Log.enable').catch(() => {});
  s.runtimeEnabled = true;
}

export async function detach(tabId: number): Promise<void> {
  const s = tabs.get(tabId);
  tabs.delete(tabId);
  if (s?.attached) await chrome.debugger.detach({ tabId }).catch(() => {});
}

export function isAttached(tabId: number): boolean {
  return !!tabs.get(tabId)?.attached;
}

/**
 * Bounding box (CSS px, viewport) of the first iframe whose src matches, piercing closed shadow
 * roots. Content scripts cannot see iframes inside a closed shadow root; the DOM domain can.
 */
export async function iframeRect(tabId: number, re: RegExp): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    const { root } = await send<{ root: any }>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    let found: any;
    const visit = (n: any) => {
      if (found || !n) return;
      if (n.nodeName === 'IFRAME') {
        const attrs: string[] = n.attributes ?? [];
        for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'src' && re.test(attrs[i + 1])) found = n;
      }
      for (const c of n.children ?? []) visit(c);
      for (const r of n.shadowRoots ?? []) visit(r);
      if (n.contentDocument) visit(n.contentDocument);
    };
    visit(root);
    if (!found) return null;
    const model = await send<any>(tabId, 'DOM.getBoxModel', { nodeId: found.nodeId });
    const q: number[] = model.model.border;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  } catch {
    return null;
  }
}

export async function send<T = any>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  const s = state(tabId);
  if (!s.attached && !s.attaching) await attach(tabId);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    if (/not attached|Detached/i.test(m)) {
      s.attached = false;
      await attach(tabId);
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    }
    throw new CdpError(m);
  }
}

// Event routing ---------------------------------------------------------------------------------

const LONG_LIVED = new Set(['WebSocket', 'EventSource', 'Ping']);

function pushConsole(s: TabCdp, line: string): void {
  s.console.push(truncate(line, 600));
  if (s.console.length > 500) s.console.splice(0, s.console.length - 500);
}

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const s = tabs.get(tabId);
  if (!s) return;
  const now = Date.now();
  switch (method) {
    case 'Network.requestWillBeSent': {
      const type = params.type as string | undefined;
      if (!LONG_LIVED.has(type ?? '')) s.inflight.set(params.requestId, { t: now, type });
      s.lastNetworkActivity = now;
      if (!s.network.has(params.requestId)) s.networkOrder.push(params.requestId);
      s.network.set(params.requestId, { method: params.request?.method ?? 'GET', url: params.request?.url ?? '', type, t0: now });
      if (s.networkOrder.length > 500) {
        const old = s.networkOrder.splice(0, s.networkOrder.length - 500);
        old.forEach((id) => s.network.delete(id));
      }
      break;
    }
    case 'Network.responseReceived': {
      const n = s.network.get(params.requestId);
      if (n) {
        n.status = params.response?.status;
        n.mime = params.response?.mimeType;
      }
      break;
    }
    case 'Network.loadingFinished':
    case 'Network.loadingFailed': {
      s.inflight.delete(params.requestId);
      s.lastNetworkActivity = now;
      const n = s.network.get(params.requestId);
      if (n) {
        n.ms = now - n.t0;
        if (method === 'Network.loadingFailed') n.failed = params.errorText ?? 'failed';
      }
      break;
    }
    case 'Page.frameStartedLoading':
      if (params.frameId && !params.parentId) s.loading = true;
      break;
    case 'Page.loadEventFired':
      s.loading = false;
      break;
    case 'Page.frameNavigated':
      if (!params.frame?.parentId) {
        s.inflight.clear();
      }
      break;
    case 'Fetch.requestPaused': {
      const url: string = params.request?.url ?? '';
      const policy = tabPolicy.get(tabId);
      const active = tabActive.get(tabId)?.() ?? true;
      const blocked = policy && active && /^https?:/.test(url) ? checkUrlPolicy(url, policy) : null;
      chrome.debugger
        .sendCommand({ tabId }, blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest', blocked ? { requestId: params.requestId, errorReason: 'BlockedByClient' } : { requestId: params.requestId })
        .catch(() => {});
      if (blocked) pushConsole(s, `[agent] blocked request to ${sanitizeUrl(url, 200)}: ${blocked}`);
      break;
    }
    case 'Page.javascriptDialogOpening':
      s.dialog = { type: params.type, message: params.message };
      break;
    case 'Page.javascriptDialogClosed':
      s.dialog = undefined;
      break;
    case 'Runtime.consoleAPICalled': {
      const args = (params.args ?? []).map((a: any) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(' ');
      pushConsole(s, `[${params.type}] ${args}`);
      break;
    }
    case 'Runtime.exceptionThrown':
      pushConsole(s, `[exception] ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'error'}`);
      break;
    case 'Log.entryAdded':
      pushConsole(s, `[${params.entry?.level}] ${params.entry?.text}${params.entry?.url ? ` (${sanitizeUrl(params.entry.url, 200)})` : ''}`);
      break;
  }
  for (const l of listeners) l(tabId, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  tabs.delete(source.tabId);
  detachHandler?.(source.tabId, reason);
});

// Network idle / dialogs / buffers ------------------------------------------------------------

/** Requests still in flight, ignoring long-polls that have been open for a while. */
export function pendingRequests(tabId: number, longPollMs = 6000): number {
  const s = tabs.get(tabId);
  if (!s) return 0;
  const now = Date.now();
  let n = 0;
  for (const r of s.inflight.values()) if (now - r.t < longPollMs) n++;
  return n;
}

export function lastNetworkActivity(tabId: number): number {
  return tabs.get(tabId)?.lastNetworkActivity ?? 0;
}

export function isLoading(tabId: number): boolean {
  return !!tabs.get(tabId)?.loading;
}

export function openDialog(tabId: number): { type: string; message: string } | undefined {
  return tabs.get(tabId)?.dialog;
}

export function drainConsole(tabId: number): string[] {
  const s = tabs.get(tabId);
  if (!s) return [];
  return s.console.splice(0);
}

export function drainNetwork(tabId: number): string[] {
  const s = tabs.get(tabId);
  if (!s) return [];
  const lines = s.networkOrder.map((id) => {
    const n = s.network.get(id)!;
    const status = n.failed ? `FAILED (${n.failed})` : n.status ?? 'pending';
    return `${n.method} ${sanitizeUrl(n.url, 300)} → ${status}${n.mime ? ` ${n.mime}` : ''}${n.type ? ` [${n.type}]` : ''}${n.ms != null ? ` ${n.ms}ms` : ''}`;
  });
  s.network.clear();
  s.networkOrder = [];
  return lines;
}
