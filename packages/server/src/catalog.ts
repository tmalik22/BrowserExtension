/**
 * Live model catalogs: for every provider the user has a key for, fetch the provider's current
 * model list, so new models appear without anyone editing models.json. Lists are cached in
 * data/catalog.json, refreshed daily, when a key is saved, and on demand from the side panel.
 * Profiles written in models.json always take precedence over catalog entries for the same model.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelProfile } from './providers/types.ts';

export interface CatalogModel {
  id: string;
  name: string;
  vision: boolean;
  /** false when the provider says the model can't call tools (it then uses JSON tool mode). */
  tools?: boolean;
}

export interface CatalogProvider {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai';
  /** API base for requests (OpenAI-compatible providers); undefined = provider default. */
  baseURL?: string;
  keyEnv: string;
  /** Fetch and filter the provider's chat models. */
  list(key: string, signal: AbortSignal): Promise<CatalogModel[]>;
  /** Extra profile settings for this provider's models. */
  extra?: (m: CatalogModel) => Partial<ModelProfile>;
}

const MAX_MODELS = 1500;
const clean = (s: unknown, max = 120) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal });
  if (res.status === 401 || res.status === 403) throw new Error('The key was rejected.');
  if (!res.ok) throw new Error(`The model list request failed (HTTP ${res.status}).`);
  return res.json();
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const ids = (j: any): any[] => (Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []);

/** Names that usually mean a vision-language model (when the provider doesn't say). */
const VISION = /(vision|[-_/]vl\b|[-_]vl[-_]|vlm|llava|pixtral|gemma-?3|qwen2\.5-?vl|qwen3-?vl|qwen-vl|internvl|kimi-vl|phi-3\.5-vision|phi-4-multimodal|llama-3\.2-\d+b-vision|llama-4|maverick|scout|nemotron.*vl|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|grok-4|grok.*vision|mistral-(small|medium)-3|glm-4\.\dv|minimax.*vl)/i;
/** Models that can't chat: embeddings, rerankers, speech, image/video generation, moderation. */
const NOT_CHAT = /(embed|rerank|retriev|moderation|guard|safety|reward|whisper|transcri|tts|speech|audio|realtime|dall-e|image-gen|imagen|flux|sdxl|stable-diffusion|veo|sora|video|ocr|parse|clip\b|translate|asr\b|riva|cosmos|text-davinci|babbage|davinci|aqa|starcoder|gliner|\bpii\b|-pii|detector|lyria)/i;

const chatOnly = (models: CatalogModel[]) => models.filter((m) => m.id && !NOT_CHAT.test(m.id)).slice(0, MAX_MODELS);
const byId = (j: any, vision = (id: string) => VISION.test(id)): CatalogModel[] =>
  ids(j)
    .map((m) => clean(m?.id, 200))
    .filter(Boolean)
    .map((id) => ({ id, name: id, vision: vision(id) }));

export const CATALOG_PROVIDERS: CatalogProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    async list(key, signal) {
      const j = await getJson('https://api.anthropic.com/v1/models?limit=1000', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal);
      return chatOnly(ids(j).map((m) => ({ id: clean(m?.id, 200), name: clean(m?.display_name) || clean(m?.id), vision: true })));
    },
    extra: () => ({ effort: 'medium' as never, fallbacks: 'default' as never }),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    async list(key, signal) {
      const all = byId(await getJson('https://api.openai.com/v1/models', bearer(key), signal));
      return chatOnly(all.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !/(instruct|codex|search|image|-mini-tts)/.test(m.id)));
    },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyEnv: 'GEMINI_API_KEY',
    async list(key, signal) {
      const j = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key }, signal);
      return chatOnly(
        (Array.isArray(j?.models) ? j.models : [])
          .filter((m: any) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m: any) => ({ id: clean(String(m?.name ?? '').replace(/^models\//, ''), 200), name: clean(m?.displayName) || clean(m?.name), vision: true }))
          .filter((m: CatalogModel) => /^gemini/.test(m.id) && !/(image|tts|live|native-audio)/.test(m.id)),
      );
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    async list(key, signal) {
      const j = await getJson('https://openrouter.ai/api/v1/models', bearer(key), signal);
      return chatOnly(
        ids(j)
          .filter((m) => !Array.isArray(m?.architecture?.output_modalities) || m.architecture.output_modalities.includes('text'))
          .map((m) => ({
            id: clean(m?.id, 200),
            name: clean(m?.name) || clean(m?.id),
            vision: Array.isArray(m?.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : VISION.test(String(m?.id)),
            tools: Array.isArray(m?.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
          })),
      );
    },
    extra: () => ({ headers: { 'X-Title': 'Browser Agent' } }),
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    provider: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    async list(key, signal) {
      return chatOnly(byId(await getJson('https://integrate.api.nvidia.com/v1/models', bearer(key), signal)));
    },
    extra: (m) => ({ timeoutMs: 300_000, keepImages: 3, ...(/deepseek/i.test(m.id) ? { replayReasoning: true } : {}) }),
  },
  {
    id: 'nanogpt',
    label: 'NanoGPT',
    provider: 'openai',
    baseURL: 'https://nano-gpt.com/api/v1',
    keyEnv: 'NANOGPT_API_KEY',
    async list(key, signal) {
      const j = await getJson('https://nano-gpt.com/api/v1/models?detailed=true', bearer(key), signal);
      return chatOnly(
        ids(j).map((m) => {
          const id = clean(m?.id, 200);
          const modal = m?.architecture?.input_modalities;
          const vision = typeof m?.capabilities?.vision === 'boolean' ? m.capabilities.vision : Array.isArray(modal) ? modal.includes('image') : VISION.test(id);
          const tools = typeof m?.capabilities?.tool_calling === 'boolean' ? m.capabilities.tool_calling : undefined;
          return { id, name: clean(m?.name) || id, vision, tools };
        }),
      );
    },
    extra: (m) => ({ timeoutMs: 300_000, keepImages: 3, ...(/deepseek/i.test(m.id) ? { replayReasoning: true } : {}) }),
  },
  {
    id: 'groq',
    label: 'Groq',
    provider: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    async list(key, signal) {
      const j = await getJson('https://api.groq.com/openai/v1/models', bearer(key), signal);
      return chatOnly(byId({ data: ids(j).filter((m) => m?.active !== false) }).filter((m) => !/(playai|compound|allam)/.test(m.id)));
    },
  },
  {
    id: 'xai',
    label: 'xAI',
    provider: 'openai',
    baseURL: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    async list(key, signal) {
      return chatOnly(byId(await getJson('https://api.x.ai/v1/models', bearer(key), signal)).filter((m) => /^grok/.test(m.id) && !/image/.test(m.id)));
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai',
    baseURL: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    async list(key, signal) {
      return chatOnly(byId(await getJson('https://api.deepseek.com/models', bearer(key), signal), () => false));
    },
    extra: () => ({ replayReasoning: true }),
  },
  {
    id: 'mistral',
    label: 'Mistral',
    provider: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    async list(key, signal) {
      const j = await getJson('https://api.mistral.ai/v1/models', bearer(key), signal);
      return chatOnly(
        ids(j)
          .filter((m) => m?.capabilities?.completion_chat !== false && !m?.deprecation)
          .map((m) => ({
            id: clean(m?.id, 200),
            name: clean(m?.name) || clean(m?.id),
            vision: typeof m?.capabilities?.vision === 'boolean' ? m.capabilities.vision : VISION.test(String(m?.id)),
            tools: typeof m?.capabilities?.function_calling === 'boolean' ? m.capabilities.function_calling : undefined,
          })),
      );
    },
  },
];

interface CacheEntry {
  fetchedAt: number;
  /** SHA-256 prefix of the key the list was fetched with (never the key itself). */
  keyHash: string;
  models: CatalogModel[];
  error?: string;
}

export interface CatalogStatus {
  provider: string;
  label: string;
  keyEnv: string;
  models: number;
  updatedAt?: number;
  error?: string;
}

const keyHash = (k: string) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
const DAY = 24 * 60 * 60 * 1000;

export class ModelCatalog {
  private file: string;
  private entries: Record<string, CacheEntry> = {};
  private inflight = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    private keyFor: (env: string) => string | undefined,
    private providers: CatalogProvider[] = CATALOG_PROVIDERS,
  ) {
    this.file = path.join(dataDir, 'catalog.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.providers === 'object') this.entries = raw.providers;
    } catch {
      /* no cache yet */
    }
  }

  /** Key env names of every catalog provider (so the panel can offer them all). */
  keyNames(): string[] {
    return this.providers.map((p) => p.keyEnv);
  }

  providerForKey(env: string): CatalogProvider | undefined {
    return this.providers.find((p) => p.keyEnv === env);
  }

  /** Refresh providers whose key is set and whose list is stale (or fetched with another key). */
  async refresh(opts: { force?: boolean; only?: string[] } = {}): Promise<boolean> {
    let changed = false;
    await Promise.all(
      this.providers
        .filter((p) => !opts.only || opts.only.includes(p.id))
        .map(async (p) => {
          const key = this.keyFor(p.keyEnv);
          if (!key) {
            if (this.entries[p.id]) {
              delete this.entries[p.id];
              changed = true;
            }
            return;
          }
          const e = this.entries[p.id];
          const fresh = e && e.keyHash === keyHash(key) && Date.now() - e.fetchedAt < DAY && !e.error;
          if (fresh && !opts.force) return;
          let run = this.inflight.get(p.id);
          if (!run) {
            run = this.fetchOne(p, key).finally(() => this.inflight.delete(p.id));
            this.inflight.set(p.id, run);
          }
          await run;
          changed = true;
        }),
    );
    if (changed) this.save();
    return changed;
  }

  private async fetchOne(p: CatalogProvider, key: string): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const models = await p.list(key, ac.signal);
      const seen = new Set<string>();
      const unique = models.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
      this.entries[p.id] = { fetchedAt: Date.now(), keyHash: keyHash(key), models: unique };
    } catch (e) {
      const prev = this.entries[p.id];
      const error = ac.signal.aborted ? 'The provider did not answer in time.' : (e as Error).message;
      // Keep the last good list (if it was fetched with the same key), but note the error.
      this.entries[p.id] = { fetchedAt: Date.now(), keyHash: keyHash(key), models: prev?.keyHash === keyHash(key) ? prev.models : [], error };
    } finally {
      clearTimeout(timer);
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, providers: this.entries }));
    } catch {
      /* read-only data dir in tests */
    }
  }

  status(): CatalogStatus[] {
    return this.providers
      .filter((p) => this.entries[p.id] || this.keyFor(p.keyEnv))
      .map((p) => ({ provider: p.id, label: p.label, keyEnv: p.keyEnv, models: this.entries[p.id]?.models.length ?? 0, updatedAt: this.entries[p.id]?.fetchedAt, error: this.entries[p.id]?.error }));
  }

  /** Profiles for every cached model of providers whose key is (still) set. */
  profiles(): ModelProfile[] {
    const out: ModelProfile[] = [];
    for (const p of this.providers) {
      const key = this.keyFor(p.keyEnv);
      const e = this.entries[p.id];
      if (!key || !e || e.keyHash !== keyHash(key)) continue;
      for (const m of e.models) {
        out.push({
          id: `${p.id}/${m.id}`,
          label: m.name && m.name !== m.id ? m.name : m.id,
          provider: p.provider,
          model: m.id,
          ...(p.baseURL ? { baseURL: p.baseURL } : {}),
          apiKeyEnv: p.keyEnv,
          vision: m.vision,
          toolSet: 'full',
          ...(m.tools === false ? { toolMode: 'json' } : {}),
          ...(p.extra?.(m) ?? {}),
          catalog: p.id,
          group: p.label,
        } as ModelProfile);
      }
    }
    return out;
  }
}

const norm = (u?: string) => (u ?? '').replace(/\/+$/, '').toLowerCase();

/** Base profiles (models.json + detected local), then catalog models not already covered. */
export function mergeCatalog(base: ModelProfile[], catalog: ModelProfile[]): ModelProfile[] {
  const covered = new Set(base.map((p) => `${p.provider}|${norm(p.baseURL)}|${p.model}`));
  const ids = new Set(base.map((p) => p.id));
  const extra = catalog.filter((c) => !covered.has(`${c.provider}|${norm(c.baseURL)}|${c.model}`) && !ids.has(c.id));
  const mockAt = base.findIndex((p) => p.provider === 'mock');
  return mockAt < 0 ? [...base, ...extra] : [...base.slice(0, mockAt), ...extra, ...base.slice(mockAt)];
}
