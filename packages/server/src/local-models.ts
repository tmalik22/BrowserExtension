/**
 * Find models served by local Ollama and LM Studio instances, so they show up in the model
 * picker without anyone editing models.json. Each probe is quick and failures are silent: a
 * server that isn't running simply contributes nothing.
 */
import type { ModelProfile } from './providers/types.ts';

export interface LocalServer {
  kind: 'ollama' | 'lmstudio';
  /** Server root, e.g. http://127.0.0.1:11434 */
  url: string;
}

export const DEFAULT_LOCAL_SERVERS: LocalServer[] = [
  { kind: 'ollama', url: process.env.OLLAMA_HOST ? normalizeHost(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434' },
  { kind: 'lmstudio', url: 'http://127.0.0.1:1234' },
];

function normalizeHost(h: string): string {
  const withScheme = /^https?:\/\//.test(h) ? h : `http://${h}`;
  return withScheme.replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1');
}

/** Names that usually mean a vision-language model (used when the server doesn't say). */
const VISION_NAME = /(?:^|[^a-z])(vl|vision|llava|bakllava|moondream|minicpm-v|gemma-?3|pixtral|qwen2\.5-?vl|qwen3-?vl|internvl|smolvlm|granite3\.2-vision|mistral-small3\.[12]|llama4)/i;
/** Models that can't chat (embeddings, rerankers, speech). */
const NOT_CHAT = /embed|rerank|bge-|e5-|nomic|whisper|tts/i;

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 1500): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface Found {
  model: string;
  vision: boolean;
}

async function ollamaModels(root: string): Promise<Found[]> {
  const tags = await getJson(`${root}/api/tags`);
  const names: string[] = (tags?.models ?? [])
    .map((m: { name?: string; model?: string }) => (typeof (m.name ?? m.model) === 'string' ? cleanName(String(m.name ?? m.model)) : ''))
    .filter(Boolean)
    .slice(0, MAX_PER_SERVER);
  const out: Found[] = [];
  for (const name of names) {
    if (NOT_CHAT.test(name)) continue;
    let vision = VISION_NAME.test(name);
    try {
      // Newer Ollama reports capabilities (e.g. ["completion","tools","vision"]).
      const info = await getJson(`${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) });
      if (Array.isArray(info?.capabilities)) {
        if (!info.capabilities.includes('completion')) continue;
        vision = info.capabilities.includes('vision');
      }
    } catch {
      /* older Ollama: keep the name-based guess */
    }
    out.push({ model: name, vision });
  }
  return out;
}

/**
 * Merge detected models into the profile list: drop example profiles that point at a running
 * local server but name a model it doesn't have, add the detected ones (before the mock), and
 * pick a detected model as the default when the configured one can't be used.
 */
export function mergeDetected(
  profiles: ModelProfile[],
  defaultProfileId: string,
  detected: { profiles: ModelProfile[]; served: Map<string, Set<string>> },
  usable: (p: ModelProfile) => boolean,
): { profiles: ModelProfile[]; defaultProfileId: string } {
  const norm = (u?: string) => (u ?? '').replace(/\/+$/, '').replace('localhost', '127.0.0.1');
  const kept = profiles.filter((p) => {
    const models = [...detected.served.entries()].find(([url]) => norm(url) === norm(p.baseURL))?.[1];
    return !models || models.has(p.model);
  });
  const mockAt = kept.findIndex((p) => p.provider === 'mock');
  const merged = mockAt < 0 ? [...kept, ...detected.profiles] : [...kept.slice(0, mockAt), ...detected.profiles, ...kept.slice(mockAt)];
  // A detected model is never made the default on its own: whatever answers on a local port only
  // gets your pages once you pick it in the model menu.
  const current = merged.find((p) => p.id === defaultProfileId);
  const def = current ? defaultProfileId : (merged.find((p) => usable(p) && p.provider !== 'mock' && !p.detected)?.id ?? merged.find((p) => p.provider === 'mock')?.id ?? merged[0].id);
  return { profiles: merged, defaultProfileId: def };
}

async function lmstudioModels(root: string): Promise<Found[]> {
  try {
    // LM Studio's own API says which models are VLMs and which are embeddings.
    const native = await getJson(`${root}/api/v0/models`);
    if (Array.isArray(native?.data)) {
      return native.data
        .filter((m: { type?: string; id?: string }) => m.id && (m.type === 'llm' || m.type === 'vlm') && !NOT_CHAT.test(m.id))
        .map((m: { id: string; type?: string }) => ({ model: cleanName(String(m.id)), vision: m.type === 'vlm' || VISION_NAME.test(String(m.id)) }))
        .filter((m: { model: string }) => m.model);
    }
  } catch {
    /* fall back to the OpenAI-compatible list */
  }
  const list = await getJson(`${root}/v1/models`);
  return (list?.data ?? [])
    .map((m: { id?: string }) => (typeof m.id === 'string' ? cleanName(m.id) : ''))
    .filter((id: string) => !!id && !NOT_CHAT.test(id))
    .map((id: string) => ({ model: id, vision: VISION_NAME.test(id) }));
}

/** A local server can't flood the model menu. */
const MAX_PER_SERVER = 40;
/** Model names come from whatever answers on the port: keep them short and printable. */
const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Profiles for every chat model the local servers serve, skipping ones a configured profile
 * already covers (same endpoint and model).
 */
export async function detectLocalModels(
  existing: ModelProfile[],
  servers: LocalServer[] = DEFAULT_LOCAL_SERVERS,
): Promise<{ profiles: ModelProfile[]; served: Map<string, Set<string>> }> {
  const sameEndpoint = (a?: string, b?: string) => (a ?? '').replace(/\/+$/, '').replace('localhost', '127.0.0.1') === (b ?? '').replace(/\/+$/, '').replace('localhost', '127.0.0.1');
  const results = await Promise.all(
    servers.map(async (srv) => {
      try {
        const found = srv.kind === 'ollama' ? await ollamaModels(srv.url) : await lmstudioModels(srv.url);
        return { srv, found };
      } catch {
        return { srv, found: [] as Found[] };
      }
    }),
  );
  const ids = new Set(existing.map((p) => p.id));
  const out: ModelProfile[] = [];
  /** Every chat model each running server has, keyed by its /v1 base URL. */
  const served = new Map<string, Set<string>>();
  for (const { srv, found } of results) {
    const baseURL = `${srv.url}/v1`;
    if (found.length) served.set(baseURL, new Set(found.map((f) => f.model)));
    for (const f of found.slice(0, MAX_PER_SERVER)) {
      if (existing.some((p) => sameEndpoint(p.baseURL, baseURL) && p.model === f.model)) continue;
      let id = `${srv.kind}-${slug(f.model)}`;
      for (let n = 2; ids.has(id); n++) id = `${srv.kind}-${slug(f.model)}-${n}`;
      ids.add(id);
      out.push({
        id,
        label: `${f.model} (${srv.kind === 'ollama' ? 'Ollama' : 'LM Studio'})`,
        provider: 'openai',
        model: f.model,
        baseURL,
        apiKey: srv.kind,
        vision: f.vision,
        toolSet: 'compact',
        keepImages: 1,
        timeoutMs: 600_000,
        detected: true,
      } as ModelProfile);
    }
  }
  return { profiles: out, served };
}
