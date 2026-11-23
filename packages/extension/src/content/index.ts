/**
 * Content script (every frame, isolated world). Answers requests from the service worker.
 * Every response carries the document nonce so the service worker can tell when a frame's
 * document was replaced (which invalidates its element references).
 */
import { isChallengeUrl } from '@ba/shared';
import { docNonce, elementById, localId, composedChildren } from './dom.ts';
import { buildOutline } from './outline.ts';
import {
  describeFocused,
  describeId,
  describePoint,
  domClick,
  find,
  focusElement,
  focusedFieldState,
  formInput,
  pageText,
  resolve,
  scrollState,
  scrollTo,
  startMutationTracking,
  waitDomQuiet,
} from './actions.ts';
import { hideForCapture, setActive, setLockSuspended, showCursor } from './overlay.ts';

type Msg = { type: string; [k: string]: any };

declare global {
  interface Window {
    __baContentLoaded?: boolean;
  }
}

function allIframes(): HTMLIFrameElement[] {
  const out: HTMLIFrameElement[] = [];
  const visit = (n: Node) => {
    if (n instanceof HTMLIFrameElement || (n instanceof Element && n.tagName === 'FRAME')) out.push(n as HTMLIFrameElement);
    for (const c of composedChildren(n)) visit(c);
  };
  visit(document.documentElement);
  return out;
}

const CAPTCHA_FRAME = { test: (url: string) => isChallengeUrl(url) };
const CAPTCHA_TEXT = /verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|checking (?:your browser|if the site connection is secure)|just a moment|attention required|verify you are human|complete the security check|security check/i;
const CAPTCHA_DONE = /\bsuccess!?\b|verification (?:complete|successful)|you are (?:now )?verified|challenge passed/i;

/** Elements including open shadow roots, for widgets that hide their checkbox in one. */
function deepElements(root: Document | Element | ShadowRoot): Element[] {
  const out: Element[] = [];
  const visit = (n: Node) => {
    if (n instanceof Element) {
      out.push(n);
      if (n.shadowRoot) for (const c of n.shadowRoot.children) visit(c);
    }
    for (const c of composedChildren(n)) visit(c);
  };
  visit(root);
  return out;
}

/** Cheap check for a CAPTCHA widget or interstitial in this frame. */
function probeCaptcha(): { challenge: boolean; solved?: boolean; kind?: string; detail?: string } {
  const title = document.title;
  const href = location.href;
  // A solved widget puts its response token in a hidden field of the page.
  const token = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"],[name="g-recaptcha-response"],[name="h-captcha-response"]');
  if (token?.value) return { challenge: false, solved: true, kind: 'turnstile', detail: 'response token present' };
  const iframes = allIframes();
  const challengeIframe = iframes.find((f) => CAPTCHA_FRAME.test(f.src || ''));
  const iframeRect = challengeIframe?.getBoundingClientRect();
  const visibleChallengeIframe = !!iframeRect && iframeRect.width > 10 && iframeRect.height > 10;
  const baseText = document.body?.innerText || '';
  const inChallengeFrame = CAPTCHA_FRAME.test(href);
  let fromText = CAPTCHA_TEXT.test(title) || CAPTCHA_TEXT.test(baseText);
  const interstitial = /\/cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i.test(href);
  if (!challengeIframe && !fromText && !interstitial && !inChallengeFrame) return { challenge: false };

  // Inside a challenge frame the widget is part of this document (usually in a shadow root):
  // find its checkbox/button and include shadow text that innerText does not see.
  const deep = inChallengeFrame || fromText ? deepElements(document) : [];
  const shown = (n: Element) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const text = `${baseText} ${deep.filter((n) => !n.childElementCount && shown(n)).map((n) => n.textContent || '').join(' ')}`.slice(0, 8000);
  fromText = fromText || CAPTCHA_TEXT.test(text);
  let checked = false;
  let hasWidget = false;
  if (deep.length) {
    for (const n of deep) {
      if (!shown(n)) continue;
      if (n.matches('input[type="checkbox"],[role="checkbox"],button')) {
        if (n.matches('input[type="checkbox"]')) {
          hasWidget = true;
          if ((n as HTMLInputElement).checked) checked = true;
        } else if (n.getAttribute('aria-checked') === 'true') checked = true;
        else if (n.matches('[role="checkbox"]')) hasWidget = true;
        else if (/verify|i am human|continue/i.test(n.textContent || '')) hasWidget = true;
      }
      if (n.matches('[name="cf-turnstile-response"],[name="g-recaptcha-response"],[name="h-captcha-response"]')) hasWidget = true;
    }
  }
  const done = checked || CAPTCHA_DONE.test(text);
  const kind = interstitial ? 'cloudflare' : /recaptcha/i.test(href) ? 'recaptcha' : /hcaptcha/i.test(href) ? 'hcaptcha' : challengeIframe?.src?.includes('cloudflare') ? 'turnstile' : challengeIframe ? 'unknown' : 'cloudflare';
  return {
    challenge: !done && ((inChallengeFrame && (hasWidget || fromText)) || visibleChallengeIframe || interstitial),
    solved: done || undefined,
    kind,
    detail: (challengeIframe?.src || text.replace(/\s+/g, ' ').trim()).slice(0, 200),
  };
}

function visibleRect(r: DOMRect): boolean {
  return r.width > 10 && r.height > 10 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/** Locate the challenge widget in the top frame, or fall back to the whole viewport. */
/** Is the top-frame point (CSS px) on a real challenge iframe? Guards the helper's direct clicks. */
/** A shadow root, open or closed (extensions may read closed ones through chrome.dom). */
function shadowRootOf(el: Element): ShadowRoot | null {
  try {
    return (chrome as any).dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
  } catch {
    return el.shadowRoot;
  }
}

/**
 * The <iframe> element hosting a child window, including one inside a closed shadow root (where
 * challenge widgets such as Turnstile live), which the ordinary scan cannot see.
 */
function frameElementFor(source: MessageEventSource | null): HTMLIFrameElement | undefined {
  const direct = allIframes().find((f) => f.contentWindow === source);
  if (direct) return direct;
  let found: HTMLIFrameElement | undefined;
  const visit = (n: Node) => {
    if (found) return;
    if (n instanceof HTMLIFrameElement && n.contentWindow === source) {
      found = n;
      return;
    }
    if (n instanceof Element) {
      const root = shadowRootOf(n);
      if (root) for (const c of root.childNodes) visit(c);
    }
    for (const c of n.childNodes) visit(c);
  };
  visit(document.documentElement);
  return found;
}

function captchaHit(x: number, y: number): { ok: boolean; iframeId?: number } {
  if (window !== window.top || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
  // Widgets such as Turnstile put their iframe inside a (often closed) shadow root, where the
  // document-level hit is only the host. Descend to the deepest element: anything the page lays
  // over the frame, inside the shadow root or out, is still what gets hit, and is refused.
  let el = document.elementFromPoint(x, y);
  for (let depth = 0; el && depth < 8; depth++) {
    const root = shadowRootOf(el);
    const inner = root?.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  // The src attribute is only the page's claim (it stays put when the frame is navigated). The
  // service worker checks which page the frame is really showing before anything is clicked.
  if (!(el instanceof HTMLIFrameElement) || !isChallengeUrl(el.src)) return { ok: false };
  return { ok: true, iframeId: localId(el) };
}

function captchaLocate(): { rect: { x: number; y: number; w: number; h: number }; inIframe: boolean } {
  if (window !== window.top) return { rect: { x: 0, y: 0, w: 0, h: 0 }, inIframe: false };
  const frames = allIframes().filter((f) => CAPTCHA_FRAME.test(f.src || ''));
  const frame = frames.find((f) => visibleRect(f.getBoundingClientRect())) ?? frames[0];
  const r = frame?.getBoundingClientRect();
  if (r && visibleRect(r)) return { rect: { x: r.left, y: r.top, w: r.width, h: r.height }, inIframe: true };
  return { rect: { x: 0, y: 0, w: innerWidth, h: innerHeight }, inIframe: false };
}

/** Find a 3x3 / 4x4 tile grid in a challenge frame and return cell rects (frame-viewport px). */
function captchaGrid(): { rows: number; cols: number; cells: { x: number; y: number; w: number; h: number }[] } | null {
  const shape = (cells: Element[]): { rows: number; cols: number; cells: { x: number; y: number; w: number; h: number }[] } | null => {
    if (cells.length !== 9 && cells.length !== 16) return null;
    const rows = Math.sqrt(cells.length);
    const rects = cells.map((c) => c.getBoundingClientRect());
    if (rects.some((r) => r.width < 8 || r.height < 8)) return null;
    return { rows, cols: rows, cells: rects.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })) };
  };
  for (const table of document.querySelectorAll('table')) {
    const cells = [...table.querySelectorAll('td,th,[role="gridcell"]')].filter((c) => !c.querySelector('td,th'));
    const g = shape(cells);
    if (g) return g;
  }
  for (const grid of document.querySelectorAll('[role="grid"],[role="group"],div')) {
    if (grid.children.length !== 9 && grid.children.length !== 16) continue;
    const cells = [...grid.children].filter((c) => c instanceof HTMLElement && visibleRect(c.getBoundingClientRect()));
    const g = shape(cells);
    if (g) return g;
  }
  return null;
}

function onProbe(e: MessageEvent): void {
  const token = e.data && typeof e.data === 'object' ? (e.data as { __baProbe?: unknown }).__baProbe : undefined;
  if (typeof token !== 'string' || !token.startsWith('baprobe_')) return;
  const frame = frameElementFor(e.source);
  if (!frame) return;
  const r = frame.getBoundingClientRect();
  const cs = getComputedStyle(frame);
  const x = r.left + frame.clientLeft + parseFloat(cs.paddingLeft || '0');
  const y = r.top + frame.clientTop + parseFloat(cs.paddingTop || '0');
  chrome.runtime
    .sendMessage({
      type: 'ba:probe_hit',
      token,
      iframeId: localId(frame),
      docNonce,
      offset: { x, y },
      width: r.width,
      height: r.height,
      visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    })
    .catch(() => {});
}

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'ba:hello':
      return { url: location.href, title: document.title, top: window === window.top };
    case 'ba:outline':
      return buildOutline({ filter: msg.filter, depth: msg.depth, rootId: msg.rootId, maxLines: msg.maxLines });
    case 'ba:find':
      return { matches: find(String(msg.query ?? ''), msg.limit ?? 20) };
    case 'ba:text':
      return pageText(msg.maxChars);
    case 'ba:resolve':
      return resolve(msg.id, { scroll: msg.scroll !== false });
    case 'ba:dom_click':
      return domClick(msg.id);
    case 'ba:scroll_to':
      return scrollTo(msg.id);
    case 'ba:focus':
      return focusElement(msg.id);
    case 'ba:form_input':
      return formInput(msg.id, msg.value);
    case 'ba:describe':
      if (msg.focused) return describeFocused();
      if (msg.point) return describePoint(msg.point.x, msg.point.y);
      return describeId(msg.id);
    case 'ba:focused_state':
      return focusedFieldState();
    case 'ba:quiet':
      return waitDomQuiet(msg.quietMs ?? 250, msg.maxMs ?? 1500);
    case 'ba:scroll_state':
      return scrollState();
    case 'ba:viewport':
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    case 'ba:probe_parent':
      if (window === window.top) return { top: true };
      window.parent.postMessage({ __baProbe: msg.token }, '*');
      return { sent: true };
    case 'ba:overlay':
      if (window === window.top) setActive(!!msg.active, { lock: msg.lock, label: msg.label });
      return { ok: true };
    case 'ba:overlay_capture':
      if (window === window.top) await hideForCapture(!!msg.hidden);
      return { ok: true };
    case 'ba:cursor':
      if (window === window.top) showCursor(msg.x, msg.y, !!msg.click);
      return { ok: true };
    case 'ba:lock_suspend':
      if (window === window.top) setLockSuspended(!!msg.value);
      return { ok: true };
    case 'ba:mark_upload': {
      const el = elementById(msg.id);
      if (!el) return { stale: true };
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { error: 'Error: that element is not a file input.' };
      el.setAttribute('data-ba-upload', msg.token);
      return { ok: true, multiple: el.multiple };
    }
    case 'ba:unmark_upload': {
      document.querySelectorAll(`[data-ba-upload="${CSS.escape(String(msg.token))}"]`).forEach((n) => n.removeAttribute('data-ba-upload'));
      return { ok: true };
    }
    default:
      // The CAPTCHA helper's messages exist in the GitHub build only (the constant lets the
      // bundler drop the helper's code from the Chrome Web Store build).
      return __BA_STORE__ ? unknownMessage(msg) : helperMessage(msg);
  }
}

const unknownMessage = (msg: Msg) => ({ error: `unknown message ${msg.type}` });

function helperMessage(msg: Msg): unknown {
  switch (msg.type) {
    case 'ba:captcha_probe':
      return probeCaptcha();
    case 'ba:captcha_locate':
      return captchaLocate();
    case 'ba:captcha_hit':
      return captchaHit(Number(msg.x), Number(msg.y));
    case 'ba:captcha_grid':
      return captchaGrid();
    default:
      return unknownMessage(msg);
  }
}

if (!window.__baContentLoaded) {
  window.__baContentLoaded = true;
  startMutationTracking();
  // Capturing listener registered at document_start, before page scripts can intercept probes.
  window.addEventListener('message', onProbe, true);
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ba:')) return false;
    handle(msg)
      .then((r) => sendResponse({ ok: true, docNonce, result: r }))
      .catch((e) => sendResponse({ ok: false, docNonce, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
