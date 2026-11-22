/**
 * Chat history: the list of past chats (History view, and the most recent ones on the empty
 * start screen). All text comes from chats, so it's set with textContent only.
 */
import type { ChatInfo, ProfileInfo } from '@ba/shared';

type Request = <T = any>(msg: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

let request: Request;
let profiles: () => ProfileInfo[] = () => [];
let currentId: () => string = () => '';
let onOpen: (id: string) => void = () => {};

export function initHistory(opts: { request: Request; profiles: () => ProfileInfo[]; currentId: () => string; open: (id: string) => void }): void {
  request = opts.request;
  profiles = opts.profiles;
  currentId = opts.currentId;
  onOpen = opts.open;
  const search = document.getElementById('chat-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => filterList(search.value));
}

export async function fetchChats(limit = 50): Promise<ChatInfo[]> {
  return request<ChatInfo[]>({ type: 'panel:chats', limit });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function chatRow(c: ChatInfo, compact: boolean): HTMLButtonElement {
  const b = el('button', `chat${c.sessionId === currentId() ? ' current' : ''}`);
  b.type = 'button';
  b.dataset.id = c.sessionId;
  b.dataset.search = `${c.title} ${c.lastReply ?? ''}`.toLowerCase();
  const head = el('div', 'chat-head');
  head.append(el('span', 'chat-title', c.title));
  if (c.running) head.append(el('span', 'chat-badge running', 'Working'));
  head.append(el('span', 'chat-when', ago(c.updatedAt)));
  b.append(head);
  if (!compact && c.lastReply) b.append(el('div', 'chat-reply', c.lastReply));
  const model = profiles().find((p) => p.id === c.profileId)?.label ?? c.profileId;
  const meta = [model, c.messages ? `${c.messages} message${c.messages === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  if (meta && !compact) b.append(el('div', 'chat-meta', meta));
  b.title = c.lastReply ? `${c.title}\n\nLast reply: ${c.lastReply}` : c.title;
  b.onclick = () => onOpen(c.sessionId);
  return b;
}

/** Fill the History view. */
export async function showHistoryList(): Promise<void> {
  const list = document.getElementById('chat-list')!;
  const msg = document.getElementById('chat-list-msg')!;
  msg.textContent = 'Loading…';
  try {
    const chats = await fetchChats(100);
    list.replaceChildren(...chats.map((c) => chatRow(c, false)));
    msg.textContent = chats.length ? '' : 'No chats yet.';
    const search = document.getElementById('chat-search') as HTMLInputElement | null;
    if (search?.value) filterList(search.value);
  } catch (e) {
    list.replaceChildren();
    msg.textContent = `Couldn't load your chats: ${(e as Error).message}`;
  }
}

function filterList(q: string): void {
  const needle = q.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll<HTMLElement>('#chat-list .chat').forEach((row) => {
    const hit = !needle || (row.dataset.search ?? '').includes(needle);
    row.classList.toggle('hidden', !hit);
    if (hit) shown++;
  });
  const msg = document.getElementById('chat-list-msg')!;
  if (needle && !shown) msg.textContent = 'No chats match.';
  else if (needle || msg.textContent === 'No chats match.') msg.textContent = '';
}

/** The few most recent chats, under the start screen's suggestions. */
export async function fillRecent(box: HTMLElement, showAll: () => void): Promise<void> {
  let chats: ChatInfo[];
  try {
    chats = await fetchChats(4);
  } catch {
    return;
  }
  if (!chats.length || !box.isConnected) return;
  const wrap = el('div', 'recent');
  const head = el('div', 'recent-head');
  head.append(el('span', undefined, 'Recent chats'));
  const all = el('button', 'link', 'All chats');
  all.type = 'button';
  all.onclick = showAll;
  head.append(all);
  wrap.append(head, ...chats.map((c) => chatRow(c, true)));
  box.append(wrap);
}
