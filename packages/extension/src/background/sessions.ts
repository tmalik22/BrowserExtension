/**
 * Which tabs belong to which agent session: a Chrome tab group per session, tabs the page opens
 * (target=_blank, window.open) join the session, the session's active tab, browser_state blocks,
 * and download events.
 */
import { checkUrlPolicy, sanitizeTitle, sanitizeUrl, type BrowserStateBlock, type BrowserStateChange, type BrowserTab } from '@ba/shared';
import { attach, detach, isRestrictedUrl, setTabPolicy } from './cdp.ts';
import { frameCall, resetRefs } from './frames.ts';
import { forgetScale } from './screenshot.ts';

export interface AgentSession {
  id: string;
  title: string;
  windowId: number;
  groupId?: number;
  tabs: number[];
  activeTab: number;
  pendingChanges: BrowserStateChange[];
  lastReported: string;
  running: boolean;
  lockUserInput: boolean;
  downloads: Map<number, string>;
}

const sessions = new Map<string, AgentSession>();
let downloadCounter = 0;
let onUserStop: ((sessionId: string) => void) | null = null;

export function setUserStopHandler(fn: (sessionId: string) => void): void {
  onUserStop = fn;
}

export const tabIdStr = (n: number) => `tab-${n}`;

export function parseTabId(s: unknown): number {
  const m = String(s ?? '').match(/^tab-(\d+)$/);
  if (!m) throw new Error(`Error: "${String(s)}" is not a valid tab_id (expected e.g. "tab-123"). Use list_tabs.`);
  return Number(m[1]);
}

export function getSession(id: string): AgentSession {
  const s = sessions.get(id);
  if (!s) throw new Error('Error: this agent session is not active in the browser (it may have been closed). Start a new task.');
  return s;
}

export function sessionForTab(tabId: number): AgentSession | undefined {
  for (const s of sessions.values()) if (s.tabs.includes(tabId)) return s;
  return undefined;
}

export function allSessions(): AgentSession[] {
  return [...sessions.values()];
}

/** Resolve a call's tab_id (or the session's active tab). */
export function resolveTab(s: AgentSession, tabIdInput: unknown): number {
  if (tabIdInput === undefined || tabIdInput === null || tabIdInput === '') return s.activeTab;
  const n = parseTabId(tabIdInput);
  if (!s.tabs.includes(n)) throw new Error(`Error: ${String(tabIdInput)} is not one of this task's tabs. Use list_tabs.`);
  return n;
}

async function ensureGroup(s: AgentSession, tabId: number): Promise<void> {
  try {
    if (s.groupId === undefined) {
      s.groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(s.groupId, { title: `Agent: ${s.title.slice(0, 24)}`, color: 'orange', collapsed: false });
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId: s.groupId });
    }
  } catch {
    /* tab groups are cosmetic (unavailable in some windows, e.g. popups/app windows) */
  }
}

export async function overlay(tabId: number, on: boolean, s?: AgentSession): Promise<void> {
  try {
    await frameCall(tabId, 0, { type: 'ba:overlay', active: on, lock: on && !!s?.lockUserInput, label: 'Agent is working' }, 3000);
  } catch {
    /* restricted pages have no content script */
  }
}

export async function setRunning(s: AgentSession, running: boolean): Promise<void> {
  s.running = running;
  await Promise.all(s.tabs.map((t) => overlay(t, running && t === s.activeTab, s)));
}

export async function beginSession(params: { sessionId: string; tabId?: string; startUrl?: string; title: string; lockUserInput: boolean; urlPolicy: { allowPrivateNetworks: boolean; blockedSites: string[] } }): Promise<{ activeTabId: string; tabs: BrowserTab[] }> {
  let s = sessions.get(params.sessionId);
  if (s) return { activeTabId: tabIdStr(s.activeTab), tabs: await tabEntries(s) };
  let tab: chrome.tabs.Tab | undefined;
  if (params.startUrl) {
    const err = checkUrlPolicy(params.startUrl, params.urlPolicy);
    if (err) throw new Error(err);
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    tab = await chrome.tabs.create({ url: params.startUrl, active: true, windowId: win?.id });
  } else if (params.tabId) {
    tab = await chrome.tabs.get(parseTabId(params.tabId));
  } else {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = t;
  }
  if (!tab?.id) throw new Error('Error: no browser tab to work in.');
  const owner = sessionForTab(tab.id);
  if (owner && owner.id !== params.sessionId) {
    if (owner.running) {
      // Another task is actively driving this tab: give the new task its own tab.
      tab = await chrome.tabs.create({ windowId: tab.windowId, active: true });
    } else {
      // An idle earlier task: the new task takes the tab over (e.g. "New task" in the side panel).
      owner.tabs = owner.tabs.filter((t) => t !== tab!.id);
      if (owner.activeTab === tab.id && owner.tabs.length) owner.activeTab = owner.tabs[owner.tabs.length - 1];
    }
  }
  s = {
    id: params.sessionId,
    title: params.title,
    windowId: tab.windowId,
    tabs: [tab.id!],
    activeTab: tab.id!,
    pendingChanges: [],
    lastReported: '',
    running: true,
    lockUserInput: params.lockUserInput,
    downloads: new Map(),
  };
  sessions.set(s.id, s);
  rememberPolicy(s, params.urlPolicy);
  await ensureGroup(s, tab.id!);
  if (!isRestrictedUrl(tab.url)) {
    await attach(tab.id!).catch(() => {});
    await overlay(tab.id!, true, s);
  }
  const tabs = await tabEntries(s);
  s.lastReported = JSON.stringify(tabs);
  return { activeTabId: tabIdStr(s.activeTab), tabs };
}

export async function endSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  for (const t of s.tabs) {
    await overlay(t, false);
    if (!sessionForTab(t)) await detach(t);
  }
}

export async function addTab(s: AgentSession, tabId: number, opened: boolean): Promise<void> {
  if (!s.tabs.includes(tabId)) s.tabs.push(tabId);
  setTabPolicyLike(s, tabId);
  if (opened) s.pendingChanges.push({ type: 'tab_opened', tab_id: tabIdStr(tabId) });
  await ensureGroup(s, tabId);
}

const sessionPolicy = new Map<string, { allowPrivateNetworks: boolean; blockedSites: string[] }>();
export function rememberPolicy(s: AgentSession, policy: { allowPrivateNetworks: boolean; blockedSites: string[] }): void {
  sessionPolicy.set(s.id, policy);
  for (const t of s.tabs) setTabPolicy(t, policy, () => s.running);
}
function setTabPolicyLike(s: AgentSession, tabId: number): void {
  const p = sessionPolicy.get(s.id);
  if (p) setTabPolicy(tabId, p, () => s.running);
}

export async function setActiveTab(s: AgentSession, tabId: number): Promise<void> {
  if (s.activeTab !== tabId) {
    const prev = s.activeTab;
    s.activeTab = tabId;
    if (s.running) {
      await overlay(prev, false);
      await overlay(tabId, true, s);
    }
  }
}

export async function tabEntries(s: AgentSession): Promise<BrowserTab[]> {
  const out: BrowserTab[] = [];
  for (const id of [...s.tabs]) {
    try {
      const t = await chrome.tabs.get(id);
      out.push({
        tab_id: tabIdStr(id),
        title: sanitizeTitle(t.title || ''),
        url: sanitizeUrl(t.pendingUrl || t.url || 'about:blank'),
        ...(id === s.activeTab ? { active: true } : {}),
      });
    } catch {
      s.tabs = s.tabs.filter((x) => x !== id);
    }
  }
  if (out.length && !out.some((t) => t.active)) {
    out[out.length - 1].active = true;
    s.activeTab = parseTabId(out[out.length - 1].tab_id);
  }
  return out;
}

/**
 * The browser_state block for a successful result: always for tab-management members, otherwise
 * only when the tab inventory changed or there are state changes to report.
 */
export async function stateBlock(s: AgentSession, force: boolean): Promise<BrowserStateBlock | undefined> {
  const tabs = await tabEntries(s);
  const snapshot = JSON.stringify(tabs);
  const changes = s.pendingChanges.filter((c) => c.type !== 'tab_opened' || tabs.some((t) => t.tab_id === c.tab_id));
  if (!force && snapshot === s.lastReported && !changes.length) return undefined;
  s.lastReported = snapshot;
  s.pendingChanges = [];
  // At most one state change per download_id (the latest wins).
  const seen = new Set<string>();
  const dedup: BrowserStateChange[] = [];
  for (const c of [...changes].reverse()) {
    const key = 'download_id' in c ? `d:${c.download_id}` : `t:${c.tab_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.unshift(c);
  }
  const block: BrowserStateBlock = { type: 'browser_state', tabs };
  if (dedup.length) block.state_changes = dedup;
  return block;
}

// Browser events ----------------------------------------------------------------------------------

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null || tab.openerTabId == null) return;
  const s = sessionForTab(tab.openerTabId);
  if (!s) return;
  void (async () => {
    await addTab(s, tab.id!, true);
    // Chrome focuses foreground popups/new tabs: follow it so the agent sees what the user sees.
    if (tab.active) await setActiveTab(s, tab.id!);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetScale(tabId);
  resetRefs(tabId);
  for (const s of sessions.values()) {
    if (!s.tabs.includes(tabId)) continue;
    s.tabs = s.tabs.filter((t) => t !== tabId);
    if (s.activeTab === tabId && s.tabs.length) void setActiveTab(s, s.tabs[s.tabs.length - 1]);
  }
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  resetRefs(d.tabId);
  forgetScale(d.tabId);
  const s = sessionForTab(d.tabId);
  if (s?.running && d.tabId === s.activeTab) {
    // The new document needs the overlay again once its content script is up.
    setTimeout(() => void overlay(d.tabId, s.running && d.tabId === s.activeTab, s), 300);
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'ba:user_stop' && sender.tab?.id != null) {
    const s = sessionForTab(sender.tab.id);
    if (s) onUserStop?.(s.id);
  }
  return false;
});

// Downloads: attribute to the session that is currently running (downloads carry no tab id).
function runningSession(): AgentSession | undefined {
  return [...sessions.values()].find((s) => s.running);
}

chrome.downloads?.onCreated.addListener((item) => {
  const s = runningSession();
  if (!s) return;
  const id = `dl-${++downloadCounter}`;
  s.downloads.set(item.id, id);
  s.pendingChanges.push({ type: 'download_started', download_id: id, url: sanitizeUrl(item.finalUrl || item.url) });
});

chrome.downloads?.onChanged.addListener((delta) => {
  for (const s of sessions.values()) {
    const id = s.downloads.get(delta.id);
    if (!id) continue;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      void chrome.downloads.search({ id: delta.id }).then(([item]) => {
        const url = sanitizeUrl(item?.finalUrl || item?.url || '');
        if (delta.state?.current === 'complete') s.pendingChanges.push({ type: 'download_completed', download_id: id, url, ...(item?.fileSize ? { size_bytes: item.fileSize } : {}) });
        else s.pendingChanges.push({ type: 'download_failed', download_id: id, url, ...(item?.error ? { error: String(item.error) } : {}) });
      });
    }
  }
});
