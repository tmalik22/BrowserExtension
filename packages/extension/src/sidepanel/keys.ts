/**
 * Settings → API keys: paste a provider key, save it on the agent server, and test every model
 * that uses it. Keys are never sent back to the panel (only "saved …ab12").
 */
import type { ApiKeyInfo, KeyTestResult, ProfileTestResult } from '@ba/shared';

type Request = <T = any>(msg: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** Keys shown up front; the rest go under "More providers" until they are set. */
const PRIMARY = ['NANOGPT_API_KEY', 'ARK_API_KEY', 'NVIDIA_API_KEY'];

let request: Request;
let lastSig = '';
let current: ApiKeyInfo[] = [];
/** Last test outcome (or a status line) per key name, kept across re-renders. */
const outcome = new Map<string, KeyTestResult | string>();
const busy = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

export function initKeys(r: Request): void {
  request = r;
}

/** Re-render when the key list changed (or `force`), keeping anything the user has typed. */
export function renderKeys(keys: ApiKeyInfo[] | undefined, force = false): void {
  if (!keys) return;
  const sig = JSON.stringify(keys);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  current = keys;
  const box = document.getElementById('api-keys');
  if (!box) return;
  const typed = new Map<string, string>();
  box.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((i) => typed.set(i.dataset.key!, i.value));
  box.replaceChildren();
  if (!keys.length) {
    box.append(el('p', 'muted small', 'None of your models needs a key.'));
    return;
  }
  let main = keys.filter((k) => PRIMARY.includes(k.name) || k.set);
  if (!main.length) main = keys;
  const rest = keys.filter((k) => !main.includes(k));
  for (const k of main) box.append(row(k, typed.get(k.name)));
  if (rest.length) {
    const more = el('details', 'keys-more');
    more.append(el('summary', 'muted small', `More providers (${rest.map((k) => k.label).join(', ')})`));
    for (const k of rest) more.append(row(k, typed.get(k.name)));
    box.append(more);
  }
}

function row(k: ApiKeyInfo, typed?: string): HTMLElement {
  const wrap = el('div', 'key');
  wrap.dataset.name = k.name;
  const head = el('div', 'key-head');
  head.append(el('strong', undefined, k.label));
  const status = k.set ? `Saved${k.hint ? ` (…${k.hint})` : ''}${k.source === 'env' ? ' in .env' : ''}` : 'Not set';
  head.append(el('span', `key-status ${k.set ? 'ok' : 'missing'}`, status));
  wrap.append(head);
  if (k.usedBy.length) wrap.append(el('div', 'muted small', `Used by: ${k.usedBy.join(', ')}`));

  const line = el('div', 'row key-row');
  const input = el('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.key = k.name;
  input.placeholder = k.set ? 'Paste a new key to replace it' : 'Paste your key';
  input.value = typed ?? '';
  input.setAttribute('aria-label', `${k.label} API key`);
  const save = button('Save & test', 'primary', () => void saveKey(k.name, input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void saveKey(k.name, input);
  });
  line.append(input, save);
  if (k.set) line.append(button('Test', '', () => void testKey(k.name)));
  if (k.source === 'panel') line.append(button('Remove', '', () => void removeKey(k.name)));
  if (busy.has(k.name)) line.querySelectorAll('button').forEach((b) => (b.disabled = true));
  wrap.append(line);

  const res = el('div', 'key-result');
  res.setAttribute('aria-live', 'polite');
  renderOutcome(res, k.name);
  wrap.append(res);
  return wrap;
}

function renderOutcome(box: HTMLElement, name: string): void {
  box.replaceChildren();
  const o = outcome.get(name);
  if (!o) return;
  if (typeof o === 'string') {
    box.append(el('div', 'muted small', o));
    return;
  }
  for (const r of o.results) box.append(resultLine(name, r));
}

function resultLine(name: string, r: ProfileTestResult): HTMLElement {
  const d = el('div', `key-test ${r.ok ? 'ok' : 'bad'}`);
  d.append(el('span', 'key-icon', r.ok ? '✓' : '✗'), el('strong', undefined, r.label), document.createTextNode(` ${r.message}`));
  if (r.suggestions?.length) {
    const pick = el('div', 'row key-suggest');
    pick.append(el('span', 'muted small', 'Use instead:'));
    for (const id of r.suggestions) pick.append(button(id, 'small', () => void useModel(name, r.profileId, id)));
    d.append(pick);
  }
  return d;
}

function setOutcome(name: string, o: KeyTestResult | string): void {
  outcome.set(name, o);
  renderKeys(current, true);
}

async function saveKey(name: string, input: HTMLInputElement): Promise<void> {
  const key = input.value.trim();
  if (!key) {
    setOutcome(name, 'Paste a key first.');
    return;
  }
  // Clear the box before anything re-renders the list (which would carry the typed key over).
  input.value = '';
  busy.add(name);
  setOutcome(name, 'Saving…');
  try {
    current = await request<ApiKeyInfo[]>({ type: 'panel:apikey', name, key });
    busy.delete(name);
    await testKey(name);
  } catch (e) {
    busy.delete(name);
    setOutcome(name, `Not saved: ${(e as Error).message}`);
    const box = document.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(name)}"]`);
    if (box) box.value = key;
  }
}

async function testKey(name: string): Promise<void> {
  busy.add(name);
  const n = current.find((k) => k.name === name)?.usedBy.length ?? 1;
  setOutcome(name, `Testing ${n} model${n === 1 ? '' : 's'} with one small request each…`);
  try {
    const res = await request<KeyTestResult>({ type: 'panel:testkey', name }, 130_000);
    busy.delete(name);
    setOutcome(name, res);
  } catch (e) {
    busy.delete(name);
    setOutcome(name, `Test failed: ${(e as Error).message}`);
  }
}

async function removeKey(name: string): Promise<void> {
  try {
    current = await request<ApiKeyInfo[]>({ type: 'panel:apikey', name, key: '' });
    setOutcome(name, 'Removed.');
  } catch (e) {
    setOutcome(name, `Not removed: ${(e as Error).message}`);
  }
}

async function useModel(name: string, profileId: string, model: string): Promise<void> {
  try {
    await request({ type: 'panel:setmodel', profileId, model });
    await testKey(name);
  } catch (e) {
    setOutcome(name, `Could not switch the model: ${(e as Error).message}`);
  }
}
