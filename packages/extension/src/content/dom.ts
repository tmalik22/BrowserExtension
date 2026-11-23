/**
 * DOM helpers shared by the content-script features: element ids (stable per document),
 * accessible roles and names, visibility, and composed-tree traversal (open shadow roots, slots).
 */

export const OVERLAY_ATTR = 'data-ba-overlay';

// ---------------------------------------------------------------------------------------------
// Stable per-document element ids. The service worker maps (frame, docNonce, localId) -> ref_N.
// ---------------------------------------------------------------------------------------------

export const docNonce = Math.random().toString(36).slice(2, 10);
const idOf = new WeakMap<Element, number>();
const byId = new Map<number, WeakRef<Element>>();
let nextId = 1;

export function localId(el: Element): number {
  let id = idOf.get(el);
  if (id === undefined) {
    id = nextId++;
    idOf.set(el, id);
    byId.set(id, new WeakRef(el));
  }
  return id;
}

export function elementById(id: number): Element | null {
  const el = byId.get(id)?.deref();
  if (!el || !el.isConnected) return null;
  return el;
}

// ---------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------

/** Children in the composed (rendered) tree: shadow root content and slotted nodes. */
export function composedChildren(node: Node): Node[] {
  if (node instanceof Element) {
    const sr = node.shadowRoot;
    if (sr) return Array.from(sr.childNodes);
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(node.childNodes);
    }
  }
  return Array.from(node.childNodes);
}

export function composedParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  const p = el.parentNode;
  if (p instanceof ShadowRoot) return p.host;
  return p instanceof Element ? p : null;
}

export function composedContains(ancestor: Element, node: Element | null): boolean {
  let cur: Element | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = composedParent(cur);
  }
  return false;
}

/** Deepest element at a point, piercing open shadow roots. */
/**
 * The page's element at a point. The agent's own overlay (pill, input lock) is looked through:
 * its input is delivered past it, so what counts is what the page has there.
 */
export function deepElementFromPoint(x: number, y: number): Element | null {
  let el: Element | null = document.elementsFromPoint(x, y).find((e) => !e.hasAttribute(OVERLAY_ATTR)) ?? null;
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

export function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// ---------------------------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------------------------

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE', 'TITLE']);

export function isSkippedTag(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName) || el.hasAttribute(OVERLAY_ATTR);
}

/** Subtree hidden from users and assistive tech (display:none, hidden, aria-hidden, inert). */
export function isSubtreeHidden(el: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if ((el as HTMLElement).hidden && style.display === 'none') return true;
  if (el.hasAttribute('inert')) return true;
  if (style.contentVisibility === 'hidden') return true;
  return false;
}

export function isSelfInvisible(style: CSSStyleDeclaration): boolean {
  return style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0;
}

export function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

export function hasArea(r: DOMRect): boolean {
  return r.width >= 1 && r.height >= 1;
}

export function intersectsViewport(r: DOMRect): boolean {
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell',
  'scrollbar', 'clickable', 'iframe', 'video', 'audio',
]);

const STRUCTURAL_ROLES = new Set([
  'heading', 'img', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'region', 'search',
  'dialog', 'alertdialog', 'alert', 'status', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader',
  'rowheader', 'article', 'menu', 'menubar', 'tablist', 'tabpanel', 'tree', 'grid', 'group', 'figure',
  'separator', 'progressbar', 'meter', 'paragraph', 'blockquote', 'code', 'term', 'definition', 'toolbar',
  'label', 'legend', 'caption', 'math', 'note', 'tooltip', 'log', 'marquee', 'timer', 'application', 'document',
]);

function inputRole(el: HTMLInputElement): string {
  const t = (el.getAttribute('type') || 'text').toLowerCase();
  switch (t) {
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
    case 'file':
      return 'button';
    case 'checkbox':
      return el.getAttribute('role') === 'switch' ? 'switch' : 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return el.hasAttribute('list') ? 'combobox' : 'searchbox';
    case 'hidden':
      return 'none';
    case 'color':
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'time':
    case 'week':
      return 'textbox';
    default:
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
  }
}

function isContentEditable(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  if (ce === null) return false;
  if (ce === 'false') return false;
  // Only the editing host, not its descendants.
  const p = composedParent(el);
  return !(p && (p as HTMLElement).isContentEditable);
}

/** Implicit/explicit ARIA role, plus "clickable" for generic elements with click affordances. */
export function roleOf(el: Element, style?: CSSStyleDeclaration): string {
  // The role goes into the page outline unquoted, so only a plain role token is taken from the page.
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit && /^[a-z]{1,40}$/.test(explicit) && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') return explicit;
  const tag = el.tagName;
  switch (tag) {
    case 'A':
    case 'AREA':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'BUTTON':
      return 'button';
    case 'INPUT':
      return inputRole(el as HTMLInputElement);
    case 'SELECT': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'OPTION':
      return 'option';
    case 'IMG':
      return el.getAttribute('alt') === '' ? 'none' : 'img';
    case 'SVG':
    case 'svg':
      return el.querySelector(':scope > title') || el.getAttribute('aria-label') ? 'img' : 'none';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'NAV':
      return 'navigation';
    case 'MAIN':
      return 'main';
    case 'HEADER':
      return closestLandmark(el) ? 'generic' : 'banner';
    case 'FOOTER':
      return closestLandmark(el) ? 'generic' : 'contentinfo';
    case 'ASIDE':
      return 'complementary';
    case 'FORM':
      return 'form';
    case 'SECTION':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'generic';
    case 'ARTICLE':
      return 'article';
    case 'DIALOG':
      return 'dialog';
    case 'UL':
    case 'OL':
    case 'MENU':
      return 'list';
    case 'LI':
      return 'listitem';
    case 'TABLE':
      return 'table';
    case 'TR':
      return 'row';
    case 'TD':
      return 'cell';
    case 'TH':
      return (el as HTMLTableCellElement).scope === 'row' ? 'rowheader' : 'columnheader';
    case 'SUMMARY':
      return 'button';
    case 'DETAILS':
      return 'group';
    case 'FIELDSET':
      return 'group';
    case 'LEGEND':
      return 'legend';
    case 'LABEL':
      // Label text becomes the control's name; the label itself is a plain container.
      return 'generic';
    case 'FIGURE':
      return 'figure';
    case 'HR':
      return 'separator';
    case 'PROGRESS':
      return 'progressbar';
    case 'METER':
      return 'meter';
    case 'IFRAME':
    case 'FRAME':
      return 'iframe';
    case 'VIDEO':
      return 'video';
    case 'AUDIO':
      return 'audio';
    case 'CANVAS':
      return 'canvas';
    case 'P':
      return 'paragraph';
    case 'BLOCKQUOTE':
      return 'blockquote';
    case 'PRE':
    case 'CODE':
      return 'code';
    case 'DT':
      return 'term';
    case 'DD':
      return 'definition';
  }
  if (isContentEditable(el)) return 'textbox';
  if (isGenericClickable(el, style)) return 'clickable';
  return 'generic';
}

function closestLandmark(el: Element): boolean {
  let p = composedParent(el);
  while (p) {
    if (['ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'SECTION'].includes(p.tagName)) return true;
    p = composedParent(p);
  }
  return false;
}

/** Divs/spans that behave like buttons: onclick attribute, tabindex, or a pointer cursor of their own. */
function isGenericClickable(el: Element, style?: CSSStyleDeclaration): boolean {
  if (el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('@click') || el.hasAttribute('v-on:click')) return true;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) >= 0 && el !== document.body) return true;
  const st = style ?? getComputedStyle(el);
  if (st.cursor === 'pointer') {
    const p = composedParent(el);
    if (!p) return true;
    return getComputedStyle(p).cursor !== 'pointer';
  }
  return false;
}

export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

export function isStructuralRole(role: string): boolean {
  return STRUCTURAL_ROLES.has(role);
}

/** Roles whose name already summarises their content; children text is not repeated. */
export const LEAF_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'img', 'heading', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'progressbar', 'meter',
  'separator', 'clickable', 'treeitem', 'legend',
]);

// ---------------------------------------------------------------------------------------------
// Accessible names
// ---------------------------------------------------------------------------------------------

export function collapse(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function rootOf(el: Element): Document | ShadowRoot {
  const r = el.getRootNode();
  return r instanceof ShadowRoot ? r : document;
}

function idRefText(el: Element, attr: string): string {
  const ids = el.getAttribute(attr);
  if (!ids) return '';
  const root = rootOf(el);
  return collapse(
    ids
      .split(/\s+/)
      .map((id) => {
        const t = root instanceof Document ? root.getElementById(id) : root.querySelector(`#${CSS.escape(id)}`);
        return t ? visibleText(t, 300) : '';
      })
      .join(' '),
  );
}

/** Text of the composed (flattened) tree: follows shadow roots and slot assignments. */
export function composedText(node: Node, max = 400): string {
  let out = '';
  const visit = (n: Node) => {
    if (out.length > max) return;
    if (n.nodeType === Node.TEXT_NODE) {
      out += ' ' + (n.textContent ?? '');
      return;
    }
    if (n instanceof Element) {
      if (SKIP_TAGS.has(n.tagName)) return;
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return;
    }
    for (const c of composedChildren(n)) visit(c);
  };
  visit(node);
  return collapse(out);
}

/** Rendered text of an element (innerText where available), capped. */
export function visibleText(el: Element, max = 200): string {
  let t = '';
  if (el instanceof HTMLElement) t = el.innerText ?? el.textContent ?? '';
  else t = el.textContent ?? '';
  t = collapse(t);
  // innerText does not see slotted or shadow content.
  if (!t || el.shadowRoot || el.querySelector('slot')) {
    const ct = composedText(el, max + 50);
    if (ct.length > t.length) t = ct;
  }
  if (!t) {
    // Image-only content: use alt text.
    const img = el.querySelector('img[alt]:not([alt=""]), svg[aria-label], [role="img"][aria-label]');
    if (img) t = collapse(img.getAttribute('alt') || img.getAttribute('aria-label'));
  }
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function labelText(el: Element): string {
  const parts: string[] = [];
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    for (const l of Array.from(labels)) {
      // Label text without the control's own text.
      const clone = l.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input,select,textarea,button').forEach((n) => n.remove());
      parts.push(collapse(clone.textContent));
    }
  }
  return collapse(parts.join(' '));
}

export function accessibleName(el: Element, role: string): string {
  const lb = idRefText(el, 'aria-labelledby');
  if (lb) return lb;
  const al = collapse(el.getAttribute('aria-label'));
  if (al) return al;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) return collapse(input.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    if (tag === 'INPUT' && type === 'image') return collapse(input.alt) || 'Submit';
    const lt = labelText(el);
    if (lt) return lt;
    if (tag === 'INPUT' && type === 'file') return 'Choose File';
    const t = collapse(el.getAttribute('title'));
    if (t) return t;
    const ph = collapse(el.getAttribute('placeholder'));
    if (ph) return ph;
    return '';
  }
  if (tag === 'IMG' || tag === 'AREA') return collapse(el.getAttribute('alt')) || collapse(el.getAttribute('title'));
  if (tag === 'svg' || tag === 'SVG') return collapse(el.querySelector(':scope > title')?.textContent) || '';
  if (tag === 'IFRAME' || tag === 'FRAME') return collapse(el.getAttribute('title')) || collapse(el.getAttribute('name')) || '';
  if (tag === 'FIELDSET') return collapse(el.querySelector(':scope > legend')?.textContent);
  if (tag === 'TABLE') return collapse(el.querySelector(':scope > caption')?.textContent);
  if (tag === 'FIGURE') return collapse(el.querySelector(':scope > figcaption')?.textContent);
  if (isContentEditable(el)) return collapse(el.getAttribute('title')) || collapse(el.getAttribute('placeholder')) || collapse(el.getAttribute('data-placeholder'));
  if (LEAF_ROLES.has(role) || role === 'cell' || role === 'columnheader' || role === 'rowheader' || role === 'listitem' || role === 'paragraph') {
    const t = visibleText(el, 150);
    if (t) return t;
  }
  return collapse(el.getAttribute('title'));
}

/** Current value shown to the model (masked for sensitive fields). */
export function valueOf(el: Element, sensitive: boolean): string | undefined {
  if (el instanceof HTMLSelectElement) {
    const sel = Array.from(el.selectedOptions).map((o) => collapse(o.label || o.text));
    return sel.join(', ');
  }
  if (el instanceof HTMLInputElement) {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(t)) return undefined;
    if (t === 'file') return el.files?.length ? Array.from(el.files).map((f) => f.name).join(', ') : '';
    if (sensitive) return el.value ? '••••••' : '';
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return sensitive ? (el.value ? '••••••' : '') : el.value;
  if (isContentEditable(el)) return collapse((el as HTMLElement).innerText).slice(0, 300);
  const vn = el.getAttribute('aria-valuenow');
  if (vn !== null) return el.getAttribute('aria-valuetext') ?? vn;
  return undefined;
}
