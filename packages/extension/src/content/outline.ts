/**
 * Accessibility-tree outline of one frame, in the format of Anthropic's browser toolset:
 *   heading "Pricing" [ref_4] level=2
 *     link "Docs" [ref_5] href="/docs"
 * The content script returns structured lines with frame-local ids; the service worker assigns the
 * tab-wide ref_N numbers and stitches child frames under their <iframe> line.
 */
import { isSensitiveField } from '@ba/shared';
import {
  LEAF_ROLES,
  accessibleName,
  collapse,
  composedChildren,
  elementById,
  hasArea,
  intersectsViewport,
  isInteractiveRole,
  isSelfInvisible,
  isSkippedTag,
  isStructuralRole,
  isSubtreeHidden,
  localId,
  rectOf,
  roleOf,
  valueOf,
  visibleText,
} from './dom.ts';

/** Structural roles that are only listed when named (otherwise they are noise). */
const NAME_REQUIRED = new Set(['group', 'region', 'figure', 'generic', 'label', 'toolbar', 'note', 'tooltip', 'application', 'document', 'log', 'marquee', 'timer', 'math']);

/** For a visually hidden checkbox/radio, its visible label (to click/measure instead). */
export function labelProxy(el: Element, role: string): HTMLElement | null {
  if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio', 'switch'].includes(role)) return null;
  for (const l of Array.from(el.labels ?? [])) {
    const r = l.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1 && getComputedStyle(l).visibility !== 'hidden') return l;
  }
  return null;
}

export interface OutlineLine {
  depth: number;
  role: string;
  name: string;
  /** frame-local element id; absent for text lines */
  id?: number;
  props: string;
  /** set on iframe lines so the service worker can nest the child frame here */
  iframe?: boolean;
}

export interface OutlineRequest {
  filter?: 'interactive' | 'all';
  depth?: number;
  rootId?: number;
  maxLines?: number;
}

export interface OutlineResponse {
  lines: OutlineLine[];
  truncated: boolean;
  stale?: boolean;
}

const MAX_NAME = 150;
const MAX_TEXT = 300;

function q(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function elementProps(el: Element, role: string): string {
  const p: string[] = [];
  const input = el as HTMLInputElement;
  const tag = el.tagName;
  if (role === 'heading') {
    const lvl = el.getAttribute('aria-level') ?? (/^H[1-6]$/.test(tag) ? tag[1] : null);
    if (lvl) p.push(`level=${lvl}`);
  }
  if (role === 'link') {
    const href = el.getAttribute('href');
    if (href && !href.startsWith('javascript:')) p.push(`href="${q(trunc(href, 120))}"`);
  }
  if (tag === 'INPUT') {
    const t = (input.getAttribute('type') || 'text').toLowerCase();
    if (!['text', 'checkbox', 'radio', 'submit', 'button'].includes(t)) p.push(`type="${t}"`);
  }
  const sensitive = isSensitiveField(el.getAttribute('autocomplete') ?? undefined, accessibleNameSafe(el, role), input.type);
  const val = valueOf(el, sensitive);
  if (val !== undefined && (val !== '' || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role))) p.push(`value="${q(trunc(val, 200))}"`);
  const ph = el.getAttribute('placeholder');
  if (ph && ph !== accessibleNameSafe(el, role)) p.push(`placeholder="${q(trunc(collapse(ph), 80))}"`);
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    const checked = input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : el.getAttribute('aria-checked') === 'true';
    const mixed = el.getAttribute('aria-checked') === 'mixed' || (input instanceof HTMLInputElement && input.indeterminate);
    p.push(mixed ? 'checked=mixed' : checked ? 'checked' : 'unchecked');
  }
  if (role === 'option' || role === 'tab' || role === 'treeitem' || role === 'gridcell') {
    const sel = el instanceof HTMLOptionElement ? el.selected : el.getAttribute('aria-selected') === 'true';
    if (sel) p.push('selected');
  }
  const exp = el.getAttribute('aria-expanded');
  if (exp !== null) p.push(`expanded=${exp}`);
  else if (tag === 'SUMMARY') p.push(`expanded=${(el.parentElement as HTMLDetailsElement | null)?.open ? 'true' : 'false'}`);
  if (el.getAttribute('aria-pressed') !== null) p.push(`pressed=${el.getAttribute('aria-pressed')}`);
  if (el.getAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') p.push(`haspopup=${el.getAttribute('aria-haspopup')}`);
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') p.push('disabled');
  if ((input as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') p.push('required');
  if ((input as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true') p.push('readonly');
  if (el.getAttribute('aria-invalid') === 'true') p.push('invalid');
  if (document.activeElement === el || el.shadowRoot?.activeElement) p.push('focused');
  if (tag === 'IMG' && !accessibleNameSafe(el, role)) {
    const src = el.getAttribute('src');
    if (src && !src.startsWith('data:')) p.push(`src="${q(trunc(src, 80))}"`);
  }
  if (role === 'clickable') p.push(`tag=${tag.toLowerCase()}`);
  if (role === 'iframe') {
    const src = el.getAttribute('src');
    if (src) p.push(`src="${q(trunc(src, 120))}"`);
  }
  return p.join(' ');
}

let nameCache = new WeakMap<Element, string>();

/** Names are cached only within one outline/find call (pages change between calls). */
export function resetNameCache(): void {
  nameCache = new WeakMap();
}
export function accessibleNameSafe(el: Element, role: string): string {
  let n = nameCache.get(el);
  if (n === undefined) {
    n = trunc(accessibleName(el, role), MAX_NAME);
    nameCache.set(el, n);
  }
  return n;
}

/** Build the outline. */
export function buildOutline(req: OutlineRequest): OutlineResponse {
  resetNameCache();
  const filter = req.filter;
  const maxDepth = Math.max(1, req.depth ?? 15);
  const maxLines = req.maxLines ?? 6000;
  const lines: OutlineLine[] = [];
  let truncated = false;
  const interactiveOnly = filter === 'interactive';
  const includeOffscreen = filter === 'all';

  let root: Node = document.body ?? document.documentElement;
  if (req.rootId !== undefined) {
    const el = elementById(req.rootId);
    if (!el) return { lines: [], truncated: false, stale: true };
    root = el;
  }

  let pendingText: { depth: number; text: string } | null = null;
  const flushText = () => {
    if (pendingText && pendingText.text) {
      // Skip text that only repeats the enclosing element's name (e.g. a paragraph whose name
      // is its own text) — it costs tokens and adds nothing.
      let parent: OutlineLine | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].depth < pendingText.depth) {
          parent = lines[i];
          break;
        }
      }
      const t = pendingText.text;
      const redundant = parent && parent.depth === pendingText.depth - 1 && parent.name && (parent.name === t || (parent.name.endsWith('…') && t.startsWith(parent.name.slice(0, -1))));
      if (!redundant) lines.push({ depth: pendingText.depth, role: 'text', name: trunc(t, MAX_TEXT), props: '' });
    }
    pendingText = null;
  };

  const visit = (node: Node, depth: number, parentVisible: boolean): void => {
    if (truncated) return;
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (interactiveOnly || !parentVisible) return;
      const t = collapse(node.textContent);
      if (!t) return;
      if (!includeOffscreen) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (!hasArea(r) || !intersectsViewport(r)) return;
      }
      if (pendingText && pendingText.depth === depth) pendingText.text += ' ' + t;
      else {
        flushText();
        pendingText = { depth, text: t };
      }
      return;
    }
    if (!(node instanceof Element)) {
      for (const c of composedChildren(node)) visit(c, depth, parentVisible);
      return;
    }
    const el = node;
    if (isSkippedTag(el)) return;
    const style = getComputedStyle(el);
    if (isSubtreeHidden(el, style)) return;
    const selfVisible = !isSelfInvisible(style);
    const role = roleOf(el, style);

    let emit = false;
    // Visually hidden checkbox/radio inputs styled through their <label> (a very common pattern)
    // are still operable: list them, using the label's box for visibility.
    const proxy = !selfVisible || !hasArea(rectOf(el)) ? labelProxy(el, role) : null;
    if (role !== 'generic' && role !== 'none' && (selfVisible || proxy)) {
      const interactive = isInteractiveRole(role) || ((el as HTMLElement).isContentEditable && role === 'textbox');
      if (interactive || (!interactiveOnly && (isStructuralRole(role) || role === 'canvas'))) {
        const r = proxy ? rectOf(proxy) : rectOf(el);
        const sized = hasArea(r) || role === 'option';
        const inView = includeOffscreen || intersectsViewport(r) || role === 'option';
        // Generic groupings only earn a line when they carry a name.
        const named = interactive || !NAME_REQUIRED.has(role) || !!accessibleNameSafe(el, role);
        emit = sized && inView && named;
        // Options of a closed <select> are listed (without refs being necessary to click them).
        if (role === 'option' && el.closest('select') && !includeOffscreen && !interactiveOnly) emit = true;
      }
    }

    if (emit && depth >= maxDepth) {
      // Depth cap: neither this element nor its descendants.
      return;
    }

    if (emit) {
      flushText();
      const name = accessibleNameSafe(el, role);
      lines.push({ depth, role, name, id: localId(el), props: elementProps(el, role), iframe: role === 'iframe' || undefined });
      if (LEAF_ROLES.has(role) && role !== 'option') {
        // Leaf: its name covers the content. Still descend into selects' options / listbox items.
        if (el instanceof HTMLSelectElement && !interactiveOnly) {
          for (const opt of Array.from(el.options).slice(0, 50)) {
            lines.push({ depth: depth + 1, role: 'option', name: trunc(collapse(opt.label || opt.text), MAX_NAME), id: localId(opt), props: opt.selected ? 'selected' : '' });
          }
          if (el.options.length > 50) lines.push({ depth: depth + 1, role: 'text', name: `… ${el.options.length - 50} more options`, props: '' });
        }
        return;
      }
      if (role === 'iframe') return;
      for (const c of composedChildren(el)) visit(c, depth + 1, selfVisible);
      flushText();
      return;
    }
    for (const c of composedChildren(el)) visit(c, depth, selfVisible || parentVisible && style.visibility !== 'hidden');
  };

  if (root instanceof Element && req.rootId !== undefined) {
    // Scoped read: always include the root element itself.
    const style = getComputedStyle(root);
    const role = roleOf(root, style);
    lines.push({ depth: 0, role: role === 'generic' ? root.tagName.toLowerCase() : role, name: accessibleNameSafe(root, role), id: localId(root), props: elementProps(root, role) });
    if (role === 'iframe') lines[0].iframe = true;
    else for (const c of composedChildren(root)) visit(c, 1, true);
  } else {
    visit(root, 0, true);
  }
  flushText();
  return { lines, truncated };
}

/** Text used for find() scoring. */
export function searchableText(el: Element, role: string, name: string): string {
  const bits = [role, name, el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('type'), el.getAttribute('name'), el.id, el.getAttribute('aria-describedby') ? '' : null, el.getAttribute('data-testid'), el.getAttribute('alt')];
  if (role === 'clickable' || role === 'generic') bits.push(visibleText(el, 120));
  // class names often carry intent ("cart-btn", "search-input")
  const cls = typeof el.className === 'string' ? el.className : '';
  bits.push(cls.replace(/[-_]/g, ' ').slice(0, 120));
  return collapse(bits.filter(Boolean).join(' ')).toLowerCase();
}
