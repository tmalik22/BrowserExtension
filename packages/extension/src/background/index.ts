/**
 * Service worker entry: wires the server bridge, the executor, sessions/tabs and the side panel.
 */
import { DEFAULT_SETTINGS, newId, type ClientFrame, type ExecuteParams, type GpuStatus, type PolicySettings, type ServerFrame } from '@ba/shared';
import { Bridge } from './bridge.ts';
import { onCdpEvent, onDetach } from './cdp.ts';
import { captchaAction, captchaObserve, describe, execute, onDialogOpened, probeCaptcha } from './executor.ts';
import { addTab, allSessions, beginSession, endSession, getSession, sessionForTab, setActiveTab, setRunning, setUserStopHandler, type AgentSession } from './sessions.ts';

const ports = new Set<chrome.runtime.Port>();
let lastGpu: GpuStatus | undefined;
/** Alerts we've already shown a desktop notification for: id -> "level@since". */
const notified = new Map<string, string>();

async function notifyGpu(gpu: GpuStatus): Promise<void> {
  const live = new Set(gpu.alerts.map((a) => a.id));
  for (const id of [...notified.keys()]) {
    if (!live.has(id)) {
      notified.delete(id);
      void chrome.notifications?.clear(`gpu-${id}`).catch(() => {});
    }
  }
  if (!gpu.alerts.length) return;
  const { gpuNotify } = await chrome.storage.local.get('gpuNotify');
  if (gpuNotify === false) return;
  for (const a of gpu.alerts) {
    const key = `${a.level}@${a.since}`;
    if (notified.get(a.id) === key) continue;
    notified.set(a.id, key);
    try {
      await chrome.notifications.create(`gpu-${a.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/128.png'),
        title: a.level === 'critical' ? 'GPU alert' : 'GPU warning',
        message: a.message,
        priority: a.level === 'critical' ? 2 : 1,
        requireInteraction: a.level === 'critical',
      });
    } catch {
      /* notifications unavailable */
    }
  }
}

function settings(): PolicySettings {
  return bridge.lastState?.settings ?? bridge.hello?.settings ?? DEFAULT_SETTINGS;
}

function broadcast(msg: unknown): void {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {
      ports.delete(p);
    }
  }
}

function connMessage() {
  const cfg = bridge.getConfig();
  return { type: 'conn', state: bridge.state, error: bridge.lastError, serverUrl: cfg?.serverUrl ?? '', hasToken: !!cfg?.token, pairCode: bridge.pairCode, pairConfirmed: bridge.pairConfirmed };
}

async function onRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'session_begin': {
      const st = settings();
      return beginSession({
        sessionId: String(params.sessionId),
        tabId: params.tabId as string | undefined,
        startUrl: params.startUrl as string | undefined,
        title: String(params.title ?? 'Agent'),
        lockUserInput: !!params.lockUserInput,
        urlPolicy: { allowPrivateNetworks: st.allowPrivateNetworks, blockedSites: st.blockedSites },
      });
    }
    case 'execute':
      await resume(String(params.sessionId));
      return execute(params as unknown as ExecuteParams);
    case 'describe':
      await resume(String(params.sessionId));
      return describe(params as any);
    case 'session_end':
      await endSession(String(params.sessionId));
      return { ok: true };
    case 'session_status': {
      try {
        await setRunning(getSession(String(params.sessionId)), !!params.running);
      } catch {
        /* session gone */
      }
      return { ok: true };
    }
    default:
      // The Chrome Web Store build has no CAPTCHA helper: its RPCs don't exist there (the server
      // takes a failed probe as "no challenge"), and the constant lets the bundler drop the code.
      return __BA_STORE__ ? unknownRpc(method) : helperRpc(method, params);
  }
}

function unknownRpc(method: string): never {
  throw new Error(`Unknown RPC method ${method}`);
}

/** RPCs of the CAPTCHA helper (GitHub build only). */
async function helperRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'captcha_probe':
      return probeCaptcha(params as { sessionId: string; tab_id?: string });
    case 'captcha_observe':
      return captchaObserve(params as { sessionId: string; tab_id?: string });
    case 'captcha_action':
      return captchaAction(params as { sessionId: string; tab_id?: string; plan: import('@ba/shared').CaptchaActionPlan });
    default:
      return unknownRpc(method);
  }
}

/**
 * The server only acts for a task that is running. If this side marked the task stopped while
 * the connection was down (see stopAll), a new action means it carried on: show it as working
 * again, with the debugger attached and requests checked.
 */
async function resume(sessionId: string): Promise<void> {
  const s = allSessions().find((x) => x.id === sessionId);
  if (s && !s.running) await setRunning(s, true);
}

/**
 * The connection to the server is gone: nothing can drive the tabs, and no "task finished" will
 * arrive. Let go of them (overlay, input lock, debugger) rather than leaving the user's page
 * locked behind an "Agent is working" pill whose Stop button has nobody to tell.
 */
function stopAll(): void {
  for (const s of allSessions()) if (s.running) void setRunning(s, false).catch(() => {});
}

function stopLocally(s: AgentSession | undefined): void {
  if (s?.running) void setRunning(s, false).catch(() => {});
}

function onFrame(f: ServerFrame): void {
  switch (f.type) {
    case 'hello_ok':
      broadcast({ type: 'hello', profiles: f.profiles, defaultProfileId: f.defaultProfileId, settings: f.settings, serverVersion: f.serverVersion });
      break;
    case 'state':
      broadcast({ type: 'state', sessions: f.sessions, settings: f.settings, profiles: bridge.lastState?.profiles ?? [], defaultProfileId: bridge.lastState?.defaultProfileId, apiKeys: f.apiKeys });
      break;
    case 'gpu':
      lastGpu = f.gpu;
      broadcast({ type: 'gpu', gpu: f.gpu });
      void notifyGpu(f.gpu);
      break;
    case 'agent_event':
      if (f.event.type === 'status') {
        try {
          void setRunning(getSession(f.sessionId), f.event.status !== 'idle');
        } catch {
          /* not begun yet */
        }
      }
      broadcast({ type: 'event', sessionId: f.sessionId, seq: f.seq, event: f.event });
      break;
  }
}

const bridge = new Bridge(onRpc, onFrame, () => {
  if (bridge.state !== 'connected') stopAll();
  broadcast(connMessage());
});

// Side panel ----------------------------------------------------------------------------------

type PanelMsg = { type: string; requestId?: string; [k: string]: any };

async function handlePanel(port: chrome.runtime.Port, msg: PanelMsg): Promise<void> {
  const reply = (ok: boolean, data?: unknown, error?: string) => {
    if (msg.requestId) port.postMessage({ type: 'response', requestId: msg.requestId, ok, data, error });
  };
  try {
    switch (msg.type) {
      case 'panel:init':
        port.postMessage(connMessage());
        if (bridge.hello) port.postMessage({ type: 'hello', profiles: bridge.hello.profiles, defaultProfileId: bridge.hello.defaultProfileId, settings: settings(), serverVersion: bridge.hello.serverVersion });
        if (bridge.lastState) port.postMessage({ type: 'state', sessions: bridge.lastState.sessions, settings: bridge.lastState.settings, profiles: bridge.lastState.profiles, defaultProfileId: bridge.lastState.defaultProfileId, apiKeys: bridge.lastState.apiKeys });
        if (lastGpu) port.postMessage({ type: 'gpu', gpu: lastGpu });
        reply(true);
        break;
      case 'panel:config':
        await bridge.setConfig({ serverUrl: msg.serverUrl, token: msg.token });
        reply(true);
        break;
      case 'panel:pair':
        await bridge.startPairing();
        reply(true);
        break;
      case 'panel:pair_confirm':
        bridge.confirmPairing();
        reply(true);
        break;
      case 'panel:pair_cancel':
        bridge.cancelPairing();
        reply(true);
        break;
      case 'panel:reconnect':
        bridge.disconnect();
        await bridge.connect();
        reply(true);
        break;
      case 'panel:send': {
        let tabId: string | undefined = msg.tabId ? `tab-${Number(msg.tabId)}` : undefined;
        const currentTab = async () => {
          if (tabId) return Number(tabId.slice(4));
          const [t] = await chrome.tabs.query({ active: true, windowId: msg.windowId ?? chrome.windows.WINDOW_ID_CURRENT });
          return t?.id;
        };
        if (!msg.sessionId && !tabId) {
          const id = await currentTab();
          if (id != null) tabId = `tab-${id}`;
        }
        if (msg.sessionId) {
          // Continuing a conversation whose tabs were all closed: carry on in the current tab.
          const s = allSessions().find((x) => x.id === msg.sessionId);
          if (s) {
            const alive = (await Promise.all(s.tabs.map((t) => chrome.tabs.get(t).then(() => true, () => false)))).some(Boolean);
            const id = alive ? undefined : await currentTab();
            if (id != null) {
              s.tabs = [];
              await addTab(s, id, false);
              await setActiveTab(s, id);
            }
          }
        }
        const requestId = newId('r');
        const data = await bridge.request<{ sessionId: string }>({ type: 'send_message', requestId, sessionId: msg.sessionId, text: String(msg.text ?? ''), profileId: msg.profileId, tabId, continueFrom: msg.continueFrom ? String(msg.continueFrom) : undefined } as ClientFrame & { requestId: string });
        reply(true, data);
        break;
      }
      case 'panel:stop':
        bridge.send({ type: 'stop', sessionId: String(msg.sessionId) });
        reply(true);
        break;
      case 'panel:approval':
        bridge.send({ type: 'approval_response', approvalId: String(msg.approvalId), decision: msg.decision });
        reply(true);
        break;
      case 'panel:settings': {
        const requestId = newId('r');
        const data = await bridge.request({ type: 'update_settings', requestId, settings: msg.settings });
        reply(true, data);
        break;
      }
      case 'panel:refresh_models': {
        const data = await bridge.request({ type: 'refresh_models', requestId: newId('r') }, 60_000);
        reply(true, data);
        break;
      }
      case 'panel:apikey': {
        const data = await bridge.request({ type: 'set_api_key', requestId: newId('r'), name: String(msg.name), key: String(msg.key ?? '') });
        reply(true, data);
        break;
      }
      case 'panel:testkey': {
        // One real request per model that uses the key; slow models can take a while.
        const data = await bridge.request({ type: 'test_api_key', requestId: newId('r'), name: String(msg.name) }, 120_000);
        reply(true, data);
        break;
      }
      case 'panel:setmodel': {
        const data = await bridge.request({ type: 'set_profile_model', requestId: newId('r'), profileId: String(msg.profileId), model: String(msg.model) });
        reply(true, data);
        break;
      }
      case 'panel:history': {
        const requestId = newId('r');
        const data = await bridge.request({ type: 'get_history', requestId, sessionId: String(msg.sessionId) });
        reply(true, data);
        break;
      }
      case 'panel:chats': {
        const data = await bridge.request({ type: 'list_chats', requestId: newId('r'), limit: Number(msg.limit) || 50 });
        reply(true, data);
        break;
      }
      case 'panel:end': {
        await endSession(String(msg.sessionId));
        reply(true);
        break;
      }
      default:
        reply(false, undefined, `unknown panel message ${msg.type}`);
    }
  } catch (e) {
    reply(false, undefined, e instanceof Error ? e.message : String(e));
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  // Only our side panel page may connect. Content scripts share our extension id, so also require
  // the side panel's own URL (a content script reports the web page's URL): a compromised renderer
  // could otherwise approve actions or repoint the server URL.
  const url = port.sender?.url ?? '';
  if (port.sender?.id !== chrome.runtime.id || !url.startsWith(chrome.runtime.getURL('sidepanel.html'))) {
    port.disconnect();
    return;
  }
  ports.add(port);
  port.onMessage.addListener((m) => void handlePanel(port, m as PanelMsg));
  port.onDisconnect.addListener(() => ports.delete(port));
});

// Wiring --------------------------------------------------------------------------------------

setUserStopHandler((sessionId) => {
  // Stop always works for the user, even when the server can't be told.
  if (!bridge.send({ type: 'stop', sessionId })) stopLocally(allSessions().find((x) => x.id === sessionId));
});

onCdpEvent((tabId, method, params) => {
  if (method === 'Page.javascriptDialogOpening') onDialogOpened(tabId, params);
});

onDetach((tabId, reason) => {
  // The user clicked "Cancel" on Chrome's debugging infobar: stop that tab's task.
  if (reason === 'canceled_by_user') {
    const s = sessionForTab(tabId);
    if (s) bridge.send({ type: 'stop', sessionId: s.id });
  }
});

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.alarms.create('ba-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ba-keepalive' && (bridge.state === 'disconnected' || bridge.state === 'error')) void bridge.connect();
});

chrome.runtime.onStartup.addListener(() => void bridge.connect());
chrome.runtime.onInstalled.addListener(() => void bridge.connect());
void bridge.loadConfig().then(() => bridge.connect());

// Exposed for tests/debugging from the service worker console.
(globalThis as any).__ba = { bridge, allSessions, onRpc, gpu: () => lastGpu, notified };
