import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLocalModels, mergeDetected, type LocalServer } from '../src/local-models.ts';
import type { ModelProfile } from '../src/providers/types.ts';

/** Tiny fake HTTP server answering fixed JSON per "METHOD path". */
async function fake(routes: Record<string, (body: any) => unknown>) {
  const srv = http.createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const h = routes[`${req.method} ${req.url}`];
    if (!h) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(h(text ? JSON.parse(text) : undefined)));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

let ollama: Awaited<ReturnType<typeof fake>>;
let oldOllama: Awaited<ReturnType<typeof fake>>;
let lmstudio: Awaited<ReturnType<typeof fake>>;
let lmOpenAiOnly: Awaited<ReturnType<typeof fake>>;

beforeAll(async () => {
  const caps: Record<string, string[]> = {
    'qwen3-vl:32b': ['completion', 'tools', 'vision'],
    'llama3.3:70b': ['completion', 'tools'],
    'nomic-embed-text:latest': ['embedding'],
  };
  ollama = await fake({
    'GET /api/tags': () => ({ models: Object.keys(caps).map((name) => ({ name })) }),
    'POST /api/show': (b) => ({ capabilities: caps[b.model] }),
  });
  oldOllama = await fake({ 'GET /api/tags': () => ({ models: [{ name: 'llava:13b' }, { name: 'mistral:7b' }] }) });
  lmstudio = await fake({
    'GET /api/v0/models': () => ({ data: [{ id: 'google/gemma-3-12b', type: 'vlm' }, { id: 'qwen2.5-7b-instruct', type: 'llm' }, { id: 'text-embedding-nomic', type: 'embeddings' }] }),
  });
  lmOpenAiOnly = await fake({ 'GET /v1/models': () => ({ data: [{ id: 'qwen2.5-vl-7b' }, { id: 'phi-4' }, { id: 'bge-small-embed' }] }) });
});
afterAll(async () => {
  await Promise.all([ollama, oldOllama, lmstudio, lmOpenAiOnly].map((s) => s.close()));
});

describe('detectLocalModels', () => {
  it('lists Ollama chat models with vision from reported capabilities, skipping embeddings', async () => {
    const { profiles, served } = await detectLocalModels([], [{ kind: 'ollama', url: ollama.url }]);
    expect(profiles.map((p) => [p.model, p.vision])).toEqual([
      ['qwen3-vl:32b', true],
      ['llama3.3:70b', false],
    ]);
    expect(profiles[0]).toMatchObject({ provider: 'openai', baseURL: `${ollama.url}/v1`, apiKey: 'ollama', toolSet: 'compact', detected: true, label: 'qwen3-vl:32b (Ollama)' });
    expect([...served.get(`${ollama.url}/v1`)!]).toEqual(['qwen3-vl:32b', 'llama3.3:70b']);
  });
  it('guesses vision from the name on older Ollama without capabilities', async () => {
    const { profiles } = await detectLocalModels([], [{ kind: 'ollama', url: oldOllama.url }]);
    expect(profiles.map((p) => [p.model, p.vision])).toEqual([
      ['llava:13b', true],
      ['mistral:7b', false],
    ]);
  });
  it('reads LM Studio model types, falling back to the OpenAI list', async () => {
    const native = await detectLocalModels([], [{ kind: 'lmstudio', url: lmstudio.url }]);
    expect(native.profiles.map((p) => [p.model, p.vision])).toEqual([
      ['google/gemma-3-12b', true],
      ['qwen2.5-7b-instruct', false],
    ]);
    const plain = await detectLocalModels([], [{ kind: 'lmstudio', url: lmOpenAiOnly.url }]);
    expect(plain.profiles.map((p) => [p.model, p.vision])).toEqual([
      ['qwen2.5-vl-7b', true],
      ['phi-4', false],
    ]);
    expect(plain.profiles[0].label).toBe('qwen2.5-vl-7b (LM Studio)');
  });
  it('returns nothing (quietly) for servers that are not running', async () => {
    const down: LocalServer[] = [{ kind: 'ollama', url: 'http://127.0.0.1:1' }, { kind: 'lmstudio', url: 'http://127.0.0.1:2' }];
    expect((await detectLocalModels([], down)).profiles).toEqual([]);
  });
  it('skips models a configured profile already covers and avoids id clashes', async () => {
    const existing: ModelProfile[] = [
      { id: 'mine', label: 'Mine', provider: 'openai', model: 'llama3.3:70b', baseURL: `${ollama.url.replace('127.0.0.1', 'localhost')}/v1/`, vision: false },
      { id: 'ollama-qwen3-vl-32b', label: 'Taken id', provider: 'mock', model: 'mock', vision: false },
    ];
    const { profiles } = await detectLocalModels(existing, [{ kind: 'ollama', url: ollama.url }]);
    expect(profiles.map((p) => p.id)).toEqual(['ollama-qwen3-vl-32b-2']);
  });
});

describe('mergeDetected', () => {
  const det = (id: string, vision: boolean, url = 'http://127.0.0.1:11434'): ModelProfile => ({ id, label: id, provider: 'openai', model: id, baseURL: `${url}/v1`, vision, detected: true });
  const mock: ModelProfile = { id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false };
  const cloud: ModelProfile = { id: 'cloud', label: 'Cloud', provider: 'openai', model: 'gpt', baseURL: 'https://api.example/v1', vision: true, apiKeyEnv: 'X' };
  const placeholder: ModelProfile = { id: 'ollama', label: 'Ollama', provider: 'openai', model: 'qwen2.5vl:7b', baseURL: 'http://127.0.0.1:11434/v1', vision: true };

  it('drops example profiles naming models the running server does not have, and inserts detected before the mock', () => {
    const served = new Map([['http://127.0.0.1:11434/v1', new Set(['a', 'b'])]]);
    const r = mergeDetected([cloud, placeholder, mock], 'cloud', { profiles: [det('a', false), det('b', true)], served }, () => true);
    expect(r.profiles.map((p) => p.id)).toEqual(['cloud', 'a', 'b', 'mock']);
    expect(r.defaultProfileId).toBe('cloud'); // the configured default works: keep it
  });
  it('keeps placeholders when their server is not running', () => {
    const r = mergeDetected([placeholder, mock], 'ollama', { profiles: [], served: new Map() }, () => true);
    expect(r.profiles.map((p) => p.id)).toEqual(['ollama', 'mock']);
    expect(r.defaultProfileId).toBe('ollama');
  });
  it('never makes a detected model the default on its own (the user picks it)', () => {
    const served = new Map([['http://127.0.0.1:11434/v1', new Set(['a', 'b'])]]);
    const r = mergeDetected([cloud, mock], 'cloud', { profiles: [det('a', false), det('b', true)], served }, (p) => p.id !== 'cloud');
    expect(r.defaultProfileId).toBe('cloud');
  });
  it('falls back to the mock (not a detected model) when the default was an uninstalled placeholder', () => {
    const served = new Map([['http://127.0.0.1:11434/v1', new Set(['a'])]]);
    const r = mergeDetected([placeholder, mock], 'ollama', { profiles: [det('a', false)], served }, () => true);
    expect(r.defaultProfileId).toBe('mock');
  });
});

describe('CaptchaKraken auto-setup', () => {
  it('sets a detected CaptchaKraken up as a CAPTCHA solver (protocol, vision, 16k context, no thinking)', async () => {
    const srv = await fake({
      'GET /api/tags': () => ({ models: [{ name: 'hf.co/CaptchaKraken/CaptchaKraken-v1.2-GGUF:Q4_K_M' }, { name: 'gemma3:12b' }] }),
      'POST /api/show': (b) => ({ capabilities: ['completion', 'vision'] }),
    });
    const lm = await fake({ 'GET /v1/models': () => ({ data: [{ id: 'captchakraken-v1.2' }] }) });
    try {
      const { profiles } = await detectLocalModels([], [{ kind: 'ollama', url: srv.url }, { kind: 'lmstudio', url: lm.url }]);
      const [ck, gemma, ckLm] = profiles;
      expect(ck).toMatchObject({
        label: 'CaptchaKraken Q4_K_M (Ollama) · CAPTCHA solver',
        model: 'hf.co/CaptchaKraken/CaptchaKraken-v1.2-GGUF:Q4_K_M',
        vision: true,
        captchaProtocol: 'kraken',
        contextTokens: 16384,
        extraBody: { reasoning_effort: 'none' },
      });
      expect(gemma.captchaProtocol).toBeUndefined();
      expect(gemma.label).toBe('gemma3:12b (Ollama)');
      expect(ckLm).toMatchObject({ label: 'CaptchaKraken (LM Studio) · CAPTCHA solver', vision: true, captchaProtocol: 'kraken' });
    } finally {
      await Promise.all([srv.close(), lm.close()]);
    }
  });
});
