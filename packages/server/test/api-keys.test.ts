/**
 * API keys pasted in the side panel: saved on the server, never echoed, tested against the real
 * (here: fake) provider, with model-id suggestions when the provider doesn't know the model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type ProfileInfo, PROTOCOL_VERSION, type ApiKeyInfo, type KeyTestResult, type ServerFrame } from '@ba/shared';
import type { ServerConfig } from '../src/config.ts';
import { rankSimilar } from '../src/model-test.ts';
import { toOpenAIMessages } from '../src/providers/openai.ts';
import type { ModelProfile } from '../src/providers/types.ts';
import { AgentServer } from '../src/server.ts';
import { fakeServer, openaiSse } from './fake-servers.ts';

const TOKEN = 'keys-token';
const NAME = 'BA_TEST_API_KEY';
const SECRET = 'sk-test-0123456789abcdWXYZ';
const PLAN_MODELS = ['deepseek-v4-1-flash-251101', 'deepseek-v4-flash', 'kimi-k3', 'doubao-seed-code'];

let provider: Awaited<ReturnType<typeof fakeServer>>;
let dataDir: string;
let server: AgentServer;
let port: number;
let config: ServerConfig;

beforeAll(async () => {
  delete process.env[NAME];
  provider = await fakeServer((req) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) return { status: 401, json: { error: { message: 'the API key in the request is missing or invalid', type: 'Unauthorized' } } };
    if (req.body.model === 'good-model' || PLAN_MODELS.includes(req.body.model)) {
      return { sse: openaiSse({ reasoning: 'Read it first.', calls: [{ id: 'call_1', name: 'read_page', args: '{"filter":"interactive"}' }] }) };
    }
    return { status: 404, json: { error: { message: `The model ${req.body.model} does not exist or you do not have access to it.`, code: 'InvalidEndpointOrModel.NotFound' } } };
  }, { models: PLAN_MODELS.map((id) => ({ id, context_window: 1048576 })) });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-keys-'));
  const prof = (id: string, model: string): ModelProfile => ({ id, label: id, provider: 'openai', model, baseURL: `${provider.url}/v1`, apiKeyEnv: NAME, vision: false, toolSet: 'full' });
  config = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dataDir,
    extensionIds: [],
    profiles: [prof('good', 'good-model'), prof('plan', 'deepseek-v4.1-flash'), { id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: false, script: 'echo' }],
    defaultProfileId: 'mock',
  };
  server = new AgentServer(config, { gpu: false });
  port = await server.listen(0);
});

afterAll(async () => {
  await server.close();
  await provider.close();
  delete process.env[NAME];
});

async function panel() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: ServerFrame[] = [];
  const raw: string[] = [];
  ws.on('message', (d) => {
    raw.push(String(d));
    frames.push(JSON.parse(String(d)));
  });
  await new Promise<void>((r, j) => {
    ws.on('open', () => r());
    ws.on('error', j);
  });
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN, clientId: 'keys-client', protocol: PROTOCOL_VERSION, extensionVersion: 'test', userAgent: 'vitest' }));
  let n = 0;
  const call = <T,>(frame: Record<string, unknown>, ms = 20_000) =>
    new Promise<T>((resolve, reject) => {
      const requestId = `k${++n}`;
      const t0 = Date.now();
      ws.send(JSON.stringify({ ...frame, requestId }));
      const tick = () => {
        const f = frames.find((x) => x.type === 'response' && x.requestId === requestId) as Extract<ServerFrame, { type: 'response' }> | undefined;
        if (f) return f.ok ? resolve(f.data as T) : reject(new Error(f.error));
        if (Date.now() - t0 > ms) return reject(new Error('timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  // Like the extension: the model list is only re-sent when it changes, so keep the latest one
  // (from hello_ok or any state frame that carried it).
  const lastState = () => {
    const st = [...frames].reverse().find((f) => f.type === 'state') as Extract<ServerFrame, { type: 'state' }>;
    const withList = [...frames].reverse().find((f) => (f.type === 'state' && f.profiles) || f.type === 'hello_ok') as { profiles: ProfileInfo[] };
    return { ...st, profiles: st.profiles ?? withList.profiles };
  };
  return { ws, frames, raw, call, lastState };
}

describe('API keys from the side panel', () => {
  it('lists the key as missing and the models as needing it', async () => {
    const p = await panel();
    await new Promise((r) => setTimeout(r, 100));
    const st = p.lastState();
    expect(st.apiKeys).toEqual([{ name: NAME, label: 'BA TEST', set: false, source: undefined, hint: undefined, usedBy: ['good', 'plan'] }]);
    expect(st.profiles.find((x) => x.id === 'good')).toMatchObject({ available: false, unavailableReason: 'Add your BA TEST key in Settings → API keys' });
    p.ws.close();
  });

  it('refuses names no model uses and keys with spaces', async () => {
    const p = await panel();
    await expect(p.call({ type: 'set_api_key', name: 'PATH', key: 'x' })).rejects.toThrow(/No model uses the key "PATH"/);
    await expect(p.call({ type: 'set_api_key', name: NAME, key: 'two words' })).rejects.toThrow(/spaces/);
    expect(process.env.PATH).toBeTruthy();
    p.ws.close();
  });

  it('saves a key without ever sending it back, and the models become available', async () => {
    const p = await panel();
    const keys = await p.call<ApiKeyInfo[]>({ type: 'set_api_key', name: NAME, key: `  ${SECRET}\n` });
    expect(keys[0]).toMatchObject({ set: true, source: 'panel', hint: 'WXYZ' });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.lastState().profiles.find((x) => x.id === 'good')?.available).toBe(true);
    expect(p.raw.join('\n')).not.toContain(SECRET);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8'))).toEqual({ [NAME]: SECRET });
    p.ws.close();
  });

  it('tests every model on the key and suggests the right id for an unknown model', async () => {
    const p = await panel();
    const res = await p.call<KeyTestResult>({ type: 'test_api_key', name: NAME });
    const good = res.results.find((r) => r.profileId === 'good')!;
    const plan = res.results.find((r) => r.profileId === 'plan')!;
    expect(good).toMatchObject({ ok: true, message: expect.stringMatching(/^Works/) });
    expect(plan.ok).toBe(false);
    expect(plan.message).toMatch(/The key works, but the model "deepseek-v4.1-flash" was not accepted/);
    expect(plan.suggestions?.[0]).toBe('deepseek-v4-1-flash-251101');
    expect(plan.suggestions).not.toContain('kimi-k3');
    // The key went out as a Bearer token.
    expect(provider.requests.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
    p.ws.close();
  });

  it('switches a profile to the suggested model and the retest passes', async () => {
    const p = await panel();
    await p.call({ type: 'set_profile_model', profileId: 'plan', model: 'deepseek-v4-1-flash-251101' });
    expect(config.profiles.find((x) => x.id === 'plan')?.model).toBe('deepseek-v4-1-flash-251101');
    await expect(p.call({ type: 'set_profile_model', profileId: 'plan', model: 'bad id' })).rejects.toThrow(/not a valid model id/);
    const res = await p.call<KeyTestResult>({ type: 'test_api_key', name: NAME });
    expect(res.results.every((r) => r.ok)).toBe(true);
    p.ws.close();
  });

  it('reports a rejected key in plain words', async () => {
    const p = await panel();
    await p.call({ type: 'set_api_key', name: NAME, key: 'sk-wrong-key-000000' });
    const res = await p.call<KeyTestResult>({ type: 'test_api_key', name: NAME });
    expect(res.results[0].message).toMatch(/^The key was rejected/);
    await p.call({ type: 'set_api_key', name: NAME, key: SECRET });
    p.ws.close();
  });

  it('keeps the key across a server restart, and Remove clears it', async () => {
    delete process.env[NAME];
    const fresh = new AgentServer({ ...config }, { gpu: false });
    expect(process.env[NAME]).toBe(SECRET);
    expect(fresh.keyStore.info()[0]).toMatchObject({ set: true, source: 'panel' });
    fresh.keyStore.set(NAME, '');
    expect(process.env[NAME]).toBeUndefined();
    expect(fresh.keyStore.info()[0]).toMatchObject({ set: false });
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8'))).toEqual({});
  });
});

describe('model id suggestions', () => {
  it('ranks ids by shared name parts', () => {
    expect(rankSimilar('deepseek-v4.1-flash', PLAN_MODELS)).toEqual(['deepseek-v4-1-flash-251101', 'deepseek-v4-flash']);
    expect(rankSimilar('z-ai/glm-5.3-flash-uncensored', ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash-uncensored', 'qwen/qwen3'])[0]).toBe('z-ai/glm-5.3-flash-uncensored');
  });
});

describe('reasoning replay (DeepSeek thinking + tools)', () => {
  const history = [
    { role: 'user' as const, parts: [{ type: 'text' as const, text: 'go' }] },
    { role: 'assistant' as const, parts: [{ type: 'thinking' as const, text: 'Need the page first.' }, { type: 'tool_call' as const, id: 'c1', name: 'read_page', input: {} }] },
    { role: 'tool_results' as const, results: [{ callId: 'c1', member: 'read_page', input: {}, result: { isError: false, content: [{ type: 'text' as const, text: 'ok' }] } }] },
  ];
  const base: ModelProfile = { id: 'd', label: 'd', provider: 'openai', model: 'deepseek', vision: false };
  it('sends reasoning_content back only when the profile asks for it', () => {
    const on = toOpenAIMessages('S', history as any, { ...base, replayReasoning: true }) as any[];
    const off = toOpenAIMessages('S', history as any, base) as any[];
    expect(on.find((m) => m.role === 'assistant').reasoning_content).toBe('Need the page first.');
    expect(off.find((m) => m.role === 'assistant').reasoning_content).toBeUndefined();
  });
});
