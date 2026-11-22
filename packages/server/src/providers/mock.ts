/**
 * Scripted mock provider. Deterministic stand-in for a model, used by the end-to-end tests and for
 * trying the extension without an API key. A script inspects the conversation (tool results) and
 * returns the next assistant step.
 */
import type { AssistantPart, CompletionRequest, CompletionResult, Provider, StreamCallbacks, ToolResultEntry, Turn } from './types.ts';

export interface ScriptStep {
  text?: string;
  calls?: { name: string; input?: Record<string, unknown> }[];
}

export interface ScriptContext {
  history: Turn[];
  /** Results of the previous step's calls (empty on the first step of a turn). */
  last: ToolResultEntry[];
  /** Text of the latest user message. */
  userText: string;
  /** Step number within the current user turn (0-based). */
  step: number;
  /** All text from the previous step's results joined. */
  lastText: string;
  /** Find a [ref_N] for a line matching `role "name"` in the previous results' text. */
  ref(role: string, name: string | RegExp): string | undefined;
  /** Same, but throw a readable error if missing. */
  mustRef(role: string, name: string | RegExp): string;
}

export type Script = (ctx: ScriptContext) => ScriptStep | Promise<ScriptStep>;

const scripts = new Map<string, Script>();

export function registerScript(name: string, s: Script): void {
  scripts.set(name, s);
}

export function hasScript(name: string): boolean {
  return scripts.has(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findRef(text: string, role: string, name: string | RegExp): string | undefined {
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\S+)\s+"((?:[^"\\]|\\.)*)".*?\[(ref_\d+)\]/);
    if (!m) continue;
    if (m[1] !== role) continue;
    const label = m[2].replace(/\\"/g, '"');
    if (typeof name === 'string' ? label === name || label.includes(name) : name.test(label)) return m[3];
  }
  return undefined;
}

let n = 0;

export class MockProvider implements Provider {
  readonly name = 'mock';
  constructor(private defaultScript?: string) {}

  async complete(req: CompletionRequest, cb: StreamCallbacks, signal: AbortSignal): Promise<CompletionResult> {
    if (signal.aborted) throw new Error('aborted');
    const h = req.history;
    let userIdx = -1;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    const userTurn = h[userIdx] as Extract<Turn, { role: 'user' }> | undefined;
    const userText = userTurn?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '';
    const step = h.slice(userIdx + 1).filter((t) => t.role === 'assistant').length;
    const lastTurn = h[h.length - 1];
    const last = lastTurn?.role === 'tool_results' ? lastTurn.results : [];
    const lastText = last
      .flatMap((r) => r.result.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    const tag = userText.match(/#script:([\w-]+)/)?.[1];
    const name = tag ?? this.defaultScript ?? 'echo';
    const script = scripts.get(name);
    if (!script) throw new Error(`Mock script "${name}" is not registered.`);
    const ctx: ScriptContext = {
      history: h,
      last,
      userText,
      step,
      lastText,
      ref: (role, nm) => findRef(lastText, role, nm),
      mustRef: (role, nm) => {
        const r = findRef(lastText, role, nm);
        if (!r) throw new Error(`mock script "${name}": no ${role} "${String(nm)}" in:\n${lastText.slice(0, 3000)}`);
        return r;
      },
    };
    const out = await script(ctx);
    const parts: AssistantPart[] = [];
    if (out.text) {
      cb.onText?.(out.text);
      parts.push({ type: 'text', text: out.text });
    }
    for (const c of out.calls ?? []) parts.push({ type: 'tool_call', id: `mock_${++n}`, name: c.name, input: c.input ?? {} });
    return {
      parts,
      stopReason: out.calls?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

// Built-in scripts --------------------------------------------------------------------------------

registerScript('echo', (c) => ({ text: `You said: ${c.userText}` }));

/** Reads the page and reports the title line; handy for a quick manual check. */
registerScript('read', (c) => {
  if (c.step === 0) return { calls: [{ name: 'read_page', input: { filter: 'interactive' } }] };
  return { text: `Page has ${c.lastText.split('\n').filter((l) => l.includes('[ref_')).length} interactive elements.` };
});

export { escapeRe };
