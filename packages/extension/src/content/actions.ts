/**
 * Content-script operations on elements: find (natural-language-ish search), visible page text,
 * resolving an element to viewport coordinates (with hit testing), form_input, scroll_to,
 * describe (for the safety policy), and DOM-quiet detection.
 */
import { isSensitiveField } from '@ba/shared';
import {
  collapse,
  composedChildren,
  composedContains,
  deepActiveElement,
  deepElementFromPoint,
  elementById,
  hasArea,
  intersectsViewport,
  isInteractiveRole,
  isSelfInvisible,
  isSkippedTag,
  isSubtreeHidden,
  localId,
  rectOf,
  roleOf,
  visibleText,
} from './dom.ts';
import { accessibleNameSafe, elementProps, labelProxy, resetNameCache, searchableText } from './outline.ts';

// ---------------------------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------------------------

export interface FindMatch {
  id: number;
  role: string;
  name: string;
  props: string;
  score: number;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'at', 'with', 'and', 'or', 'that', 'this', 'is', 'it', 'me', 'my', 'page', 'element', 'which', 'where', 'please']);

const ROLE_SYNONYMS: Record<string, string[]> = {
  button: ['button', 'btn', 'submit', 'press'],
  link: ['link', 'anchor', 'href'],
  textbox: ['field', 'input', 'box', 'textbox', 'text', 'textarea', 'entry', 'form'],
  searchbox: ['search', 'field', 'input', 'box', 'searchbox', 'query'],
  combobox: ['dropdown', 'select', 'combobox', 'picker', 'menu', 'list', 'choose'],
  listbox: ['list', 'listbox', 'select', 'dropdown'],
  checkbox: ['checkbox', 'check', 'tick', 'toggle', 'box'],
  radio: ['radio', 'option', 'choice'],
  switch: ['switch', 'toggle'],
  tab: ['tab'],
  menuitem: ['menu', 'item', 'option'],
  option: ['option', 'item', 'choice'],
  img: ['image', 'picture', 'photo', 'icon', 'logo', 'img'],
  heading: ['heading', 'title', 'header', 'headline'],
  slider: ['slider', 'range'],
  clickable: ['button', 'clickable', 'item', 'card', 'icon'],
  iframe: ['frame', 'iframe', 'embed'],
};

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Collect every visible candidate element (interactive + meaningful structural). */
function collectCandidates(): { el: Element; role: string; name: string; inView: boolean }[] {
  const out: { el: Element; role: string; name: string; inView: boolean }[] = [];
  const visit = (node: Node) => {
    if (!(node instanceof Element)) {
      for (const c of composedChildren(node)) visit(c);
      return;
    }
    if (isSkippedTag(node)) return;
    const style = getComputedStyle(node);
    if (isSubtreeHidden(node, style)) return;
    const role = roleOf(node, style);
    if (role !== 'generic' && role !== 'none' && !isSelfInvisible(style)) {
      const r = rectOf(node);
      if (hasArea(r) || role === 'option') {
        const name = accessibleNameSafe(node, role);
        if (isInteractiveRole(role) || name) out.push({ el: node, role, name, inView: intersectsViewport(r) });
      }
    }
    for (const c of composedChildren(node)) visit(c);
  };
  visit(document.body ?? document.documentElement);
  return out;
}

export function find(query: string, limit = 20): FindMatch[] {
  resetNameCache();
  const q = tokens(query);
  if (!q.length) return [];
  const phrase = collapse(query.toLowerCase());
  const matches: FindMatch[] = [];
  for (const c of collectCandidates()) {
    const hay = searchableText(c.el, c.role, c.name);
    const words = new Set(tokens(hay));
    const nameLower = c.name.toLowerCase();
    let score = 0;
    for (const t of q) {
      if (words.has(t)) score += 3;
      else if (hay.includes(t)) score += 1.5;
      else if (t.length >= 5 && [...words].some((w) => w.length >= 4 && editDistanceAtMost1(w, t))) score += 1.5;
      if (ROLE_SYNONYMS[c.role]?.includes(t)) score += 2;
    }
    if (!score) continue;
    if (nameLower && phrase.includes(nameLower) && nameLower.length > 2) score += 3;
    if (nameLower && nameLower.includes(phrase)) score += 4;
    if (isInteractiveRole(c.role)) score += 1;
    if (c.inView) score += 0.5;
    matches.push({ id: localId(c.el), role: c.role, name: c.name, props: elementProps(c.el, c.role), score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// get_page_text
// ---------------------------------------------------------------------------------------------

export function pageText(maxChars = 100_000): { title: string; url: string; text: string; truncated: boolean } {
  const candidates = Array.from(document.querySelectorAll('main, [role="main"], article, #content, #main, .content, .post, .article')) as HTMLElement[];
  let root: HTMLElement = document.body ?? document.documentElement;
  const bodyLen = (root.innerText ?? '').length;
  let best = 0;
  for (const c of candidates) {
    const len = (c.innerText ?? '').length;
    // Prefer a main/article region that holds most of the page's text.
    if (len > best && len >= 40 && len > bodyLen * 0.35) {
      best = len;
      root = c;
    }
  }
  let text = (root.innerText ?? root.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Include open shadow-root text that innerText cannot see.
  if (!text) text = collapse(root.textContent);
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { title: document.title, url: location.href, text, truncated };
}

// ---------------------------------------------------------------------------------------------
// resolve: element -> viewport point (this frame's coordinates)
// ---------------------------------------------------------------------------------------------

export interface ResolveResult {
  ok: boolean;
  stale?: boolean;
  /** Point in this frame's viewport (CSS px). */
  x?: number;
  y?: number;
  rect?: { x: number; y: number; width: number; height: number };
  /** The element can't be hit at its position (zero size, covered, off-screen). */
  unclickable?: string;
  description: string;
}

export function describeElement(el: Element): string {
  const role = roleOf(el);
  // Unnamed containers (e.g. a cookie banner <div>) are described by their visible text.
  const name = accessibleNameSafe(el, role) || (role === 'generic' ? visibleText(el, 60) : '');
  return `${role === 'generic' ? el.tagName.toLowerCase() : role}${name ? ` "${name.slice(0, 80)}"` : ''}`;
}

function hitOk(el: Element, x: number, y: number): Element | null | true {
  const hit = deepElementFromPoint(x, y);
  if (!hit) return null;
  if (hit === el || composedContains(el, hit)) return true;
  // A label for the element (custom checkboxes) is fine.
  if (hit instanceof HTMLLabelElement && hit.control === el) return true;
  const label = hit.closest('label') as HTMLLabelElement | null;
  if (label && label.control === el) return true;
  // The element is inside the hit element (e.g. hit is a wrapper with pointer events): fine if the
  // hit element contains it and is not a separate overlay.
  if (composedContains(hit, el) && hit.tagName !== 'BODY' && hit.tagName !== 'HTML') return true;
  return hit;
}

export function resolve(id: number, opts: { scroll: boolean }): ResolveResult {
  const el = elementById(id);
  if (!el) return { ok: false, stale: true, description: '' };
  const description = describeElement(el);
  // Hidden checkbox/radio styled through its label: act on the label instead.
  const proxy = labelProxy(el, roleOf(el));
  if (proxy && (!hasArea(rectOf(el)) || isSelfInvisible(getComputedStyle(el)))) return resolveVisible(proxy, el, description, opts);
  return resolveVisible(el, el, description, opts);
}

function resolveVisible(el: Element, actual: Element, description: string, opts: { scroll: boolean }): ResolveResult {
  let r = rectOf(el);
  if (opts.scroll && (!intersectsViewport(r) || r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    r = rectOf(el);
  }
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  if (!hasArea(r)) return { ok: true, rect, unclickable: 'it has no size on screen (it may be visually hidden)', description };
  // Clip to the viewport and try the center, then a few inset points.
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, window.innerWidth);
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  if (right <= left || bottom <= top) return { ok: true, rect, unclickable: 'it is outside the visible viewport', description };
  const points: [number, number][] = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + (right - left) * 0.25, (top + bottom) / 2],
    [left + (right - left) * 0.75, (top + bottom) / 2],
    [(left + right) / 2, top + (bottom - top) * 0.25],
    [(left + right) / 2, top + (bottom - top) * 0.75],
    [left + 2, top + 2],
  ];
  let blocker: Element | null = null;
  for (const [x, y] of points) {
    let h = hitOk(el, x, y);
    if (h !== true && actual !== el && hitOk(actual, x, y) === true) h = true;
    if (h === true) return { ok: true, x: Math.round(x), y: Math.round(y), rect, description };
    if (h && !blocker) blocker = h;
  }
  return {
    ok: true,
    rect,
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2),
    unclickable: blocker ? `it is covered by ${describeElement(blocker)}` : 'it could not be hit-tested',
    description,
  };
}

/** Programmatic click (fallback when the element can't be clicked at its position). */
export function domClick(id: number): { ok: boolean; stale?: boolean; description: string } {
  const el = elementById(id) as HTMLElement | null;
  if (!el) return { ok: false, stale: true, description: '' };
  el.focus?.({ preventScroll: true } as FocusOptions);
  el.click();
  return { ok: true, description: describeElement(el) };
}

export function scrollTo(id: number): { ok: boolean; stale?: boolean; description: string } {
  const el = elementById(id);
  if (!el) return { ok: false, stale: true, description: '' };
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  return { ok: true, description: describeElement(el) };
}

export function focusElement(id: number): { ok: boolean; stale?: boolean } {
  const el = elementById(id) as HTMLElement | null;
  if (!el) return { ok: false, stale: true };
  el.focus?.();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// form_input
// ---------------------------------------------------------------------------------------------

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
}

export function formInput(id: number, value: unknown): { ok: boolean; stale?: boolean; message: string } {
  const el = elementById(id);
  if (!el) return { ok: false, stale: true, message: '' };
  const desc = describeElement(el);
  const role = roleOf(el);
  if ((el as HTMLInputElement).disabled) return { ok: false, message: `Error: ${desc} is disabled.` };

  if (el instanceof HTMLSelectElement) {
    const want = String(value);
    const opts = Array.from(el.options);
    const norm = (s: string) => collapse(s).toLowerCase();
    const match =
      opts.find((o) => o.value === want) ??
      opts.find((o) => norm(o.label || o.text) === norm(want)) ??
      opts.find((o) => norm(o.label || o.text).includes(norm(want)) && norm(want).length > 0);
    if (!match) {
      const avail = opts.slice(0, 30).map((o) => `"${collapse(o.label || o.text)}"`).join(', ');
      return { ok: false, message: `Error: ${desc} has no option matching "${want}". Options: ${avail}${opts.length > 30 ? ', …' : ''}` };
    }
    if (match.disabled) return { ok: false, message: `Error: option "${collapse(match.text)}" is disabled.` };
    (el as HTMLElement).focus();
    setNativeValue(el, match.value);
    match.selected = true;
    fire(el, 'input');
    fire(el, 'change');
    return { ok: true, message: `Set ${desc} to "${collapse(match.label || match.text)}".` };
  }

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = value === true || value === 'true' || value === 1 || value === 'on' || value === 'checked';
    if (el.type === 'radio' && !want) return { ok: false, message: `Error: a radio button can't be unchecked directly; select another option in the group.` };
    if (el.checked !== want) el.click();
    if (el.checked !== want) {
      el.checked = want;
      fire(el, 'input');
      fire(el, 'change');
    }
    return { ok: true, message: `${want ? 'Checked' : 'Unchecked'} ${desc}.` };
  }

  if (['checkbox', 'switch', 'radio', 'menuitemcheckbox'].includes(role)) {
    const want = value === true || value === 'true';
    const cur = el.getAttribute('aria-checked') === 'true';
    if (cur !== want) (el as HTMLElement).click();
    const now = el.getAttribute('aria-checked') === 'true';
    return now === want ? { ok: true, message: `${want ? 'Checked' : 'Unchecked'} ${desc}.` } : { ok: false, message: `Error: clicked ${desc} but its state did not change; try left_click.` };
  }

  if (el instanceof HTMLInputElement && el.type === 'file') return { ok: false, message: 'Error: use file_upload for file inputs.' };

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const v = typeof value === 'string' ? value : String(value);
    el.focus();
    setNativeValue(el, v);
    fire(el, 'input');
    fire(el, 'change');
    const sensitive = isSensitiveField(el.getAttribute('autocomplete') ?? undefined, accessibleNameSafe(el, role), el.type);
    if (el.value !== v && el.type !== 'number') return { ok: true, message: `Set ${desc}; the field now contains "${sensitive ? '••••' : el.value}" (it may restrict input).` };
    return { ok: true, message: `Set ${desc} to "${sensitive ? '••••' : v.slice(0, 200)}".` };
  }

  if ((el as HTMLElement).isContentEditable) {
    const h = el as HTMLElement;
    h.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(h);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand keeps editors' undo stacks and input events intact.
    const ok = document.execCommand('insertText', false, String(value));
    if (!ok) h.textContent = String(value);
    return { ok: true, message: `Set ${desc} to "${String(value).slice(0, 200)}".` };
  }

  if (role === 'slider' || role === 'spinbutton') {
    return { ok: false, message: `Error: ${desc} is a custom widget; use keyboard (ArrowLeft/ArrowRight) or clicks to change it.` };
  }
  return { ok: false, message: `Error: ${desc} is not a form field that form_input can set. Use left_click or type.` };
}

// ---------------------------------------------------------------------------------------------
// describe (for the safety policy)
// ---------------------------------------------------------------------------------------------

export interface ElementInfo {
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  autocomplete?: string;
  formSubmitName?: string;
  formHasPassword?: boolean;
  sensitive?: boolean;
  isIframe?: boolean;
  /** For checkboxes/radios/switches. */
  checked?: boolean;
}

export function elementInfo(el: Element): ElementInfo {
  resetNameCache();
  const label = el.closest('label') as HTMLLabelElement | null;
  if (label?.control && label.control !== el && (label.control as HTMLInputElement).type && ['checkbox', 'radio'].includes((label.control as HTMLInputElement).type)) {
    const c = label.control;
    return elementInfo2(c, roleOf(c), accessibleNameSafe(c, roleOf(c)));
  }
  const role = roleOf(el);
  let name = accessibleNameSafe(el, role);
  // A click on an icon inside a button counts as the button.
  if (!name || role === 'generic' || role === 'img') {
    const btn = el.closest('button, a[href], [role="button"], [role="link"], input[type="submit"]');
    if (btn && btn !== el) {
      const r2 = roleOf(btn);
      return elementInfo2(btn, r2, accessibleNameSafe(btn, r2));
    }
    if (!name) name = visibleText(el, 120);
  }
  return elementInfo2(el, role, name);
}

function elementInfo2(el: Element, role: string, name: string): ElementInfo {
  const input = el as HTMLInputElement;
  const form = (input.form ?? el.closest('form')) as HTMLFormElement | null;
  let formSubmitName: string | undefined;
  let formHasPassword = false;
  if (form) {
    const submit = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"], [role="button"][type="submit"]');
    if (submit) formSubmitName = accessibleNameSafe(submit, roleOf(submit)) || 'Submit';
    formHasPassword = !!form.querySelector('input[type="password"]');
  }
  const inputType = el instanceof HTMLInputElement ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName === 'BUTTON' ? (el.getAttribute('type') || 'submit').toLowerCase() : undefined;
  const autocomplete = el.getAttribute('autocomplete') ?? undefined;
  return {
    role,
    name: name.slice(0, 200),
    tag: el.tagName.toLowerCase(),
    inputType,
    autocomplete,
    formSubmitName,
    formHasPassword,
    sensitive: ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role) || el instanceof HTMLInputElement ? isSensitiveField(autocomplete, name, inputType) : false,
    ...(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)
      ? { checked: el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.getAttribute('aria-checked') === 'true' }
      : {}),
    isIframe: el.tagName === 'IFRAME' || el.tagName === 'FRAME',
  };
}

export function describeId(id: number): { stale?: boolean; info?: ElementInfo } {
  const el = elementById(id);
  if (!el) return { stale: true };
  return { info: elementInfo(el) };
}

export function describePoint(x: number, y: number): { info?: ElementInfo; iframeId?: number } {
  const el = deepElementFromPoint(x, y);
  if (!el) return {};
  const info = elementInfo(el);
  return info.isIframe ? { info, iframeId: localId(el) } : { info };
}

export function describeFocused(): { info?: ElementInfo; isIframe?: boolean; iframeId?: number; nothingFocused?: boolean } {
  const a = deepActiveElement();
  if (!a || a === document.body || a === document.documentElement) return { nothingFocused: true };
  if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') return { isIframe: true, iframeId: localId(a) };
  return { info: elementInfo(a) };
}

/** After typing: what the focused field contains (masked when sensitive). */
export function focusedFieldState(): { description?: string; value?: string; sensitive?: boolean; nothingFocused?: boolean; isIframe?: boolean; iframeId?: number } {
  const a = deepActiveElement();
  if (!a || a === document.body || a === document.documentElement) return { nothingFocused: true };
  if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') return { isIframe: true, iframeId: localId(a) };
  const info = elementInfo(a);
  let value: string | undefined;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) value = info.sensitive ? '••••' : a.value;
  else if ((a as HTMLElement).isContentEditable) value = collapse((a as HTMLElement).innerText).slice(0, 300);
  return { description: describeElement(a), value, sensitive: !!info.sensitive };
}

// ---------------------------------------------------------------------------------------------
// DOM quiet detection (used by the service worker's settle logic)
// ---------------------------------------------------------------------------------------------

let lastMutation = performance.now();
let observer: MutationObserver | null = null;

export function startMutationTracking(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    lastMutation = performance.now();
  });
  const start = () => observer!.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

export function waitDomQuiet(quietMs: number, maxMs: number): Promise<{ quietFor: number; waited: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      const quiet = now - lastMutation;
      if (quiet >= quietMs || now - t0 >= maxMs) resolve({ quietFor: Math.round(quiet), waited: Math.round(now - t0) });
      else setTimeout(tick, Math.min(50, quietMs - quiet + 5));
    };
    tick();
  });
}

export function scrollState(): { x: number; y: number; maxX: number; maxY: number; vw: number; vh: number } {
  const se = document.scrollingElement ?? document.documentElement;
  return {
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    maxX: Math.max(0, se.scrollWidth - window.innerWidth),
    maxY: Math.max(0, se.scrollHeight - window.innerHeight),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}
