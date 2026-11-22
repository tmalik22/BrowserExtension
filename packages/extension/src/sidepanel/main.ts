/**
 * Side panel: chat with the agent, live tool activity, approvals, and settings.
 * All model/page-derived text is rendered with textContent / DOM nodes (never as HTML).
 */
import { CONFIRM_CATEGORIES, DEFAULT_CONFIRM, SERVER_DOWNLOAD_URL, type AgentEvent, type ApiKeyInfo, type ConfirmSettings, type PolicySettings, type ProfileInfo, type SessionSummary } from '@ba/shared';
import { initKeys, renderKeys } from './keys.ts';
import { initModelPicker } from './model-picker.ts';
import { initGpu, renderGpu } from './gpu.ts';
import { fillRecent, initHistory, showHistoryList } from './history.ts';

// ---------------------------------------------------------------------------------------------
// Port to the service worker
// ---------------------------------------------------------------------------------------------

let port: chrome.runtime.Port;
let reqN = 0;
const pending = new Map<string, { resolve(v: any): void; reject(e: Error): void }>();

function connectPort(): void {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // The service worker restarted: reconnect and re-sync.
    setTimeout(() => {
      connectPort();
      void init();
    }, 300);
  });
}

function request<T = any>(msg: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const requestId = `p${++reqN}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    port.postMessage({ ...msg, requestId });
    setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error('No response from the extension.'));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const state = {
  conn: 'connecting',
  connError: '',
  serverUrl: '',
  hasToken: false,
  pairCode: '',
  pairConfirmed: false,
  profiles: [] as ProfileInfo[],
  apiKeys: undefined as ApiKeyInfo[] | undefined,
  defaultProfileId: '',
  settings: null as PolicySettings | null,
  sessions: [] as SessionSummary[],
  sessionId: '' as string,
  /** A saved chat being viewed (not in the server's memory); sending carries it on in a new chat. */
  archivedId: '' as string,
  windowId: chrome.windows.WINDOW_ID_CURRENT as number,
  lastSeq: 0,
  running: false,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const messages = $('messages');
const input = $<HTMLTextAreaElement>('input');
const modelSel = $<HTMLSelectElement>('model');
const picker = initModelPicker({
  select: modelSel,
  profiles: () => chatProfiles(),
  refresh: async () => {
    await request({ type: 'panel:refresh_models' }, 60_000).catch(() => {});
  },
  openSettings: () => showSettings(true),
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function scrollDown(): void {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160;
  if (nearBottom) messages.scrollTop = messages.scrollHeight;
}

// ---------------------------------------------------------------------------------------------
// Safe markdown-lite rendering
// ---------------------------------------------------------------------------------------------

function inline(text: string, parent: HTMLElement): void {
  // Links: https only, and the real destination is always visible (no text/URL mismatch tricks).
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https:\/\/[^\s)]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parent.append(text.slice(last, m.index));
    if (m[1]) parent.append(el('code', undefined, m[1].slice(1, -1)));
    else if (m[2]) parent.append(el('strong', undefined, m[2].slice(2, -2)));
    else if (m[3]) {
      const label = m[3].slice(1, m[3].indexOf(']'));
      const a = el('a', undefined, label);
      a.href = m[4];
      a.title = m[4];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.append(a);
      let host = '';
      try {
        host = new URL(m[4]).hostname;
      } catch {
        /* the regex only admits https URLs */
      }
      if (host && !label.toLowerCase().includes(host.toLowerCase())) parent.append(el('span', 'link-host', ` (${host})`));
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(md: string, target: HTMLElement): void {
  target.replaceChildren();
  const blocks = md.split(/\n```/);
  // Alternate: text, code, text, code...
  const parts: { code: boolean; text: string }[] = [];
  let rest = md;
  while (rest.length) {
    const i = rest.indexOf('```');
    if (i === -1) {
      parts.push({ code: false, text: rest });
      break;
    }
    parts.push({ code: false, text: rest.slice(0, i) });
    const j = rest.indexOf('```', i + 3);
    const body = j === -1 ? rest.slice(i + 3) : rest.slice(i + 3, j);
    parts.push({ code: true, text: body.replace(/^[^\n]*\n/, '') });
    rest = j === -1 ? '' : rest.slice(j + 3);
  }
  void blocks;
  for (const p of parts) {
    if (p.code) {
      const pre = el('pre');
      pre.append(el('code', undefined, p.text.replace(/\n$/, '')));
      target.append(pre);
      continue;
    }
    for (const para of p.text.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      const lines = t.split('\n');
      if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
        const ul = el('ul');
        for (const l of lines) {
          const li = el('li');
          inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''), li);
          ul.append(li);
        }
        target.append(ul);
      } else {
        const pEl = el('p');
        lines.forEach((l, i) => {
          if (i) pEl.append(el('br'));
          inline(l.replace(/^#{1,6}\s+/, ''), pEl);
        });
        target.append(pEl);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Event rendering
// ---------------------------------------------------------------------------------------------

let streamEl: HTMLElement | null = null;
let streamText = '';
let thinkingEl: HTMLDetailsElement | null = null;
let thinkingText = '';
let toolGroup: HTMLElement | null = null;
const toolRows = new Map<string, HTMLDetailsElement>();
const approvalCards = new Map<string, HTMLElement>();

function clearMessages(): void {
  messages.replaceChildren();
  streamEl = null;
  streamText = '';
  thinkingEl = null;
  thinkingText = '';
  toolGroup = null;
  toolRows.clear();
  approvalCards.clear();
}

function showEmpty(): void {
  const box = el('div', 'empty');
  box.append(el('h2', undefined, 'What can I do for you?'));
  box.append(el('div', undefined, 'I work in this tab: reading pages, clicking, typing and filling forms. You stay in control of anything risky.'));
  const sug = el('div', 'suggestions');
  for (const s of ['Summarize this page', 'Find the contact email on this site', 'Fill in this form with test data and show me before submitting']) {
    const b = el('button', undefined, s);
    b.type = 'button';
    b.onclick = () => {
      input.value = s;
      input.focus();
    };
    sug.append(b);
  }
  box.append(sug);
  messages.append(box);
  if (state.conn === 'connected') void fillRecent(box, () => showView('history'));
}

function endStream(): void {
  streamEl = null;
  streamText = '';
}

function endThinking(): void {
  thinkingEl = null;
  thinkingText = '';
}

function ensureToolGroup(): HTMLElement {
  if (!toolGroup) {
    toolGroup = el('div', 'tools-group');
    messages.append(toolGroup);
  }
  return toolGroup;
}

function lightbox(src: string): void {
  const lb = el('div', 'lightbox');
  const img = el('img');
  img.src = src;
  lb.append(img);
  lb.onclick = () => lb.remove();
  document.body.append(lb);
}

function renderEvent(ev: AgentEvent, live: boolean): void {
  messages.querySelector('.empty')?.remove();
  switch (ev.type) {
    case 'user_message': {
      endStream();
      endThinking();
      toolGroup = null;
      messages.append(el('div', 'msg user', ev.text));
      break;
    }
    case 'thinking_delta': {
      if (!thinkingEl) {
        thinkingEl = el('details', 'thinking');
        thinkingEl.append(el('summary', undefined, 'Thinking…'), el('div'));
        messages.append(thinkingEl);
        toolGroup = null;
      }
      thinkingText += ev.text;
      (thinkingEl.lastChild as HTMLElement).textContent = thinkingText;
      break;
    }
    case 'thinking': {
      if (thinkingEl) {
        (thinkingEl.lastChild as HTMLElement).textContent = ev.text;
        (thinkingEl.firstChild as HTMLElement).textContent = 'Thought process';
      } else {
        const d = el('details', 'thinking');
        d.append(el('summary', undefined, 'Thought process'), el('div', undefined, ev.text));
        messages.append(d);
        toolGroup = null;
      }
      endThinking();
      break;
    }
    case 'text_delta': {
      if (!streamEl) {
        streamEl = el('div', 'msg assistant');
        messages.append(streamEl);
        toolGroup = null;
      }
      streamText += ev.text;
      renderMarkdown(streamText, streamEl);
      break;
    }
    case 'text': {
      if (streamEl) renderMarkdown(ev.text, streamEl);
      else {
        const m = el('div', 'msg assistant');
        renderMarkdown(ev.text, m);
        messages.append(m);
      }
      endStream();
      toolGroup = null;
      break;
    }
    case 'tool_call': {
      endStream();
      endThinking();
      const row = el('details', 'tool');
      const sum = el('summary');
      sum.append(el('span', 'st run'), el('span', 'label', ev.summary));
      row.append(sum, el('div', 'body'));
      ensureToolGroup().append(row);
      toolRows.set(ev.callId, row);
      break;
    }
    case 'tool_result': {
      const row = toolRows.get(ev.callId);
      if (!row) break;
      const st = row.querySelector('.st')!;
      st.className = `st ${ev.isError ? 'err' : 'ok'}`;
      // "left click ref_4" → 'Clicked button "Place order"' once we know what the ref was.
      const label = row.querySelector('.label')!;
      const m = !ev.isError && ev.text.match(/^((?:Double-|Triple-|Right-|Middle-)?[Cc]licked|Hovered over|Scrolled) element ref_\d+ \(([^)]*)\)/);
      if (m) label.textContent = `${m[1]} ${m[2]}`.slice(0, 120);
      const body = row.querySelector('.body') as HTMLElement;
      body.replaceChildren();
      if (ev.text) body.append(el('pre', undefined, ev.text));
      if (ev.image) {
        const img = el('img');
        img.src = `data:${ev.image.mediaType};base64,${ev.image.data}`;
        img.alt = 'Screenshot';
        img.onclick = (e) => {
          e.preventDefault();
          lightbox(img.src);
        };
        body.append(img);
      }
      if (ev.isError) row.open = false;
      break;
    }
    case 'approval_request': {
      endStream();
      toolGroup = null;
      const card = el('div', 'approval');
      card.append(el('div', 'reason', ev.reason), el('div', 'summary', ev.summary));
      const row = el('div', 'row');
      const mk = (label: string, cls: string, decision: 'allow_once' | 'allow_site' | 'deny') => {
        const b = el('button', `btn ${cls}`, label);
        b.type = 'button';
        b.onclick = () => {
          row.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = true));
          void request({ type: 'panel:approval', approvalId: ev.approvalId, decision });
        };
        row.append(b);
      };
      if (ev.kind === 'site') {
        mk('Allow this task', 'primary', 'allow_once');
        mk(`Always allow ${ev.site ?? 'site'}`, '', 'allow_site');
      } else {
        mk('Allow', 'primary', 'allow_once');
      }
      mk('Deny', '', 'deny');
      card.append(row);
      messages.append(card);
      approvalCards.set(ev.approvalId, card);
      break;
    }
    case 'approval_resolved': {
      const card = approvalCards.get(ev.approvalId);
      if (card) {
        card.classList.add('resolved');
        card.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = true));
        const label = ev.decision === 'deny' ? 'Denied' : ev.decision === 'allow_site' ? 'Always allowed' : 'Allowed';
        card.querySelector('.row')?.replaceChildren(el('span', 'muted', label));
      }
      break;
    }
    case 'notice':
      messages.append(el('div', `notice ${ev.level}`, ev.message));
      break;
    case 'status':
      setRunning(ev.status !== 'idle', ev.status === 'waiting_approval' ? 'Waiting for your approval…' : ev.status === 'stopping' ? 'Stopping…' : `Working · step ${ev.step + 1}`);
      break;
    case 'usage': {
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
      const total = `${k(ev.inputTokens + ev.cacheReadTokens + ev.cacheWriteTokens)} in · ${k(ev.outputTokens)} out`;
      const u = $('usage');
      if (ev.contextTokens && ev.contextWindow) {
        const pct = Math.round((ev.contextTokens / ev.contextWindow) * 100);
        u.textContent = `context ${k(ev.contextTokens)}/${k(ev.contextWindow)}`;
        u.title = `This chat uses ${pct}% of the model's context window. Old steps are trimmed automatically when it gets full.\nTotal processed in this chat: ${total}`;
        u.classList.toggle('high', pct >= 80);
      } else {
        u.textContent = total;
        u.title = 'Tokens processed in this chat (all requests added up)';
      }
      break;
    }
    case 'turn_done':
      endStream();
      endThinking();
      toolGroup = null;
      setRunning(false);
      if (ev.reason === 'stopped') messages.append(el('div', 'notice', 'Stopped.'));
      break;
    case 'session_started':
      break;
  }
  if (live) scrollDown();
}

function setRunning(running: boolean, label = 'Working…'): void {
  state.running = running;
  $('status').classList.toggle('hidden', !running);
  $('status-text').textContent = label;
  $('btn-stop').classList.toggle('hidden', !running);
  input.placeholder = running ? 'Add a message for the agent (it reads it at its next step)…' : 'What should I do in this tab?';
}

// ---------------------------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------------------------

function onMessage(msg: any): void {
  switch (msg.type) {
    case 'response': {
      const p = pending.get(msg.requestId);
      if (p) {
        pending.delete(msg.requestId);
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
      }
      break;
    }
    case 'conn':
      state.conn = msg.state;
      state.connError = msg.error;
      state.serverUrl = msg.serverUrl;
      state.hasToken = msg.hasToken;
      state.pairCode = msg.pairCode ?? '';
      state.pairConfirmed = !!msg.pairConfirmed;
      renderConn();
      break;
    case 'gpu':
      renderGpu(msg.gpu);
      break;
    case 'hello':
      state.profiles = msg.profiles;
      state.defaultProfileId = msg.defaultProfileId;
      state.settings = msg.settings;
      renderProfiles();
      void restoreSession();
      break;
    case 'state':
      state.sessions = msg.sessions;
      state.settings = msg.settings;
      state.profiles = msg.profiles ?? state.profiles;
      if (msg.defaultProfileId) state.defaultProfileId = msg.defaultProfileId;
      if (msg.apiKeys) state.apiKeys = msg.apiKeys;
      renderProfiles();
      renderKeys(state.apiKeys);
      if (!$('view-settings').classList.contains('hidden')) {
        /* keep the user's unsaved edits */
      }
      break;
    case 'event':
      if (msg.sessionId !== state.sessionId) {
        // A session started from this panel before its id came back.
        if (!state.sessionId && msg.event.type === 'user_message') setSession(msg.sessionId);
        else return;
      }
      if (msg.seq <= state.lastSeq) return;
      state.lastSeq = msg.seq;
      renderEvent(msg.event, true);
      break;
  }
}

/** First-run / offline guide shown in the chat view instead of an error. */
function renderSetup(): void {
  const box = $('setup');
  const offline = state.conn === 'disconnected';
  const needsToken = state.conn === 'unconfigured';
  const pairing = state.conn === 'pairing';
  box.classList.toggle('hidden', !offline && !needsToken && !pairing);
  if (!offline && !needsToken && !pairing) return;
  const link = (text: string, href: string) => {
    const a = el('a', undefined, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };
  const step = (...parts: (string | Node)[]) => {
    const li = el('li');
    li.append(...parts);
    return li;
  };
  const btn = (text: string, primary: boolean, onclick: () => void) => {
    const b = el('button', primary ? 'btn primary' : 'btn', text);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  };
  const row = el('div', 'row');
  if (offline) {
    const steps = el('ol');
    steps.append(
      step(link('Download the Browser Agent server', SERVER_DOWNLOAD_URL), ' and unzip it.'),
      step('Run ', el('code', undefined, 'Start Browser Agent.cmd'), ' (Windows) or ', el('code', undefined, './start.sh'), ' (macOS/Linux). It needs ', link('Node.js 20+', 'https://nodejs.org/'), '.'),
      step('Keep its window open. This panel connects by itself.'),
    );
    row.append(
      btn('Retry now', true, () => void request({ type: state.hasToken ? 'panel:reconnect' : 'panel:pair' }).catch(() => {})),
      btn('Settings', false, () => showSettings(true)),
    );
    box.replaceChildren(
      el('h2', undefined, 'Start the agent server'),
      el('p', undefined, 'Browser Agent runs your model through a small server on this computer, so your keys and pages stay local.'),
      steps,
      row,
      el('div', 'status-line', state.connError || `Looking for the server at ${state.serverUrl}…`),
    );
  } else if (pairing) {
    if (!state.pairCode) {
      box.replaceChildren(el('h2', undefined, 'Pairing…'), el('p', undefined, 'Talking to the server…'));
      return;
    }
    const code = el('div', 'pair-code', state.pairCode);
    code.setAttribute('aria-label', `Pairing code ${state.pairCode.split('').join(' ')}`);
    if (!state.pairConfirmed) {
      row.append(
        btn('Codes match', true, () => void request({ type: 'panel:pair_confirm' }).catch(() => {})),
        btn('Cancel', false, () => void request({ type: 'panel:pair_cancel' }).catch(() => {})),
      );
      box.replaceChildren(
        el('h2', undefined, 'Check the pairing code'),
        el('p', undefined, 'Does the Browser Agent server window you started yourself show this same code? Only continue if it does.'),
        code,
        row,
      );
    } else {
      row.append(btn('Cancel', false, () => void request({ type: 'panel:pair_cancel' }).catch(() => {})));
      box.replaceChildren(
        el('h2', undefined, 'Almost there'),
        el('p', undefined, 'Now type y in the server window and press Enter to finish pairing.'),
        code,
        row,
      );
    }
  } else {
    const steps = el('ol');
    steps.append(
      step(link('Download and start the Browser Agent server', SERVER_DOWNLOAD_URL), ' if it isn’t running yet.'),
      step('Click ', el('strong', undefined, 'Pair this browser'), ' and compare the code with the server window.'),
    );
    row.append(
      btn('Pair this browser', true, () => void request({ type: 'panel:pair' }).catch(() => {})),
      btn('Paste a token', false, () => showSettings(true)),
    );
    const parts: Node[] = [el('h2', undefined, 'Connect to your server'), steps, row];
    if (state.connError) parts.push(el('div', 'status-line', state.connError));
    box.replaceChildren(...parts);
  }
}

function renderConn(): void {
  const c = $('conn');
  c.className = `conn ${state.conn}`;
  const labels: Record<string, string> = { connected: 'Connected', connecting: 'Connecting…', pairing: 'Pairing…', disconnected: 'Offline', error: 'Error', unconfigured: 'Not paired' };
  c.querySelector('.conn-label')!.textContent = labels[state.conn] ?? state.conn;
  c.title = state.connError || `Agent server: ${state.serverUrl}`;
  const banner = $('banner');
  renderSetup();
  // "Server not running" and "needs a token" get the setup card; real errors get the banner.
  if (state.conn !== 'error') banner.classList.add('hidden');
  else {
    banner.classList.remove('hidden');
    banner.replaceChildren(el('span', undefined, state.connError || 'Not connected to the agent server.'));
    const b = el('button', 'btn', 'Settings');
    b.type = 'button';
    b.onclick = () => showSettings(true);
    const again = el('button', 'btn', 'Pair again');
    again.type = 'button';
    again.onclick = () => void request({ type: 'panel:pair' }).catch(() => {});
    banner.append(again, b);
  }
  $('conn-detail').textContent = state.conn === 'connected' ? 'Connected.' : state.connError;
  $<HTMLButtonElement>('btn-send').disabled = state.conn !== 'connected';
}

/** Models that can run a task (dedicated CAPTCHA solvers are only offered as the CAPTCHA helper). */
function chatProfiles(): typeof state.profiles {
  return state.profiles.filter((p) => !p.captchaSolver);
}

function renderProfiles(): void {
  const current = modelSel.value || localStorage.getItem('profile') || state.defaultProfileId;
  modelSel.replaceChildren();
  const profiles = chatProfiles();
  for (const p of profiles) {
    const o = el('option', undefined, `${p.label}${p.available ? '' : ' (unavailable)'}`);
    o.value = p.id;
    o.disabled = !p.available;
    o.title = p.unavailableReason ?? `${p.provider} · ${p.model}${p.vision ? '' : ' · no vision'}`;
    modelSel.append(o);
  }
  const pick = profiles.find((p) => p.id === current && p.available) ?? profiles.find((p) => p.id === state.defaultProfileId) ?? profiles.find((p) => p.available);
  if (pick) modelSel.value = pick.id;
  picker.render();
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

async function sessionKey(): Promise<string> {
  const w = await chrome.windows.getCurrent();
  state.windowId = w.id ?? state.windowId;
  return `session:${state.windowId}`;
}

function setSession(id: string): void {
  state.sessionId = id;
  state.lastSeq = 0;
  void sessionKey().then((k) => chrome.storage.session.set({ [k]: id }));
}

/** Set once the user sends something; a slower restore must not overwrite what they started. */
let userActed = false;

async function restoreSession(): Promise<void> {
  if (userActed) return;
  const k = await sessionKey();
  const id = (await chrome.storage.session.get(k))[k] as string | undefined;
  if (!id || id === state.sessionId || id === state.archivedId) {
    if (!state.sessionId) {
      clearMessages();
      showEmpty();
    }
    return;
  }
  try {
    await loadChat(id, () => userActed);
  } catch {
    // The chat is gone (not in memory and not saved): start fresh.
    await chrome.storage.session.remove(k);
    state.sessionId = '';
    setArchived('');
    clearMessages();
    showEmpty();
  }
}

/** Show a chat: a live one carries on as is, a saved one carries on in a new chat. */
async function loadChat(id: string, cancelled: () => boolean = () => false): Promise<void> {
  const h = await request<{ events: { seq: number; event: AgentEvent }[]; status: string; archived?: boolean }>({ type: 'panel:history', sessionId: id }, 60_000);
  if (cancelled()) return;
  clearMessages();
  $('usage').textContent = '';
  state.sessionId = h.archived ? '' : id;
  state.lastSeq = 0;
  setArchived(h.archived ? id : '');
  for (const x of h.events) {
    renderEvent(x.event, false);
    if (x.seq) state.lastSeq = x.seq;
  }
  endStream();
  endThinking();
  toolGroup = null;
  setRunning(h.status !== 'idle');
  messages.scrollTop = messages.scrollHeight;
  void sessionKey().then((k) => chrome.storage.session.set({ [k]: id }));
}

function setArchived(id: string): void {
  state.archivedId = id;
  $('archived-note').classList.toggle('hidden', !id);
}

async function openChat(id: string): Promise<void> {
  if (id === state.sessionId || id === state.archivedId) {
    showView('chat');
    return;
  }
  if (state.running && !confirm('The agent is still working on this chat. Switch anyway? (It keeps running; you can come back to it from History.)')) return;
  userActed = true;
  showView('chat');
  try {
    await loadChat(id);
  } catch (e) {
    messages.append(el('div', 'notice error', `Couldn't open that chat: ${(e as Error).message}`));
  }
}

function newTask(): void {
  state.sessionId = '';
  setArchived('');
  state.lastSeq = 0;
  setRunning(false);
  void sessionKey().then((k) => chrome.storage.session.remove(k));
  clearMessages();
  showEmpty();
  $('usage').textContent = '';
  input.focus();
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text) return;
  if (state.conn !== 'connected') {
    showSettings(true);
    return;
  }
  localStorage.setItem('profile', modelSel.value);
  input.value = '';
  userActed = true;
  if (state.running && state.sessionId) {
    // A message while the agent works: delivered at its next step.
    try {
      await request({ type: 'panel:send', text, sessionId: state.sessionId, windowId: state.windowId });
    } catch (e) {
      input.value = text;
      messages.append(el('div', 'notice error', (e as Error).message));
    }
    return;
  }
  setRunning(true, 'Starting…');
  try {
    const forcedTab = new URLSearchParams(location.search).get('tabId') ?? undefined;
    const continueFrom = !state.sessionId && state.archivedId ? state.archivedId : undefined;
    const r = await request<{ sessionId: string }>({ type: 'panel:send', text, profileId: modelSel.value, sessionId: state.sessionId || undefined, windowId: state.windowId, tabId: forcedTab, continueFrom });
    if (continueFrom) setArchived('');
    if (r.sessionId !== state.sessionId) setSession(r.sessionId);
  } catch (e) {
    setRunning(false);
    input.value = text;
    messages.querySelector('.empty')?.remove();
    messages.append(el('div', 'notice error', (e as Error).message));
    scrollDown();
  }
}

// ---------------------------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------------------------

function showView(view: 'chat' | 'settings' | 'history'): void {
  for (const v of ['chat', 'settings', 'history']) $(`view-${v}`).classList.toggle('hidden', v !== view);
  if (view === 'settings') fillSettings();
  if (view === 'history') {
    void showHistoryList();
    $('chat-search').focus();
  }
}

function showSettings(on: boolean): void {
  showView(on ? 'settings' : 'chat');
}

/** One checkbox per confirmation category ("Ask me before…"). */
function renderConfirmList(confirm: ConfirmSettings, disabled: boolean): void {
  const list = $('confirm-list');
  list.replaceChildren();
  for (const c of CONFIRM_CATEGORIES) {
    const label = el('label', 'check');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `set-confirm-${c.id}`;
    box.dataset.category = c.id;
    box.checked = confirm[c.id] !== false;
    box.disabled = disabled;
    const text = el('span', 'confirm-text');
    text.append(el('span', undefined, c.label), el('span', 'confirm-hint', c.hint));
    label.append(box, text);
    list.append(label);
  }
}

function readConfirmList(): ConfirmSettings {
  const out: ConfirmSettings = { ...DEFAULT_CONFIRM };
  for (const c of CONFIRM_CATEGORIES) out[c.id] = $<HTMLInputElement>(`set-confirm-${c.id}`).checked;
  return out;
}

function setAllConfirm(on: boolean): void {
  for (const c of CONFIRM_CATEGORIES) $<HTMLInputElement>(`set-confirm-${c.id}`).checked = on;
}

function fillSettings(): void {
  $<HTMLInputElement>('set-url').value = state.serverUrl;
  $<HTMLInputElement>('set-token').value = '';
  $<HTMLInputElement>('set-token').placeholder = state.hasToken ? '•••••••• (saved — paste to replace)' : 'Printed by the server on startup';
  const s = state.settings;
  const disabled = !s;
  renderConfirmList(s?.confirm ?? DEFAULT_CONFIRM, disabled);
  for (const id of ['set-mode', 'set-blocked', 'set-private', 'set-maxsteps', 'set-autoshot', 'set-lock', 'btn-confirm-all', 'btn-confirm-none', 'set-js', 'set-upload', 'set-console', 'set-network', 'btn-save-settings']) {
    ($(id) as HTMLInputElement).disabled = disabled;
  }
  if (!s) {
    $('settings-msg').textContent = 'Connect to the server to edit settings.';
    return;
  }
  $('settings-msg').textContent = '';
  const helperSel = $<HTMLSelectElement>('set-captcha-helper');
  helperSel.replaceChildren(new Option('Off', ''));
  // CaptchaKraken-style solvers are what the helper is built and tested for; any other vision
  // model is offered as an experimental fallback.
  const helpers = state.profiles.filter((p) => p.provider !== 'mock' && p.vision && p.available);
  const solvers = helpers.filter((p) => p.captchaSolver);
  const others = helpers.filter((p) => !p.captchaSolver);
  const addGroup = (label: string, list: typeof helpers) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const p of list) g.append(new Option(p.label, p.id));
    helperSel.append(g);
  };
  addGroup('CAPTCHA solver (recommended)', solvers);
  addGroup('General vision models (experimental)', others);
  if (s.captchaHelperProfileId && !helpers.some((p) => p.id === s.captchaHelperProfileId)) {
    helperSel.append(new Option('(saved model is not available right now)', s.captchaHelperProfileId));
  }
  $('captcha-solver-missing').classList.toggle('hidden', solvers.length > 0);
  helperSel.value = s.captchaHelperProfileId ?? '';
  $<HTMLSelectElement>('set-mode').value = s.permissionMode;
  $<HTMLTextAreaElement>('set-blocked').value = s.blockedSites.join('\n');
  $<HTMLInputElement>('set-private').checked = s.allowPrivateNetworks;
  $<HTMLInputElement>('set-maxsteps').value = String(s.maxSteps);
  $<HTMLInputElement>('set-autoshot').checked = s.autoScreenshot;
  $<HTMLInputElement>('set-lock').checked = s.lockUserInput;
  $<HTMLInputElement>('set-js').checked = s.enableOptional.javascript_exec;
  // The Chrome Web Store build doesn't include javascript_exec.
  $('set-js').closest('label')?.classList.toggle('hidden', __BA_STORE__);
  $<HTMLInputElement>('set-upload').checked = s.enableOptional.file_upload;
  $<HTMLInputElement>('set-console').checked = s.enableOptional.read_console;
  $<HTMLInputElement>('set-network').checked = s.enableOptional.read_network;
  const ul = $('allowed-sites');
  ul.replaceChildren();
  if (!s.allowedSites.length) ul.append(el('li', 'muted', 'None yet — sites you "Always allow" appear here.'));
  for (const site of s.allowedSites) {
    const li = el('li');
    li.append(el('span', undefined, site));
    const rm = el('button', undefined, 'Remove');
    rm.type = 'button';
    rm.onclick = async () => {
      await request({ type: 'panel:settings', settings: { allowedSites: s.allowedSites.filter((x) => x !== site) } }).then((ns) => {
        state.settings = ns;
        fillSettings();
      });
    };
    li.append(rm);
    ul.append(li);
  }
}

async function saveSettings(): Promise<void> {
  const patch: Partial<PolicySettings> = {
    permissionMode: $<HTMLSelectElement>('set-mode').value as PolicySettings['permissionMode'],
    blockedSites: $<HTMLTextAreaElement>('set-blocked').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
    allowPrivateNetworks: $<HTMLInputElement>('set-private').checked,
    maxSteps: Number($<HTMLInputElement>('set-maxsteps').value) || 60,
    autoScreenshot: $<HTMLInputElement>('set-autoshot').checked,
    lockUserInput: $<HTMLInputElement>('set-lock').checked,
    confirm: readConfirmList(),
    captchaHelperProfileId: $<HTMLSelectElement>('set-captcha-helper').value || undefined,
    enableOptional: {
      javascript_exec: $<HTMLInputElement>('set-js').checked,
      file_upload: $<HTMLInputElement>('set-upload').checked,
      read_console: $<HTMLInputElement>('set-console').checked,
      read_network: $<HTMLInputElement>('set-network').checked,
    },
  };
  if (patch.permissionMode === 'yolo' && state.settings?.permissionMode !== 'yolo') {
    if (!confirm('"Never ask" lets the agent buy, send and delete without confirmation. Only use it in a sandboxed browser. Continue?')) return;
  }
  try {
    state.settings = await request<PolicySettings>({ type: 'panel:settings', settings: patch });
    fillSettings(); // re-render first: it clears the message
    $('settings-msg').textContent = 'Saved.';
  } catch (e) {
    $('settings-msg').textContent = (e as Error).message;
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

initGpu();
initKeys(request);
initHistory({ request, profiles: () => state.profiles, currentId: () => state.sessionId || state.archivedId, open: (id) => void openChat(id) });

async function init(): Promise<void> {
  await request({ type: 'panel:init' }).catch(() => {});
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  void send();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
});
$('btn-stop').onclick = () => {
  if (state.sessionId) void request({ type: 'panel:stop', sessionId: state.sessionId });
};
$('btn-new').onclick = () => {
  if (state.running && !confirm('The agent is still working. Start a new task anyway? (The current one keeps running.)')) return;
  showView('chat');
  newTask();
};
$('btn-settings').onclick = () => showSettings($('view-settings').classList.contains('hidden'));
$('btn-back').onclick = () => showSettings(false);
$('btn-history').onclick = () => showView($('view-history').classList.contains('hidden') ? 'history' : 'chat');
$('btn-history-back').onclick = () => showView('chat');
$('btn-connect').onclick = async () => {
  const url = $<HTMLInputElement>('set-url').value.trim();
  const token = $<HTMLInputElement>('set-token').value.trim();
  $('conn-detail').textContent = 'Connecting…';
  await request({ type: 'panel:config', serverUrl: url || undefined, token: token || undefined });
};
$('btn-save-settings').onclick = () => void saveSettings();
$('btn-confirm-all').onclick = () => setAllConfirm(true);
$('btn-confirm-none').onclick = () => setAllConfirm(false);

connectPort();
showEmpty();
renderConn();
void init();
