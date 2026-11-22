/**
 * End-to-end harness: real Chromium with the extension loaded, the real agent server in-process,
 * the fixture site, and a scripted mock model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { AgentEvent, ApprovalDecision, PolicySettings } from '@ba/shared';
import { AgentServer } from '../../packages/server/src/server.ts';
import type { GpuMonitorOptions } from '../../packages/server/src/gpu.ts';
import { registerScript, type Script, type ScriptStep, type ScriptContext } from '../../packages/server/src/providers/mock.ts';
import type { ModelProfile, ToolResultEntry } from '../../packages/server/src/providers/types.ts';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(here, '../../packages/extension/dist');
const TOKEN = 'e2e-token';

export interface Env {
  fx: FixtureServer;
  server: AgentServer;
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  dataDir: string;
  close(): Promise<void>;
}

export interface EnvOptions {
  profiles?: ModelProfile[];
  defaultProfileId?: string;
  transcripts?: boolean;
  dataDir?: string;
  /** Run the GPU monitor with this (fake) sample source. */
  gpu?: GpuMonitorOptions;
}

export async function startEnv(settings: Partial<PolicySettings> = {}, opts: EnvOptions = {}): Promise<Env> {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build:ext');
  const fx = await startFixtureServer();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ba-e2e-'));
  const server = new AgentServer(
    {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      dataDir,
      extensionIds: [],
      profiles: [{ id: 'mock', label: 'Mock', provider: 'mock', model: 'mock', vision: true, script: 'echo' }, ...(opts.profiles ?? [])],
      defaultProfileId: opts.defaultProfileId ?? 'mock',
    },
    { settings: { permissionMode: 'auto', allowPrivateNetworks: true, ...settings }, transcripts: opts.transcripts ?? false, gpu: opts.gpu },
  );
  const port = await server.listen(0);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    // No viewport emulation: Playwright emulates through its own CDP session, which the
    // extension's screenshots don't see. Use a real window size instead.
    viewport: null,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--window-size=1280,800'],
  });
  // Playwright auto-dismisses JS dialogs on pages it controls unless a listener exists. In a real
  // browser nothing does that, so leave dialogs open for the extension to handle.
  const keepDialogs = (p: Page) => p.on('dialog', () => {});
  context.pages().forEach(keepDialogs);
  context.on('page', keepDialogs);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(async ({ url, token }) => {
    await (globalThis as any).__ba.bridge.setConfig({ serverUrl: url, token });
  }, { url: `ws://127.0.0.1:${port}/ws`, token: TOKEN });
  await until(() => server.connectedClients().length === 1, 15_000, 'extension did not connect');
  return {
    fx,
    server,
    context,
    sw,
    extensionId,
    dataDir,
    async close() {
      await context.close().catch(() => {});
      await server.close();
      await fx.close();
    },
  };
}

export async function until(fn: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let scriptN = 0;

/**
 * Register a sequential script. Each step function receives the context (with the previous
 * step's results) and returns the next calls; returning a string ends the turn with that text.
 */
export function script(steps: ((c: ScriptContext) => ScriptStep['calls'] | string)[]): string {
  const name = `s${++scriptN}_${Date.now().toString(36)}`;
  const s: Script = (c) => {
    const f = steps[c.step];
    if (!f) return { text: 'script finished' };
    const r = f(c);
    return typeof r === 'string' ? { text: r } : { calls: r };
  };
  registerScript(name, s);
  return name;
}

export interface RunResult {
  sessionId: string;
  events: AgentEvent[];
  results: ToolResultEntry[];
  final: string;
  reason: string;
  /** Text of the result for the n-th tool call (in order). */
  text(n: number): string;
}

export async function run(env: Env, scriptName: string, opts: { startUrl?: string; sessionId?: string; autoApprove?: ApprovalDecision; onEvent?: (e: AgentEvent) => void; profileId?: string; allowError?: boolean; text?: string } = {}): Promise<RunResult> {
  const before = opts.sessionId ? (env.server.getSession(opts.sessionId)?.history.length ?? 0) : 0;
  const { sessionId, done } = env.server.startOrContinue({
    text: opts.text ?? `#script:${scriptName}`,
    profileId: opts.profileId ?? 'mock',
    startUrl: opts.startUrl,
    sessionId: opts.sessionId,
    // Pass autoApprove: undefined explicitly to require real approvals.
    autoApprove: 'autoApprove' in opts ? opts.autoApprove : 'allow_once',
  });
  const events: AgentEvent[] = [];
  const unsub = env.server.subscribe(sessionId, (_s, e) => {
    events.push(e);
    opts.onEvent?.(e);
  });
  await done;
  unsub();
  const session = env.server.getSession(sessionId)!;
  // Only this turn's results.
  const results = session.history.slice(before).flatMap((t) => (t.role === 'tool_results' ? t.results : []));
  const doneEv = [...events].reverse().find((e) => e.type === 'turn_done') as Extract<AgentEvent, { type: 'turn_done' }>;
  if (process.env.DEBUG_E2E) {
    const lines = results.map((x, i) => `${i} ${x.member} ${JSON.stringify(x.input)} => ${x.result.content.map((b) => (b.type === 'text' ? b.text : b.type)).join(' | ')}`);
    console.log(`--- ${scriptName} (${doneEv?.reason}) ---\n${lines.join('\n')}`);
  }
  if (doneEv?.reason === 'error' && !opts.allowError) {
    const notes = events.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message);
    throw new Error(`turn ended with an error: ${notes.join(' | ')}`);
  }
  const textOf = (r: ToolResultEntry) => r.result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return {
    sessionId,
    events,
    results,
    final: doneEv?.finalText ?? '',
    reason: doneEv?.reason ?? '',
    text: (n) => (results[n] ? textOf(results[n]) : ''),
  };
}

/** The page currently showing a fixture path. */
export async function pageFor(env: Env, fragment: string): Promise<Page> {
  let found: Page | undefined;
  await until(() => {
    // Newest matching tab (earlier tests may have left tabs on the same page).
    found = [...env.context.pages()].reverse().find((p) => p.url().includes(fragment));
    return !!found;
  }, 10_000, `page ${fragment}`);
  return found!;
}

export function errorTexts(r: RunResult): string[] {
  return r.results.filter((x) => x.result.isError).map((x) => x.result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
}
