/**
 * Searchable model picker. Providers' live model lists can hold hundreds of models, so the
 * composer shows a button with the current model, and a menu with a search box, the models you
 * used recently, and every model grouped by provider. The hidden <select id="model"> stays the
 * source of truth (the rest of the panel reads its value); the picker just drives it.
 */
import type { ProfileInfo } from '@ba/shared';

const RECENT_KEY = 'recentProfiles';
const GROUP_ORDER = ['Local', 'Anthropic', 'OpenAI', 'Google Gemini', 'OpenRouter', 'NVIDIA NIM', 'NanoGPT', 'Groq', 'xAI', 'DeepSeek', 'Mistral'];

interface PickerDeps {
  select: HTMLSelectElement;
  profiles: () => ProfileInfo[];
  /** Re-scan local servers and refresh provider model lists. */
  refresh: () => Promise<void>;
  openSettings: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function recent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 5)));
}

const groupRank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g);
  return g === 'Testing' ? 1000 : g === 'Custom' ? 900 : i >= 0 ? i : 500;
};

export function initModelPicker(deps: PickerDeps): { render(): void } {
  const { select } = deps;
  const btn = el('button', 'model-btn');
  btn.type = 'button';
  btn.id = 'model-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const btnLabel = el('span', 'model-btn-label');
  btn.append(btnLabel, el('span', 'model-btn-chevron', '▾'));
  select.classList.add('model-select-hidden');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(btn);

  const menu = el('div', 'model-menu hidden');
  menu.id = 'model-menu';
  const search = el('input', 'model-search');
  search.type = 'search';
  search.placeholder = 'Search models…';
  search.setAttribute('aria-label', 'Search models');
  const list = el('div', 'model-list');
  list.setAttribute('role', 'listbox');
  const foot = el('div', 'model-foot');
  const refreshBtn = el('button', 'link', 'Refresh model lists');
  refreshBtn.type = 'button';
  const keysBtn = el('button', 'link', 'Add API keys');
  keysBtn.type = 'button';
  const count = el('span', 'muted small');
  foot.append(count, refreshBtn, keysBtn);
  menu.append(search, list, foot);
  (select.closest('.composer') ?? document.body).append(menu);

  let items: HTMLElement[] = [];
  let active = -1;

  const current = () => deps.profiles().find((p) => p.id === select.value);

  function renderButton(): void {
    const p = current();
    btnLabel.replaceChildren(el('span', 'model-name', p?.label ?? 'Choose a model'));
    if (p?.group && p.group !== 'Testing') btnLabel.append(el('span', 'model-tag', p.group));
    btn.title = p ? `${p.label} · ${p.model}${p.vision ? '' : ' · no vision'}` : 'Choose a model';
  }

  function row(p: ProfileInfo): HTMLElement {
    const r = el('div', `model-item${p.available ? '' : ' disabled'}${p.id === select.value ? ' selected' : ''}`);
    r.setAttribute('role', 'option');
    r.dataset.id = p.id;
    r.setAttribute('aria-selected', String(p.id === select.value));
    r.title = p.available ? `${p.model}${p.vision ? '' : ' · text only'}` : (p.unavailableReason ?? 'Unavailable');
    const name = el('span', 'model-item-name', p.label);
    const badges = el('span', 'model-badges');
    if (p.vision) badges.append(el('span', 'badge', 'vision'));
    if (p.source === 'local') badges.append(el('span', 'badge local', 'local'));
    if (!p.available) badges.append(el('span', 'badge warn', 'needs key'));
    r.append(name, badges);
    if (p.available) r.onclick = () => choose(p.id);
    return r;
  }

  function renderList(): void {
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = deps.profiles();
    const match = (p: ProfileInfo) => {
      const hay = `${p.label} ${p.model} ${p.group ?? ''}`.toLowerCase();
      return q.every((t) => hay.includes(t));
    };
    const shown = all.filter(match);
    list.replaceChildren();
    items = [];
    if (!q.length) {
      const rec = recent()
        .map((id) => all.find((p) => p.id === id && p.available))
        .filter((p): p is ProfileInfo => !!p);
      if (rec.length) {
        list.append(el('div', 'model-group', 'Recent'));
        for (const p of rec) list.append(row(p));
      }
    }
    const groups = new Map<string, ProfileInfo[]>();
    for (const p of shown) {
      const g = p.group ?? 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    }
    const ordered = [...groups.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0]));
    for (const [g, ps] of ordered) {
      // Available models first within a group.
      ps.sort((a, b) => Number(b.available) - Number(a.available));
      list.append(el('div', 'model-group', `${g} · ${ps.length}`));
      for (const p of ps) list.append(row(p));
    }
    if (!shown.length) list.append(el('div', 'muted small model-empty', 'No models match. Add API keys in Settings, or start Ollama / LM Studio and refresh.'));
    items = [...list.querySelectorAll<HTMLElement>('.model-item:not(.disabled)')];
    active = -1;
    count.textContent = `${all.filter((p) => p.available).length} models ready`;
  }

  function setActive(i: number): void {
    items[active]?.classList.remove('active');
    active = Math.max(0, Math.min(items.length - 1, i));
    const it = items[active];
    if (!it) return;
    it.classList.add('active');
    it.scrollIntoView({ block: 'nearest' });
  }

  function open(): void {
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    search.value = '';
    renderList();
    search.focus();
    list.querySelector('.selected')?.scrollIntoView({ block: 'center' });
  }

  function close(): void {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function choose(id: string): void {
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    remember(id);
    renderButton();
    close();
    btn.focus();
  }

  btn.onclick = () => (menu.classList.contains('hidden') ? open() : close());
  search.oninput = () => renderList();
  search.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[active >= 0 ? active : 0];
      if (it?.dataset.id) choose(it.dataset.id);
    } else if (e.key === 'Escape') {
      close();
      btn.focus();
    }
  };
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) close();
  });
  select.addEventListener('change', () => renderButton());
  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    try {
      await deps.refresh();
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh model lists';
      renderList();
    }
  };
  keysBtn.onclick = () => {
    close();
    deps.openSettings();
  };

  return {
    render() {
      renderButton();
      if (!menu.classList.contains('hidden')) renderList();
    },
  };
}
