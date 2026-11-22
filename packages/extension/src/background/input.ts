/**
 * Keyboard and mouse input through CDP. Key specs follow the browser toolset: a key ("Enter"), a
 * chord ("ctrl+a"), or a space-separated sequence ("Tab Tab Enter"). xdotool-style names are
 * accepted too, since models often use them.
 */
import { openDialog, send as cdpSend } from './cdp.ts';

/**
 * Input events that open a JS dialog (alert/confirm/prompt) don't complete until the dialog is
 * closed, so input dispatch returns as soon as a dialog appears; the executor then reports it.
 */
function send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!method.startsWith('Input.')) return cdpSend(tabId, method, params);
  if (openDialog(tabId)) return Promise.resolve(undefined);
  const p = cdpSend(tabId, method, params);
  p.catch(() => {});
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setInterval(() => {
      if (!done && openDialog(tabId)) {
        done = true;
        clearInterval(timer);
        resolve(undefined);
      }
    }, 25);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        reject(e);
      },
    );
  });
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  shiftKey?: string;
  shiftText?: string;
  location?: number;
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  capslock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  return: 'enter', kp_enter: 'enter', esc: 'escape', back_space: 'backspace', bksp: 'backspace', del: 'delete',
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
  page_up: 'pageup', page_down: 'pagedown', prior: 'pageup', next: 'pagedown', pgup: 'pageup', pgdn: 'pagedown',
  ctrl: 'control', control_l: 'control', control_r: 'control', shift_l: 'shift', shift_r: 'shift',
  alt_l: 'alt', alt_r: 'alt', option: 'alt', opt: 'alt',
  cmd: 'meta', command: 'meta', super: 'meta', super_l: 'meta', win: 'meta', windows: 'meta', meta_l: 'meta',
  spacebar: 'space', ' ': 'space', caps_lock: 'capslock', menu: 'contextmenu', ins: 'insert',
};

const MODIFIER_NAMES: Record<string, keyof typeof MOD> = { control: 'ctrl', shift: 'shift', alt: 'alt', meta: 'meta' };

const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};
const PUNCT_CODES: Record<string, [string, number]> = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
};

/** Definition for a single printable character (US layout); needsShift for shifted symbols/caps. */
export function charDef(ch: string): { def: KeyDef; needsShift: boolean } | null {
  if (/^[a-z]$/.test(ch)) return { def: { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch }, needsShift: false };
  if (/^[A-Z]$/.test(ch)) return { def: { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch }, needsShift: true };
  if (/^[0-9]$/.test(ch)) return { def: { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch }, needsShift: false };
  if (PUNCT_CODES[ch]) return { def: { key: ch, code: PUNCT_CODES[ch][0], keyCode: PUNCT_CODES[ch][1], text: ch }, needsShift: false };
  if (SHIFTED[ch]) {
    const base = SHIFTED[ch];
    const b = charDef(base)!;
    return { def: { ...b.def, key: ch, text: ch }, needsShift: true };
  }
  if (ch === ' ') return { def: NAMED.space, needsShift: false };
  return null;
}

export interface Chord {
  modifiers: number;
  def: KeyDef;
}

export function parseChord(spec: string): Chord {
  const raw = spec.trim();
  // "+" alone (or ending in "++") is the plus key.
  const pieces = raw === '+' ? ['+'] : raw.replace(/\+\+$/, '+plus').split('+').map((p) => (p === 'plus' ? '+' : p));
  let modifiers = 0;
  let def: KeyDef | null = null;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const lower = p.toLowerCase();
    const name = ALIASES[lower] ?? lower;
    const isLast = i === pieces.length - 1;
    if (MODIFIER_NAMES[name] && !isLast) {
      modifiers |= MOD[MODIFIER_NAMES[name]];
      continue;
    }
    if (NAMED[name]) {
      def = NAMED[name];
      if (MODIFIER_NAMES[name]) modifiers |= MOD[MODIFIER_NAMES[name]];
    } else if (p.length === 1) {
      const c = charDef(p);
      if (!c) def = { key: p, code: '', keyCode: 0, text: p };
      else {
        def = c.def;
        if (c.needsShift) modifiers |= MOD.shift;
      }
    } else throw new Error(`Error: unknown key "${p}" in "${spec}".`);
  }
  if (!def) throw new Error(`Error: no key in "${spec}".`);
  return { modifiers, def };
}

export function parseKeySequence(text: string): Chord[] {
  const t = text.trim();
  if (!t) throw new Error('Error: key requires text.');
  if (t === ' ') return [parseChord('space')];
  return t.split(/\s+/).map(parseChord);
}

/** Editing commands Chrome only performs when told to (CDP key events don't trigger them). */
function commandsFor(c: Chord): string[] | undefined {
  const ctrlOrMeta = (c.modifiers & (MOD.ctrl | MOD.meta)) !== 0;
  if (!ctrlOrMeta) return undefined;
  const shift = (c.modifiers & MOD.shift) !== 0;
  switch (c.def.code) {
    case 'KeyA':
      return ['selectAll'];
    case 'KeyC':
      return ['copy'];
    case 'KeyX':
      return ['cut'];
    case 'KeyV':
      return shift ? ['pasteAndMatchStyle'] : ['paste'];
    case 'KeyZ':
      return shift ? ['redo'] : ['undo'];
    case 'KeyY':
      return ['redo'];
    case 'Backspace':
      return ['deleteWordBackward'];
    case 'Delete':
      return ['deleteWordForward'];
    case 'ArrowLeft':
      return shift ? ['moveWordLeftAndModifySelection'] : ['moveWordLeft'];
    case 'ArrowRight':
      return shift ? ['moveWordRightAndModifySelection'] : ['moveWordRight'];
    case 'Home':
      return shift ? ['moveToBeginningOfDocumentAndModifySelection'] : ['moveToBeginningOfDocument'];
    case 'End':
      return shift ? ['moveToEndOfDocumentAndModifySelection'] : ['moveToEndOfDocument'];
  }
  return undefined;
}

const MOD_KEYS: [number, KeyDef][] = [
  [MOD.ctrl, NAMED.control],
  [MOD.shift, NAMED.shift],
  [MOD.alt, NAMED.alt],
  [MOD.meta, NAMED.meta],
];

async function keyEvent(tabId: number, type: 'keyDown' | 'keyUp' | 'rawKeyDown', def: KeyDef, modifiers: number, extra: Record<string, unknown> = {}): Promise<void> {
  await send(tabId, 'Input.dispatchKeyEvent', {
    type,
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    location: def.location ?? 0,
    ...extra,
  });
}

export async function pressChord(tabId: number, c: Chord, hold = 0): Promise<void> {
  // Press modifiers.
  let held = 0;
  for (const [bit, def] of MOD_KEYS) {
    if (c.modifiers & bit && c.def.key !== def.key) {
      held |= bit;
      await keyEvent(tabId, 'rawKeyDown', def, held);
    }
  }
  const isModifierOnly = MOD_KEYS.some(([, d]) => d.key === c.def.key);
  // Text is produced only without ctrl/alt/meta.
  const producesText = !!c.def.text && (c.modifiers & (MOD.ctrl | MOD.alt | MOD.meta)) === 0;
  const commands = commandsFor(c);
  await keyEvent(tabId, producesText ? 'keyDown' : 'rawKeyDown', c.def, c.modifiers, {
    ...(producesText ? { text: c.def.text, unmodifiedText: c.def.text } : {}),
    ...(commands ? { commands } : {}),
    ...(isModifierOnly ? {} : {}),
  });
  if (hold > 0) {
    const until = Date.now() + hold;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
      if (!isModifierOnly && Date.now() < until) await keyEvent(tabId, producesText ? 'keyDown' : 'rawKeyDown', c.def, c.modifiers, { autoRepeat: true, ...(producesText ? { text: c.def.text } : {}) });
    }
  }
  await keyEvent(tabId, 'keyUp', c.def, c.modifiers);
  for (const [bit, def] of [...MOD_KEYS].reverse()) {
    if (held & bit) {
      held &= ~bit;
      await keyEvent(tabId, 'keyUp', def, held);
    }
  }
}

/** Type literal text: realistic key events for short ASCII text, insertText for the rest. */
export async function typeText(tabId: number, text: string): Promise<void> {
  const realistic = text.length <= 400;
  let buffer = '';
  const flush = async () => {
    if (buffer) {
      await send(tabId, 'Input.insertText', { text: buffer });
      buffer = '';
    }
  };
  for (const ch of Array.from(text)) {
    if (ch === '\n' || ch === '\r') {
      await flush();
      if (ch === '\n') await pressChord(tabId, { modifiers: 0, def: NAMED.enter });
      continue;
    }
    if (ch === '\t') {
      await flush();
      await pressChord(tabId, { modifiers: 0, def: NAMED.tab });
      continue;
    }
    const cd = realistic ? charDef(ch) : null;
    if (cd) {
      await flush();
      const mods = cd.needsShift ? MOD.shift : 0;
      await keyEvent(tabId, 'keyDown', cd.def, mods, { text: ch, unmodifiedText: ch });
      await keyEvent(tabId, 'keyUp', cd.def, mods);
    } else {
      buffer += ch;
    }
  }
  await flush();
}

// Mouse -----------------------------------------------------------------------------------------

export type Button = 'left' | 'right' | 'middle' | 'none';

const BUTTON_MASK: Record<Button, number> = { none: 0, left: 1, right: 2, middle: 4 };

export function parseModifiers(spec: unknown): number {
  if (typeof spec !== 'string' || !spec.trim()) return 0;
  let m = 0;
  for (const p of spec.toLowerCase().split('+')) {
    const name = ALIASES[p.trim()] ?? p.trim();
    const k = MODIFIER_NAMES[name];
    if (!k) throw new Error(`Error: unknown modifier "${p}".`);
    m |= MOD[k];
  }
  return m;
}

export async function mouseMove(tabId: number, x: number, y: number, buttons = 0, modifiers = 0): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, modifiers, pointerType: 'mouse' });
}

export async function click(tabId: number, x: number, y: number, button: Button, clickCount: number, modifiers: number, dwellMs = 0): Promise<void> {
  await mouseMove(tabId, x, y, 0, modifiers);
  // Like a real pointer, rest briefly before pressing so hover-revealed UI (video player
  // controls, menus) is shown and receives the click.
  if (dwellMs > 0) await new Promise((r) => setTimeout(r, dwellMs));
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button], clickCount: i, modifiers, pointerType: 'mouse' });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers, pointerType: 'mouse' });
  }
}

export async function mouseDown(tabId: number, x: number, y: number): Promise<void> {
  await mouseMove(tabId, x, y);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
}

export async function mouseUp(tabId: number, x: number, y: number): Promise<void> {
  await mouseMove(tabId, x, y, 1);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

export async function drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await mouseDown(tabId, from.x, from.y);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await mouseMove(tabId, x, y, 1);
    await new Promise((r) => setTimeout(r, 16));
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

export async function wheel(tabId: number, x: number, y: number, dx: number, dy: number): Promise<void> {
  await mouseMove(tabId, x, y);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, pointerType: 'mouse' });
}
