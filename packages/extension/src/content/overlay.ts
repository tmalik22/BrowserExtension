/**
 * Visual indicator in the agent's tab (top frame only): a glowing frame, a status pill with a Stop
 * button, an animated cursor that shows where the agent clicks, and an optional input lock that
 * blocks the user's mouse/keyboard while the agent works (Comet-style; off by default).
 * Everything lives in a closed shadow root and is excluded from page reads and screenshots.
 */
import { OVERLAY_ATTR } from './dom.ts';

let host: HTMLElement | null = null;
let parts: { frame: HTMLElement; lock: HTMLElement; pill: HTMLElement; label: HTMLElement; cursor: HTMLElement } | null = null;
let active = false;
let locked = false;
let hiddenForCapture = false;
let suspended = false;

const CSS = `
:host { all: initial; }
.frame { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
  box-shadow: inset 0 0 0 3px rgba(217,119,87,.85), inset 0 0 24px 4px rgba(217,119,87,.35);
  animation: pulse 2.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: .65 } 50% { opacity: 1 } }
.pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
  display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 14px; border-radius: 999px;
  background: #1f1d1a; color: #f5f2ec; font: 500 13px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
  box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: auto; user-select: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #d97757; animation: pulse 1.2s infinite; }
.pill button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: #d97757; color: #fff; font-weight: 600; }
.pill button:hover { background: #c4623f; }
.cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
  border: 2px solid #d97757; background: rgba(217,119,87,.25); pointer-events: none; opacity: 0;
  transition: left .18s ease-out, top .18s ease-out, opacity .2s; }
.cursor.show { opacity: 1; }
.cursor.click { animation: click .35s ease-out; }
@keyframes click { 0% { transform: scale(1) } 50% { transform: scale(.6) } 100% { transform: scale(1) } }
.lock { position: fixed; inset: 0; z-index: 2147483645; cursor: progress; background: transparent; pointer-events: auto; }
.hidden { display: none !important; }
`;

function div(cls: string, parent: Node): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
}

function ensure(): NonNullable<typeof parts> {
  if (parts && host?.isConnected) return parts;
  host = document.createElement('ba-agent-overlay');
  host.setAttribute(OVERLAY_ATTR, '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  const frame = div('frame hidden', root);
  const lock = div('lock hidden', root);
  const pill = div('pill hidden', root);
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Agent is working';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.textContent = 'Stop';
  stop.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'ba:user_stop' }).catch(() => {});
  });
  pill.append(dot, label, stop);
  const cursor = div('cursor', root);
  (document.documentElement ?? document.body).appendChild(host);
  parts = { frame, lock, pill, label, cursor };
  return parts;
}

const BLOCKED_EVENTS = [
  'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup', 'keypress',
  'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dragstart', 'drop', 'paste', 'cut',
] as const;

function blocker(e: Event): void {
  if (!locked || suspended || !e.isTrusted) return;
  const p = parts?.pill;
  if (p && e.composedPath().includes(p)) return; // the Stop button stays usable
  if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') chrome.runtime.sendMessage({ type: 'ba:user_stop' }).catch(() => {});
  e.stopImmediatePropagation();
  e.preventDefault();
}

/** CDP input is "trusted" too, so the service worker suspends the lock around its own actions. */
export function setLockSuspended(v: boolean): void {
  suspended = v;
  apply();
}

function apply(): void {
  const p = ensure();
  const show = active && !hiddenForCapture;
  p.frame.classList.toggle('hidden', !show);
  p.pill.classList.toggle('hidden', !show);
  p.lock.classList.toggle('hidden', !(active && locked && !suspended));
  // display:none (not a fade) so the click indicator is never caught in a screenshot, where the
  // model could mistake it for page content.
  p.cursor.classList.toggle('hidden', hiddenForCapture);
  if (!show) p.cursor.classList.remove('show');
}

let listenersOn = false;
export function setActive(on: boolean, opts: { lock?: boolean; label?: string } = {}): void {
  active = on;
  locked = on && !!opts.lock;
  const p = ensure();
  if (opts.label) p.label.textContent = opts.label;
  if (locked && !listenersOn) {
    for (const t of BLOCKED_EVENTS) window.addEventListener(t, blocker, { capture: true });
    listenersOn = true;
  }
  apply();
}

export function hideForCapture(hidden: boolean): Promise<void> {
  hiddenForCapture = hidden;
  if (!parts) return Promise.resolve();
  apply();
  // Wait two frames so the change is painted before the capture.
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

export function showCursor(x: number, y: number, click: boolean): void {
  if (!active || hiddenForCapture) return;
  const c = ensure().cursor;
  c.style.left = `${x}px`;
  c.style.top = `${y}px`;
  c.classList.add('show');
  if (click) {
    c.classList.remove('click');
    void c.offsetWidth;
    c.classList.add('click');
  }
}

export function isActive(): boolean {
  return active;
}
