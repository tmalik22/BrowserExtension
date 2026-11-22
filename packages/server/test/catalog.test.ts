import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_PROVIDERS, ModelCatalog, mergeCatalog, type CatalogProvider } from '../src/catalog.ts';
import type { ModelProfile } from '../src/providers/types.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer provider list URLs with canned JSON; record what was asked. */
function stubFetch(routes: Record<string, unknown>, seen: { url: string; headers: Record<string, string> }[] = []) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return new Response('{}', { status: 404 });
    if (hit[1] === 401) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const prov = (id: string) => CATALOG_PROVIDERS.find((p) => p.id === id)!;
const list = (id: string) => prov(id).list('k-test-123456', AbortSignal.timeout(5000));

describe('provider list parsing (real response shapes)', () => {
  it('NVIDIA NIM: drops embeddings, guards, code and PII models; guesses vision from names', async () => {
    stubFetch({
      'https://integrate.api.nvidia.com/v1/models': {
        data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'google/gemma-3-27b-it' }, { id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'nvidia/llama-3.1-nemoguard-8b-topic-control' }, { id: 'bigcode/starcoder2-15b' }, { id: 'fastino/gliner2-pii' }, { id: 'meta/llama-3.2-90b-vision-instruct' }],
      },
    });
    const ms = await list('nvidia');
    expect(ms.map((m) => [m.id, m.vision])).toEqual([
      ['meta/llama-3.3-70b-instruct', false],
      ['google/gemma-3-27b-it', true],
      ['meta/llama-3.2-90b-vision-instruct', true],
    ]);
  });
  it('NanoGPT: uses the provider’s own vision and tool-calling flags', async () => {
    stubFetch({
      'https://nano-gpt.com/api/v1/models': {
        data: [
          { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', capabilities: { vision: true, tool_calling: true } },
          { id: 'some/roleplay-model', name: 'Roleplay 12B', capabilities: { vision: false, tool_calling: false } },
          { id: 'openai/gpt-oss-safeguard-20b', capabilities: { vision: false } },
        ],
      },
    });
    const ms = await list('nanogpt');
    expect(ms).toEqual([
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', vision: true, tools: true },
      { id: 'some/roleplay-model', name: 'Roleplay 12B', vision: false, tools: false },
    ]);
  });
  it('OpenRouter: image input = vision, "tools" parameter = tool calling, text output only', async () => {
    stubFetch({
      'https://openrouter.ai/api/v1/models': {
        data: [
          { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'temperature'] },
          { id: 'x/text-only', name: 'Text only', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['temperature'] },
          { id: 'google/imagen-x', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        ],
      },
    });
    const ms = await list('openrouter');
    expect(ms).toEqual([
      { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', vision: true, tools: true },
      { id: 'x/text-only', name: 'Text only', vision: false, tools: false },
    ]);
  });
  it('OpenAI: only chat models (no audio, image, embeddings, legacy completions)', async () => {
    stubFetch({ 'https://api.openai.com/v1/models': { data: ['gpt-5', 'gpt-5-mini', 'o4-mini', 'gpt-4o-audio-preview', 'gpt-image-1', 'text-embedding-3-large', 'davinci-002', 'gpt-3.5-turbo-instruct', 'whisper-1', 'tts-1'].map((id) => ({ id })) } });
    expect((await list('openai')).map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini', 'o4-mini']);
  });
  it('Gemini: generateContent models only, ids without "models/"', async () => {
    const seen = stubFetch({
      'https://generativelanguage.googleapis.com/v1beta/models': {
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
        ],
      },
    });
    expect(await list('gemini')).toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vision: true }]);
    expect(seen[0].url).not.toContain('k-test'); // key goes in a header, not the URL
    expect(seen[0].headers['x-goog-api-key']).toBe('k-test-123456');
  });
  it('Anthropic, Groq, xAI, DeepSeek and Mistral lists', async () => {
    stubFetch({
      'https://api.anthropic.com/v1/models': { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] },
      'https://api.groq.com/openai/v1/models': { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'meta-llama/llama-4-scout-17b-16e-instruct' }, { id: 'old', active: false }] },
      'https://api.x.ai/v1/models': { data: [{ id: 'grok-4' }, { id: 'grok-2-image-1212' }] },
      'https://api.deepseek.com/models': { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] },
      'https://api.mistral.ai/v1/models': { data: [{ id: 'pixtral-large-latest', capabilities: { completion_chat: true, vision: true, function_calling: true } }, { id: 'mistral-embed', capabilities: { completion_chat: false } }] },
    });
    expect(await list('anthropic')).toEqual([{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', vision: true }]);
    expect((await list('groq')).map((m) => [m.id, m.vision])).toEqual([
      ['llama-3.3-70b-versatile', false],
      ['meta-llama/llama-4-scout-17b-16e-instruct', true],
    ]);
    expect((await list('xai')).map((m) => m.id)).toEqual(['grok-4']);
    expect((await list('deepseek')).map((m) => [m.id, m.vision])).toEqual([
      ['deepseek-chat', false],
      ['deepseek-reasoner', false],
    ]);
    expect(await list('mistral')).toEqual([{ id: 'pixtral-large-latest', name: 'pixtral-large-latest', vision: true, tools: true }]);
  });
  it('strips control characters and caps names from untrusted lists', async () => {
    stubFetch({ 'https://nano-gpt.com/api/v1/models': { data: [{ id: 'evil\u0000/model', name: 'Nice\u001b[31m name '.padEnd(400, 'x') }] } });
    const [m] = await list('nanogpt');
    expect(m.id).toBe('evil/model');
    expect(m.name.length).toBeLessThanOrEqual(120);
    expect(m.name).not.toMatch(/[\u0000-\u001f]/);
  });
  it('a rejected key is reported plainly', async () => {
    stubFetch({ 'https://api.groq.com/openai/v1/models': 401 });
    await expect(list('groq')).rejects.toThrow('The key was rejected.');
  });
});

describe('ModelCatalog cache and profiles', () => {
  const fake = (id: string, models: () => { id: string; vision: boolean; tools?: boolean }[], fail = () => false): CatalogProvider => ({
    id,
    label: id.toUpperCase(),
    provider: 'openai',
    baseURL: `https://${id}.example/v1`,
    keyEnv: `${id.toUpperCase()}_KEY`,
    async list() {
      if (fail()) throw new Error('down');
      return models().map((m) => ({ ...m, name: m.id }));
    },
  });

  it('fetches lists for providers with keys, caches them, and maps them to profiles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-cat-'));
    let calls = 0;
    const a = fake('alpha', () => (calls++, [{ id: 'm1', vision: true }, { id: 'm2', vision: false, tools: false }]));
    const b = fake('beta', () => [{ id: 'x', vision: false }]);
    const keys: Record<string, string> = { ALPHA_KEY: 'key-a-1' };
    const cat = new ModelCatalog(dir, (e) => keys[e], [a, b]);
    expect(cat.keyNames()).toEqual(['ALPHA_KEY', 'BETA_KEY']);
    await cat.refresh();
    const ps = cat.profiles();
    expect(ps.map((p) => p.id)).toEqual(['alpha/m1', 'alpha/m2']); // beta has no key
    expect(ps[1]).toMatchObject({ provider: 'openai', model: 'm2', baseURL: 'https://alpha.example/v1', apiKeyEnv: 'ALPHA_KEY', vision: false, toolMode: 'json', catalog: 'alpha', group: 'ALPHA' });
    await cat.refresh(); // fresh: not fetched again
    expect(calls).toBe(1);
    // A new process reuses the cache without fetching.
    const again = new ModelCatalog(dir, (e) => keys[e], [a, b]);
    expect(again.profiles().length).toBe(2);
    // A different key means a different account: fetch again; the key itself is never stored.
    keys.ALPHA_KEY = 'key-a-2';
    expect(again.profiles().length).toBe(0);
    await again.refresh();
    expect(calls).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).not.toContain('key-a');
    // Removing the key removes its models.
    delete keys.ALPHA_KEY;
    await again.refresh();
    expect(again.profiles().length).toBe(0);
  });

  it('keeps the last good list when a refresh fails, and reports the error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-cat2-'));
    let down = false;
    const a = fake('alpha', () => [{ id: 'm1', vision: true }], () => down);
    const cat = new ModelCatalog(dir, () => 'k', [a]);
    await cat.refresh();
    down = true;
    await cat.refresh({ force: true });
    expect(cat.profiles().map((p) => p.id)).toEqual(['alpha/m1']);
    expect(cat.status()[0]).toMatchObject({ provider: 'alpha', models: 1, error: 'down' });
  });

  it('models listed in models.json win over the same model from a live list', () => {
    const base: ModelProfile[] = [
      { id: 'my-gpt', label: 'My GPT', provider: 'openai', model: 'gpt-5', baseURL: 'https://api.openai.com/v1/', apiKeyEnv: 'OPENAI_API_KEY', vision: true, effort: 'high' as never },
      { id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false },
    ];
    const cat: ModelProfile[] = [
      { id: 'openai/gpt-5', label: 'gpt-5', provider: 'openai', model: 'gpt-5', baseURL: 'https://api.openai.com/v1', vision: true, catalog: 'openai' },
      { id: 'openai/o4-mini', label: 'o4-mini', provider: 'openai', model: 'o4-mini', baseURL: 'https://api.openai.com/v1', vision: true, catalog: 'openai' },
    ];
    expect(mergeCatalog(base, cat).map((p) => p.id)).toEqual(['my-gpt', 'openai/o4-mini', 'mock']);
  });
});

describe('server with live model lists', () => {
  it('adds live models, sends the list only when it changes, and checks a key by fetching its list', async () => {
    const { AgentServer } = await import('../src/server.ts');
    const WebSocket = (await import('ws')).default;
    const { PROTOCOL_VERSION } = await import('@ba/shared');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-cat-srv-'));
    let models = [{ id: 'alpha-large', vision: true }];
    const provider: CatalogProvider = {
      id: 'alpha',
      label: 'Alpha AI',
      provider: 'openai',
      baseURL: 'https://alpha.example/v1',
      keyEnv: 'ALPHA_TEST_KEY',
      async list() {
        return models.map((m) => ({ ...m, name: m.id }));
      },
    };
    delete process.env.ALPHA_TEST_KEY;
    const server = new AgentServer(
      { host: '127.0.0.1', port: 0, token: 'tok', dataDir: dir, extensionIds: [], profiles: [{ id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' }], defaultProfileId: 'mock' },
      { gpu: false, catalog: [provider] },
    );
    const port = await server.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ type: 'hello', token: 'tok', clientId: 'c-cat', protocol: PROTOCOL_VERSION, extensionVersion: 't', userAgent: 't' }));
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(fn()).toBe(true);
    };
    const call = async (f: Record<string, unknown>) => {
      const requestId = `r${Math.random()}`;
      ws.send(JSON.stringify({ ...f, requestId }));
      await until(() => frames.some((x) => x.type === 'response' && x.requestId === requestId));
      return frames.find((x) => x.type === 'response' && x.requestId === requestId);
    };
    await until(() => frames.some((f) => f.type === 'state'));
    // The key is offered even though no models.json profile uses it.
    const st0 = frames.filter((f) => f.type === 'state').at(-1);
    expect(st0.apiKeys.map((k: any) => k.name)).toContain('ALPHA_TEST_KEY');
    expect(st0.profiles).toBeUndefined(); // already sent in hello_ok

    // Saving the key fetches the list and the model appears.
    await call({ type: 'set_api_key', name: 'ALPHA_TEST_KEY', key: 'alpha-secret-key-1' });
    await until(() => frames.some((f) => f.type === 'state' && f.profiles?.some((p: any) => p.id === 'alpha/alpha-large')));
    const withList = frames.filter((f) => f.type === 'state' && f.profiles).at(-1);
    expect(withList.profiles.find((p: any) => p.id === 'alpha/alpha-large')).toMatchObject({ group: 'Alpha AI', source: 'catalog', available: true, vision: true });
    expect(withList.defaultProfileId).toBe('alpha/alpha-large'); // the mock was the default: a real model is better
    await until(() => frames.filter((f) => f.type === 'state').at(-1).apiKeys.find((k: any) => k.name === 'ALPHA_TEST_KEY').catalogModels === 1);

    // A state frame without changes doesn't repeat the list.
    await call({ type: 'update_settings', settings: { maxSteps: 33 } });
    await until(() => frames.filter((f) => f.type === 'state').at(-1).settings.maxSteps === 33);
    expect(frames.filter((f) => f.type === 'state').at(-1).profiles).toBeUndefined();

    // A new model at the provider shows up on refresh.
    models = [...models, { id: 'alpha-mini', vision: false }];
    await call({ type: 'refresh_models' });
    await until(() => frames.some((f) => f.type === 'state' && f.profiles?.some((p: any) => p.id === 'alpha/alpha-mini')));

    // Testing the key checks the list rather than calling every model.
    const test = await call({ type: 'test_api_key', name: 'ALPHA_TEST_KEY' });
    expect(test.ok).toBe(true);
    expect(test.data.results).toEqual([expect.objectContaining({ ok: true, label: 'Alpha AI model list', message: expect.stringContaining('2 models') })]);
    expect(JSON.stringify(frames)).not.toContain('alpha-secret-key-1');
    ws.close();
    await server.close();
    delete process.env.ALPHA_TEST_KEY;
  });
});
