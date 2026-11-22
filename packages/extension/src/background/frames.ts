/**
 * Talking to content scripts in every frame, frame geometry (offset of each frame's viewport in
 * the top-level viewport, found with a postMessage probe that works across origins), and the
 * per-tab element reference registry (ref_N <-> frame + document + element id).
 */

export interface FrameInfo {
  frameId: number;
  parentFrameId: number;
  url: string;
}

interface ContentResponse<T> {
  ok: boolean;
  docNonce: string;
  result?: T;
  error?: string;
}

export class StaleRefError extends Error {}

export async function injectContent(tabId: number, frameIds?: number[]): Promise<void> {
  await chrome.scripting.executeScript({
    target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
    files: ['content.js'],
    injectImmediately: true,
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Error: the page did not respond to ${what} within ${ms / 1000}s.`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Send a message to the content script of one frame, injecting it if needed. */
export async function frameCall<T = any>(tabId: number, frameId: number, msg: Record<string, unknown>, timeoutMs = 10_000): Promise<{ result: T; docNonce: string }> {
  const attempt = async (): Promise<ContentResponse<T>> =>
    withTimeout(chrome.tabs.sendMessage(tabId, msg, { frameId }) as Promise<ContentResponse<T>>, timeoutMs, String(msg.type).replace('ba:', ''));
  let res: ContentResponse<T> | undefined;
  try {
    res = await attempt();
  } catch (e) {
    const m = (e as Error).message ?? '';
    if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(m)) {
      try {
        await injectContent(tabId, [frameId]);
      } catch (ie) {
        throw new Error(`Error: cannot read this page (${(ie as Error).message}). It may be a browser-internal or restricted page.`);
      }
      res = await attempt();
    } else throw e;
  }
  if (!res) throw new Error('Error: no response from the page.');
  if (!res.ok) throw new Error(res.error ?? 'Error: page script failed.');
  const r = res.result as any;
  if (r && typeof r === 'object' && typeof r.error === 'string' && r.error.startsWith('Error')) throw new Error(r.error);
  return { result: res.result as T, docNonce: res.docNonce };
}

export async function listFrames(tabId: number): Promise<FrameInfo[]> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  return frames
    .filter((f) => !f.errorOccurred && !/^(chrome-error|chrome-extension|devtools):/.test(f.url))
    .map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url }));
}

// Frame probes ----------------------------------------------------------------------------------

interface ProbeHit {
  iframeId: number;
  docNonce: string;
  offset: { x: number; y: number };
  width: number;
  height: number;
  visible: boolean;
  parentFrameId: number;
}

const probes = new Map<string, { tabId: number; resolve(h: ProbeHit): void }>();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'ba:probe_hit' || typeof msg.token !== 'string') return false;
  const p = probes.get(msg.token);
  if (!p || sender.tab?.id !== p.tabId) return false;
  probes.delete(msg.token);
  p.resolve({ iframeId: msg.iframeId, docNonce: msg.docNonce, offset: msg.offset, width: Number(msg.width) || 0, height: Number(msg.height) || 0, visible: !!msg.visible, parentFrameId: sender.frameId ?? 0 });
  return false;
});

/** Locate a child frame's <iframe> element inside its parent frame. */
export async function probeFrame(tabId: number, frameId: number, timeoutMs = 2000): Promise<ProbeHit> {
  const token = `baprobe_${crypto.randomUUID()}`;
  const hit = new Promise<ProbeHit>((resolve, reject) => {
    probes.set(token, { tabId, resolve });
    setTimeout(() => {
      if (probes.delete(token)) reject(new Error('Error: could not locate the frame on the page.'));
    }, timeoutMs);
  });
  await frameCall(tabId, frameId, { type: 'ba:probe_parent', token }, timeoutMs);
  return hit;
}

/** Offset of a frame's viewport origin within the top-level viewport (CSS px). */
export async function frameOffset(tabId: number, frameId: number): Promise<{ x: number; y: number }> {
  let x = 0;
  let y = 0;
  let cur = frameId;
  for (let guard = 0; cur !== 0 && guard < 20; guard++) {
    const hit = await probeFrame(tabId, cur);
    x += hit.offset.x;
    y += hit.offset.y;
    cur = hit.parentFrameId;
  }
  return { x, y };
}

// Reference registry ----------------------------------------------------------------------------

interface RefTarget {
  frameId: number;
  doc: string;
  id: number;
}

interface TabRefs {
  next: number;
  byRef: Record<string, RefTarget>;
  byKey: Record<string, string>;
}

const registry = new Map<number, TabRefs>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const data = (await chrome.storage.session.get('refs')).refs as Record<string, TabRefs> | undefined;
    if (data) for (const [k, v] of Object.entries(data)) if (!registry.has(Number(k))) registry.set(Number(k), v);
  } catch {
    /* storage.session unavailable */
  }
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const obj: Record<string, TabRefs> = {};
    for (const [k, v] of registry) obj[k] = v;
    chrome.storage.session.set({ refs: obj }).catch(() => {});
  }, 300);
}

function tabRefs(tabId: number): TabRefs {
  let r = registry.get(tabId);
  if (!r) {
    r = { next: 1, byRef: {}, byKey: {} };
    registry.set(tabId, r);
  }
  return r;
}

export async function refFor(tabId: number, frameId: number, doc: string, id: number): Promise<string> {
  await load();
  const r = tabRefs(tabId);
  const key = `${frameId}:${doc}:${id}`;
  let ref = r.byKey[key];
  if (!ref) {
    ref = `ref_${r.next++}`;
    r.byKey[key] = ref;
    r.byRef[ref] = { frameId, doc, id };
    save();
  }
  return ref;
}

export async function lookupRef(tabId: number, ref: string): Promise<RefTarget> {
  await load();
  const t = registry.get(tabId)?.byRef[String(ref).trim()];
  if (!t) throw new StaleRefError(`Error: ${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
  return t;
}

/** Top-level navigation: every reference handed out for the tab becomes invalid. */
export function resetRefs(tabId: number): void {
  if (registry.delete(tabId)) save();
}

/**
 * Call a content-script operation on the element behind a ref; detects replaced documents and
 * removed elements and reports them as stale.
 */
export async function refCall<T = any>(tabId: number, ref: string, msg: Record<string, unknown>, timeoutMs = 10_000): Promise<{ result: T; target: RefTarget }> {
  const target = await lookupRef(tabId, ref);
  let res: { result: T; docNonce: string };
  try {
    res = await frameCall<T>(tabId, target.frameId, { ...msg, id: target.id }, timeoutMs);
  } catch (e) {
    if (/No frame with id|Invalid frame|does not exist/i.test((e as Error).message)) {
      throw new StaleRefError(`Error: ${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    }
    throw e;
  }
  const r = res.result as any;
  if (res.docNonce !== target.doc || r?.stale) {
    throw new StaleRefError(`Error: ${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
  }
  return { result: res.result, target };
}
