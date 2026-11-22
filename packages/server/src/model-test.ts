/**
 * Try a model profile with one small, real request (browser tools attached) and explain the
 * outcome in plain words. Used by the side panel's "Test" button and by check-models.
 */
import { selectMembers, type ProfileTestResult } from '@ba/shared';
import { profileAvailability, resolveApiKey } from './config.ts';
import { buildSystemPrompt } from './agent/system-prompt.ts';
import { createProvider } from './providers/index.ts';
import type { ModelProfile, Turn } from './providers/types.ts';

export async function testProfile(p: ModelProfile, timeoutMs = 90_000): Promise<ProfileTestResult> {
  const base = { profileId: p.id, label: p.label, model: p.model };
  const avail = profileAvailability(p);
  if (!avail.available) return { ...base, ok: false, message: avail.reason ?? 'Not available.' };
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(p.timeoutMs ?? timeoutMs, timeoutMs));
  try {
    const provider = createProvider(p);
    const members = selectMembers({ toolSet: p.toolSet, vision: p.vision });
    const history: Turn[] = [
      { role: 'user', parts: [{ type: 'text', text: 'The task starts in tab tab-1 (https://example.com). Read the page to find its main heading. Use a tool.' }] },
    ];
    const r = await provider.complete({ system: buildSystemPrompt(p), history, members, profile: p }, {}, ac.signal);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const called = r.parts.some((x) => x.type === 'tool_call');
    return called
      ? { ...base, ok: true, seconds, message: `Works (answered in ${seconds}s and used the browser tools).` }
      : {
          ...base,
          ok: false,
          seconds,
          message: `The key works and the model answered, but it did not use the browser tools (stop: ${r.stopReason}). It may struggle as a browser agent.`,
        };
  } catch (e) {
    const seconds = Math.round((Date.now() - t0) / 1000);
    const msg = ac.signal.aborted ? 'No answer within the time limit.' : (e as Error).message.split('\n')[0];
    const status = (e as { status?: number }).status;
    if (ac.signal.aborted || (!status && /closed the connection without answering|terminated|socket hang up|other side closed|ECONNRESET|timed? ?out/i.test(msg))) {
      return {
        ...base,
        ok: false,
        seconds,
        message:
          `The key was accepted, but the provider never answered (${ac.signal.aborted ? `stopped waiting after ${seconds}s` : `it closed the connection after ${seconds}s`}). ` +
          'The model is probably overloaded, or your account can\'t run it yet. Try again later, or check your account on the provider\'s website.',
      };
    }
    if (/not found for account/i.test(msg)) {
      return { ...base, ok: false, message: `The key works, but your account doesn't have access to "${p.model}" (${msg}).` };
    }
    if (status === 401 || status === 403 || /auth|api key|unauthori[sz]ed|invalid.*key|forbidden/i.test(msg)) {
      return { ...base, ok: false, message: `The key was rejected (${msg}).` };
    }
    if (status === 404 || /model/i.test(msg)) {
      const suggestions = await similarModels(p).catch(() => []);
      const hint = suggestions.length ? ' Pick the right one below.' : '';
      return { ...base, ok: false, message: `The key works, but the model "${p.model}" was not accepted (${msg}).${hint}`, suggestions };
    }
    return { ...base, ok: false, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the provider for its model list and return ids that look like the profile's model. */
export async function similarModels(p: ModelProfile): Promise<string[]> {
  if (p.provider !== 'openai' || !p.baseURL) return [];
  const key = resolveApiKey(p);
  const res = await fetch(`${p.baseURL.replace(/\/+$/, '')}/models`, {
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(p.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: { id?: string }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
  return rankSimilar(p.model, ids);
}

/** Ids sharing the most name parts (deepseek, v4, flash...) with `want`, best first. */
export function rankSimilar(want: string, ids: string[], max = 6): string[] {
  const parts = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).flatMap((t) => [t, ...t.split('.')]).filter((t) => t.length > 1 || /\d/.test(t));
  const w = new Set(parts(want));
  return ids
    .map((id) => ({ id, score: parts(id).filter((t) => w.has(t)).length - (id.includes(':') ? 0.1 : 0) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score || a.id.length - b.id.length)
    .slice(0, max)
    .map((x) => x.id);
}
