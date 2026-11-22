/**
 * One agent session: a conversation with a model that drives one set of browser tabs.
 * The loop: model -> member calls -> policy (+ human approval) -> extension executes -> results
 * appended -> model ... until the model replies in text, the user stops it, or a limit is hit.
 */
import {
  HALT_TEXT,
  TAB_MEMBERS,
  isBrowserMember,
  newId,
  selectMembers,
  summarizeCall,
  truncate,
  type ActionDescription,
  type AgentEvent,
  type ApprovalDecision,
  type BrowserMember,
  type CaptchaActionPlan,
  type CaptchaObservation,
  type CaptchaProbe,
  type ExecuteParams,
  type PolicySettings,
  type SessionBeginResult,
  type SessionStatus,
  type SessionSummary,
  type ToolResult,
  type TurnEndReason,
} from '@ba/shared';
import fs from 'node:fs';
import path from 'node:path';
import { buildCaptchaPrompt, buildSystemPrompt, taskPreamble } from './system-prompt.ts';
import { ACTION_PROMPT, CAPTCHA_SYSTEM, gridPrompt, TEXT_PROMPT } from './captcha-prompts.ts';
import { checkUploadPaths, evaluate, needsDescription, type PolicyState } from './policy.ts';
import {
  ProviderError,
  type AssistantPart,
  type CompletionResult,
  type ModelProfile,
  type Provider,
  type ToolResultEntry,
  type Turn,
  type Usage,
  type UserPart,
} from '../providers/types.ts';

export interface BrowserLink {
  /** Invoke an RPC on the extension that owns this session. */
  call<T = unknown>(method: 'session_begin' | 'execute' | 'describe' | 'session_end' | 'session_status' | 'captcha_probe' | 'captcha_observe' | 'captcha_action', params: Record<string, unknown>, timeoutMs: number): Promise<T>;
}

export interface ApprovalRequest {
  kind: 'site' | 'consequential' | 'sensitive';
  site?: string;
  member: string;
  summary: string;
  reason: string;
}

export interface SessionHost {
  emit(sessionId: string, event: AgentEvent): void;
  requestApproval(sessionId: string, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  settings(): PolicySettings;
  allowSitePermanently(site: string): void;
  /** Configured model for solving CAPTCHA / Cloudflare challenges, if any. */
  captchaHelper?(): { profile: ModelProfile; provider: Provider } | undefined;
  /** Start a local helper's model server when it is down. */
  prepareCaptchaHelper?(): Promise<void>;
  log(sessionId: string, record: Record<string, unknown>): void;
}

export interface SessionOptions {
  id?: string;
  profile: ModelProfile;
  provider: Provider;
  link: BrowserLink;
  host: SessionHost;
  /** Chrome tab the session starts in ("tab-123"); omitted -> extension uses the active tab. */
  tabId?: string;
  /** Open this URL in a fresh tab at session start (CLI / evals). */
  startUrl?: string;
  extraSystemPrompt?: string;
  now?: () => Date;
}

const MEMBER_TIMEOUT_MS: Partial<Record<BrowserMember, number>> = {
  navigate: 60_000,
  find: 45_000,
  read_page: 45_000,
  get_page_text: 45_000,
  file_upload: 60_000,
  javascript_exec: 45_000,
};

const PROVIDER_ATTEMPTS = 3;

/** Tools the CAPTCHA helper may use (a focused subset of the browser toolset). */
const CAPTCHA_MEMBERS: BrowserMember[] = ['screenshot', 'read_page', 'get_page_text', 'left_click', 'form_input', 'key', 'wait', 'scroll'];
const CAPTCHA_MAX_STEPS = 6;
const CAPTCHA_MAX_HANDOFFS = 2;

export class Session {
  readonly id: string;
  readonly createdAt = Date.now();
  title = 'New task';
  profile: ModelProfile;
  private provider: Provider;
  private readonly link: BrowserLink;
  private readonly host: SessionHost;
  readonly history: Turn[] = [];
  /** Members are fixed at session start (changing tools mid-session breaks caching/thinking). */
  readonly members: BrowserMember[];
  readonly system: string;
  status: SessionStatus = 'idle';
  private abort: AbortController | null = null;
  private began = false;
  private startTabId?: string;
  private startUrl?: string;
  activeTabId?: string;
  tabIds: string[] = [];
  private policyState: PolicyState = { sessionSites: new Set() };
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private stepsThisTurn = 0;
  private now: () => Date;
  private turnPromise: Promise<void> | null = null;
  /** Messages the user sent while a turn was running, not yet delivered to the model. */
  private pendingNotes: string[] = [];
  /** A navigation just happened, so the new page is worth checking for a CAPTCHA. */
  private sawNavigation = false;
  private captchaHandoffs = 0;
  private captchaFailKey = '';

  constructor(opts: SessionOptions) {
    this.id = opts.id ?? newId('s');
    this.profile = opts.profile;
    this.provider = opts.provider;
    this.link = opts.link;
    this.host = opts.host;
    this.startTabId = opts.tabId;
    this.startUrl = opts.startUrl;
    this.now = opts.now ?? (() => new Date());
    const s = this.host.settings();
    this.members = selectMembers({
      toolSet: opts.profile.toolSet,
      vision: opts.profile.vision,
      enableOptional: s.enableOptional,
    });
    this.system = buildSystemPrompt(opts.profile, opts.extraSystemPrompt);
  }

  summary(): SessionSummary {
    return { sessionId: this.id, title: this.title, profileId: this.profile.id, status: this.status, tabIds: this.tabIds, createdAt: this.createdAt };
  }

  /** Switch model for later turns (history is kept; foreign thinking is not replayed). */
  setProvider(profile: ModelProfile, provider: Provider): void {
    if (this.status !== 'idle') throw new Error('Cannot switch models while the agent is running.');
    this.profile = profile;
    this.provider = provider;
  }

  get running(): boolean {
    return this.status !== 'idle';
  }

  /** Wait for the current turn (if any) to finish. */
  async settled(): Promise<void> {
    await this.turnPromise;
  }

  private emit(ev: AgentEvent): void {
    this.host.emit(this.id, ev);
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.emit({ type: 'status', status, step: this.stepsThisTurn, maxSteps: this.host.settings().maxSteps });
  }

  stop(): void {
    if (this.abort && !this.abort.signal.aborted) {
      this.setStatus('stopping');
      this.abort.abort();
    }
  }

  /** Add a user message and run the agent until it replies. Resolves when the turn ends. */
  /**
   * A message sent while the agent is working: shown right away, delivered to the model with the
   * next tool results (or as the next turn if the agent finishes first).
   */
  interject(text: string): void {
    if (!this.running) {
      void this.send(text).catch(() => {});
      return;
    }
    this.pendingNotes.push(text);
    this.emit({ type: 'user_message', text });
    this.host.log(this.id, { kind: 'user', text, interjection: true });
  }

  /**
   * @param context Extra text given to the model before the message on the first turn only (e.g. a
   *   summary of an earlier chat this one carries on); not shown to the user.
   */
  send(text: string, context?: string): Promise<void> {
    if (this.running) return Promise.reject(new Error('The agent is already working on this session. Stop it or wait.'));
    this.turnPromise = this.runTurn(text, { context });
    return this.turnPromise;
  }

  private async begin(): Promise<void> {
    if (this.began) return;
    const res = await this.link.call<SessionBeginResult>(
      'session_begin',
      { sessionId: this.id, tabId: this.startTabId, startUrl: this.startUrl, title: this.title, lockUserInput: this.host.settings().lockUserInput },
      30_000,
    );
    this.began = true;
    this.activeTabId = res.activeTabId;
    this.tabIds = res.tabs.map((t) => t.tab_id);
    const t = res.tabs.find((x) => x.tab_id === res.activeTabId);
    this.preamble = taskPreamble({ now: this.now(), tabId: res.activeTabId, url: t?.url, title: t?.title });
  }

  private preamble = '';

  private async runTurn(text: string, opts: { silent?: boolean; context?: string } = {}): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.stepsThisTurn = 0;
    this.sawNavigation = true;
    this.captchaHandoffs = 0;
    this.captchaFailKey = '';
    if (!this.history.length && this.title === 'New task') this.title = truncate(text.replace(/\s+/g, ' ').trim(), 60) || 'New task';
    this.setStatus('running');
    if (!opts.silent) {
      this.emit({ type: 'user_message', text });
      this.host.log(this.id, { kind: 'user', text, profile: this.profile.id });
    }

    let reason: TurnEndReason = 'end_turn';
    let finalText = '';
    try {
      const first = !this.began;
      await this.begin();
      if (first) this.emit({ type: 'session_started', profileId: this.profile.id, title: this.title });
      const lead = [first ? this.preamble : '', this.history.length ? '' : (opts.context?.trim() ?? '')].filter(Boolean).join('\n\n');
      this.history.push({ role: 'user', parts: [{ type: 'text', text: lead ? `${lead}\n\n${text}` : text }] });

      const maxSteps = this.host.settings().maxSteps;
      for (;;) {
        if (signal.aborted) {
          reason = 'stopped';
          break;
        }
        if (this.stepsThisTurn >= maxSteps) {
          reason = 'max_steps';
          this.emit({ type: 'notice', level: 'warn', message: `Stopped after ${maxSteps} steps (limit). Send a message to continue.` });
          break;
        }
        if (!signal.aborted) await this.maybeSolveCaptcha(false, signal);
        const result = await this.callModel(signal);
        if (!result) {
          reason = 'stopped';
          break;
        }
        this.history.push({ role: 'assistant', parts: result.parts, native: result.native });
        this.host.log(this.id, {
          kind: 'assistant',
          parts: result.parts.map((p) => (p.type === 'tool_call' ? { type: 'tool_call', id: p.id, name: p.name } : p)),
          stop: result.stopReason,
          usage: result.usage,
        });
        const text = result.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim();
        if (text) {
          this.emit({ type: 'text', text });
          finalText = text;
        }
        const calls = result.parts.filter((p): p is Extract<AssistantPart, { type: 'tool_call' }> => p.type === 'tool_call');
        if (result.stopReason === 'refusal') {
          reason = 'refusal';
          this.emit({ type: 'notice', level: 'warn', message: `The model declined to continue${result.stopDetail ? ` (${result.stopDetail})` : ''}.` });
          if (calls.length) this.history.push({ role: 'tool_results', results: calls.map((c) => this.haltEntry(c, 'Not executed: the model declined to continue.')) });
          break;
        }
        if (!calls.length) {
          // The main model thinks it is done. If a challenge is still on screen, let the helper
          // solve it, then give the main model another step to continue the task.
          if (!signal.aborted && (await this.maybeSolveCaptcha(true, signal))) continue;
          reason = result.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
          if (reason === 'max_tokens') this.emit({ type: 'notice', level: 'warn', message: 'The reply hit the output token limit.' });
          break;
        }
        const results = await this.executeBatch(calls, signal);
        const notes = this.pendingNotes.splice(0);
        this.history.push(notes.length ? { role: 'tool_results', results, notes } : { role: 'tool_results', results });
        this.stepsThisTurn++;
        if (signal.aborted) {
          reason = 'stopped';
          break;
        }
      }
    } catch (e) {
      reason = 'error';
      // Keep the conversation valid: every tool call must have a result.
      const last = this.history[this.history.length - 1];
      if (last?.role === 'assistant') {
        const pending = last.parts.filter((p): p is Extract<AssistantPart, { type: 'tool_call' }> => p.type === 'tool_call');
        if (pending.length) this.history.push({ role: 'tool_results', results: pending.map((c) => this.haltEntry(c, 'Not executed: an internal error interrupted the task.')) });
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ type: 'notice', level: 'error', message: process.env.DEBUG_E2E && e instanceof Error ? `${msg}\n${e.stack}` : msg });
      this.host.log(this.id, { kind: 'error', message: msg });
    } finally {
      this.abort = null;
      this.status = 'idle';
      this.emit({ type: 'status', status: 'idle', step: this.stepsThisTurn, maxSteps: this.host.settings().maxSteps });
      this.emit({ type: 'turn_done', reason, finalText });
      this.host.log(this.id, { kind: 'turn_done', reason, finalText, usage: this.usage });
      this.link.call('session_status', { sessionId: this.id, running: false }, 5000).catch(() => {});
      // Messages that arrived after the last step: answer them as the next turn.
      if (this.pendingNotes.length && reason !== 'stopped') {
        const text = this.pendingNotes.splice(0).join('\n\n');
        setTimeout(() => void this.runQueued(text), 0);
      } else this.pendingNotes = [];
    }
  }

  private async runQueued(text: string): Promise<void> {
    if (this.running) {
      this.pendingNotes.push(text);
      return;
    }
    // Already shown in the UI as a user message when it was sent.
    this.turnPromise = this.runTurn(text, { silent: true });
    await this.turnPromise;
  }

  private async callModel(signal: AbortSignal): Promise<CompletionResult | null> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt++) {
      if (signal.aborted) return null;
      let textBuf = '';
      let thinkBuf = '';
      try {
        const res = await this.provider.complete(
          { system: this.system, history: this.history, members: this.members, profile: this.profile },
          {
            onText: (d) => {
              textBuf += d;
              this.emit({ type: 'text_delta', text: d });
            },
            onThinking: (d) => {
              thinkBuf += d;
              this.emit({ type: 'thinking_delta', text: d });
            },
            onNotice: (level, message) => this.emit({ type: 'notice', level, message }),
          },
          signal,
        );
        const thinking = res.parts.filter((p) => p.type === 'thinking').map((p) => (p as { text: string }).text).join('\n') || thinkBuf;
        if (thinking.trim()) this.emit({ type: 'thinking', text: thinking });
        for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += res.usage[k];
        const ctx = res.context ?? { used: res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens };
        this.emit({ type: 'usage', ...this.usage, contextTokens: ctx.used || undefined, contextWindow: ctx.window });
        return res;
      } catch (e) {
        if (signal.aborted) return null;
        lastErr = e;
        const retryable = e instanceof ProviderError && e.retryable;
        if (!retryable || attempt === PROVIDER_ATTEMPTS) throw e;
        const delay = 2000 * 2 ** (attempt - 1);
        this.emit({ type: 'notice', level: 'warn', message: `${(e as Error).message} — retrying in ${delay / 1000}s` });
        await sleep(delay, signal);
      }
    }
    throw lastErr;
  }

  private async probeCaptcha(): Promise<CaptchaProbe | null> {
    try {
      return await this.link.call<CaptchaProbe>('captcha_probe', { sessionId: this.id, tab_id: this.activeTabId }, 15_000);
    } catch {
      return null;
    }
  }

  /**
   * When a Cloudflare/CAPTCHA challenge is on the current page, let the configured helper model
   * solve just that challenge. Returns true when it was solved and the main model should continue.
   */
  private async maybeSolveCaptcha(force: boolean, signal: AbortSignal): Promise<boolean> {
    const helper = this.host.captchaHelper?.();
    if (!helper || helper.profile.id === this.profile.id || this.captchaHandoffs >= CAPTCHA_MAX_HANDOFFS) return false;
    const checking = force || this.sawNavigation;
    this.sawNavigation = false;
    if (!checking) return false;

    const probe = await this.probeCaptcha();
    if (!probe?.challenge || probe.solved) {
      if (probe && !probe.challenge) this.captchaFailKey = '';
      return false;
    }
    const key = `${this.activeTabId ?? ''}|${probe.kind ?? 'unknown'}`;
    if (!force && this.captchaFailKey === key) return false;

    this.captchaHandoffs++;
    const solved = await this.solveCaptcha(helper, probe, signal);
    if (solved) {
      this.captchaFailKey = '';
      return true;
    }
    this.captchaFailKey = key;
    return false;
  }

  private async solveCaptcha(helper: { profile: ModelProfile; provider: Provider }, probe: CaptchaProbe, signal: AbortSignal): Promise<boolean> {
    const kind = probe.kind ?? 'CAPTCHA';
    this.emit({ type: 'notice', level: 'info', message: `${kind} challenge detected — asking ${helper.profile.label} to solve it.` });
    this.host.log(this.id, { kind: 'captcha', phase: 'start', helper: helper.profile.id, challenge: kind, detail: probe.detail });
    this.setStatus('running');
    if (helper.profile.captchaProtocol === 'kraken') {
      await this.host.prepareCaptchaHelper?.();
      return this.solveCaptchaKraken(helper, kind, signal);
    }
    const settings = this.host.settings();
    const members = helper.profile.vision ? CAPTCHA_MEMBERS : CAPTCHA_MEMBERS.filter((m) => m !== 'screenshot');
    const system = buildCaptchaPrompt(helper.profile);
    const history: Turn[] = [];
    const first: UserPart[] = [
      { type: 'text', text: `A ${kind} challenge is blocking the page. Solve only the challenge, then reply DONE.` },
    ];

    // Give the helper a fresh observation (screenshot for vision models, page tree otherwise).
    const snapMember: BrowserMember = helper.profile.vision ? 'screenshot' : 'read_page';
    try {
      const snap = await this.executeOne(
        { type: 'tool_call', id: newId('h'), name: snapMember, input: helper.profile.vision ? {} : { filter: 'interactive' } },
        settings,
        signal,
        false,
        undefined,
        members,
      );
      const textOut = snap.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      if (!helper.profile.vision) first.push({ type: 'text', text: truncate(textOut, 12_000) });
      const img = snap.content.find((b) => b.type === 'image') as { mediaType: string; data: string } | undefined;
      if (img) first.push({ type: 'image', mediaType: img.mediaType as 'image/jpeg' | 'image/png', data: img.data });
    } catch {
      /* the helper can still take its own screenshot */
    }
    history.push({ role: 'user', parts: first });

    try {
      for (let step = 0; step < CAPTCHA_MAX_STEPS; step++) {
        if (signal.aborted) break;
        const res = await helper.provider.complete(
          { system, history, members, profile: helper.profile },
          { onNotice: (level, message) => this.emit({ type: 'notice', level, message }) },
          signal,
        );
        for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += res.usage[k];
        history.push({ role: 'assistant', parts: res.parts, native: res.native });
        const calls = res.parts.filter((p): p is Extract<AssistantPart, { type: 'tool_call' }> => p.type === 'tool_call');
        if (!calls.length) {
          const p = await this.probeCaptcha();
          if (p && (!p.challenge || p.solved)) return this.finishCaptcha(true, helper, kind);
          break;
        }
        const results: ToolResultEntry[] = [];
        for (const c of calls) {
          if (signal.aborted) break;
          let result: ToolResult;
          if (!CAPTCHA_MEMBERS.includes(c.name as BrowserMember)) {
            result = this.errorResult(`Error: ${c.name} is not available to the CAPTCHA helper.`);
          } else {
            try {
              result = await this.executeOne(c, settings, signal, false, undefined, members);
            } catch (e) {
              result = this.errorResult(errText(e));
            }
          }
          results.push({ callId: c.id, member: c.name, input: c.input, result });
        }
        history.push({ role: 'tool_results', results });
        if (signal.aborted) break;
        const p = await this.probeCaptcha();
        if (p && (!p.challenge || p.solved)) return this.finishCaptcha(true, helper, kind);
      }
    } catch (e) {
      if (!signal.aborted) this.emit({ type: 'notice', level: 'warn', message: `The CAPTCHA helper failed: ${errText(e)}` });
    }
    return this.finishCaptcha(false, helper, kind);
  }

  /**
   * CaptchaKraken path: observe -> one JSON plan from the model -> extension applies it -> repeat.
   * The model never sees the conversation; prompts are the ones it was trained on.
   */
  private async solveCaptchaKraken(helper: { profile: ModelProfile; provider: Provider }, kind: string, signal: AbortSignal): Promise<boolean> {
    for (let round = 0; round < 10; round++) {
      if (signal.aborted) break;
      let obs: CaptchaObservation;
      try {
        obs = await this.link.call<CaptchaObservation>('captcha_observe', { sessionId: this.id, tab_id: this.activeTabId }, 20_000);
      } catch (e) {
        this.emit({ type: 'notice', level: 'warn', message: `Could not capture the challenge: ${errText(e)}` });
        break;
      }
      const prompt = obs.grid ? gridPrompt(obs.grid.rows) : kind === 'unknown' ? TEXT_PROMPT : ACTION_PROMPT;
      const history: Turn[] = [
        {
          role: 'user',
          parts: [
            { type: 'text', text: prompt },
            { type: 'image', mediaType: obs.shot.mediaType, data: obs.shot.data },
          ],
        },
      ];
      let reply = '';
      try {
        const res = await helper.provider.complete(
          { system: CAPTCHA_SYSTEM, history, members: [], profile: helper.profile },
          { onNotice: (level, message) => this.emit({ type: 'notice', level, message }) },
          signal,
        );
        for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += res.usage[k];
        reply = res.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      } catch (e) {
        if (!signal.aborted) this.emit({ type: 'notice', level: 'warn', message: `The CAPTCHA solver failed: ${errText(e)}` });
        break;
      }
      const plan = parseCaptchaPlan(reply);
      if (!plan) {
        this.host.log(this.id, { kind: 'captcha', phase: 'unparsed', reply: truncate(reply, 500) });
        await sleep(400, signal);
        continue;
      }
      try {
        const applied = await this.link.call<{ ok: true; message: string }>(
          'captcha_action',
          {
            sessionId: this.id,
            tab_id: this.activeTabId,
            plan,
            settings: { allowPrivateNetworks: this.host.settings().allowPrivateNetworks, blockedSites: this.host.settings().blockedSites },
          },
          30_000,
        );
        this.host.log(this.id, { kind: 'captcha', phase: 'action', plan, result: applied.message });
      } catch (e) {
        this.emit({ type: 'notice', level: 'warn', message: `Could not apply the CAPTCHA answer: ${errText(e)}` });
        break;
      }
      await sleep(obs.grid ? 1200 : 500, signal);
      const after = await this.probeCaptcha();
      if (after && (!after.challenge || after.solved)) return this.finishCaptcha(true, helper, kind);
    }
    return this.finishCaptcha(false, helper, kind);
  }

  private finishCaptcha(ok: boolean, helper: { profile: ModelProfile }, kind: string): boolean {
    const note = ok
      ? `[CAPTCHA helper] The ${kind} challenge was solved by ${helper.profile.label}. The page may have changed, so take a fresh screenshot/read_page before acting; references from before are probably stale. Continue the original task.`
      : `[CAPTCHA helper] ${helper.profile.label} could not get past the ${kind} challenge. Look at the current page and try again, or tell the user what is blocking it.`;
    this.pushNote(note);
    this.emit({ type: 'notice', level: ok ? 'info' : 'warn', message: ok ? 'Challenge solved — continuing the task.' : 'The CAPTCHA helper could not solve it.' });
    this.host.log(this.id, { kind: 'captcha', phase: ok ? 'solved' : 'failed', helper: helper.profile.id, challenge: kind });
    return ok;
  }

  /** Add a helper note to the current step, without disturbing turn boundaries or caching. */
  private pushNote(text: string): void {
    const last = this.history[this.history.length - 1];
    if (last?.role === 'tool_results') last.notes = [...(last.notes ?? []), text];
    else if (last?.role === 'user') last.parts.push({ type: 'text', text });
    else this.history.push({ role: 'user', parts: [{ type: 'text', text }] });
  }

  private haltEntry(c: { id: string; name: string; input: Record<string, unknown> }, text: string): ToolResultEntry {
    return { callId: c.id, member: c.name, input: c.input, result: { isError: true, content: [{ type: 'text', text }] } };
  }

  private errorResult(text: string): ToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
  }

  /** Run a batch in order; stop at the first failure; answer every call. */
  private async executeBatch(calls: Extract<AssistantPart, { type: 'tool_call' }>[], signal: AbortSignal): Promise<ToolResultEntry[]> {
    const settings = this.host.settings();
    const out: ToolResultEntry[] = [];
    let failed = false;
    // Index of the last call that may carry an auto-observation screenshot.
    let lastObservable = -1;
    calls.forEach((c, i) => {
      if (!TAB_MEMBERS.includes(c.name as BrowserMember) && c.name !== 'screenshot' && c.name !== 'zoom') lastObservable = i;
    });

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (failed) {
        out.push(this.haltEntry(c, HALT_TEXT));
        continue;
      }
      if (signal.aborted) {
        out.push(this.haltEntry(c, 'Not executed: the user stopped the task.'));
        failed = true;
        continue;
      }
      const input = c.input && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input : {};
      const summary = isBrowserMember(c.name) ? summarizeCall(c.name, input) : c.name;
      let shownInput: Record<string, unknown> = redactInput(c.name, input, false);
      let announced = false;
      const announce = (sensitive: boolean) => {
        if (announced) return;
        announced = true;
        shownInput = redactInput(c.name, input, sensitive);
        this.emit({ type: 'tool_call', callId: c.id, member: c.name, input: shownInput, summary });
      };
      let result: ToolResult;
      try {
        result = await this.executeOne(c, settings, signal, settings.autoScreenshot && this.profile.vision && i === lastObservable, announce);
      } catch (e) {
        result = this.errorResult(errText(e));
      }
      announce(false);
      if (result.isError) failed = true;
      if (c.name === 'navigate' && !result.isError) this.sawNavigation = true;
      out.push({ callId: c.id, member: c.name, input: c.input, result });
      this.track(result);
      const textOut = result.content.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
      const img = result.content.find((b) => b.type === 'image') as { mediaType: string; data: string } | undefined;
      this.emit({
        type: 'tool_result',
        callId: c.id,
        isError: result.isError,
        text: truncate(textOut, 4000),
        image: img ? { mediaType: img.mediaType, data: img.data } : undefined,
      });
      this.host.log(this.id, {
        kind: 'tool',
        member: c.name,
        input: shownInput,
        isError: result.isError,
        text: truncate(textOut, 20000),
        images: result.content.filter((b) => b.type === 'image').length,
        imageData: img?.data,
      });
    }
    return out;
  }

  /** Keep the session's view of tabs current from browser_state blocks. */
  private track(result: ToolResult): void {
    const st = result.content.find((b) => b.type === 'browser_state');
    if (st && st.type === 'browser_state') {
      this.tabIds = st.tabs.map((t) => t.tab_id);
      const a = st.tabs.find((t) => t.active);
      if (a) this.activeTabId = a.tab_id;
    }
  }

  private async executeOne(
    c: Extract<AssistantPart, { type: 'tool_call' }>,
    settings: PolicySettings,
    signal: AbortSignal,
    attachScreenshot: boolean,
    announce: (sensitive: boolean) => void = () => {},
    allowed: readonly string[] = this.members,
  ): Promise<ToolResult> {
    if (!c.input || typeof c.input !== 'object' || Array.isArray(c.input)) return this.errorResult('Error: tool arguments must be a JSON object.');
    if (c.name === '__invalid__') return this.errorResult(`Error: ${String(c.input.error)}. Emit tool calls as valid JSON.`);
    if (!isBrowserMember(c.name)) return this.errorResult(`Error: unknown tool "${c.name}".`);
    if ('__invalid_arguments__' in c.input) return this.errorResult(`Error: ${String(c.input.__invalid_arguments__)}. Retry with valid JSON arguments.`);
    if (!allowed.includes(c.name)) return this.errorResult(`Error: ${c.name} is not enabled in this environment.`);

    const member = c.name;
    let desc: ActionDescription | undefined;
    if (needsDescription(member) && member !== 'navigate') {
      try {
        desc = await this.browser<ActionDescription>('describe', { sessionId: this.id, member, input: c.input }, 20_000);
      } catch (e) {
        announce(false);
        const m = errText(e);
        // A stale/unknown ref is a normal model-facing error; anything else means we could not
        // inspect the target, which the policy treats as "ask".
        if (/stale or not found|not one of this task's tabs|not a valid tab_id|no longer exists|browser-internal page|cannot be controlled|blocked by policy|not allowed/i.test(m)) return this.errorResult(m);
        desc = { tabId: this.activeTabId ?? '', url: '', host: '', unknown: m.replace(/^Error: /, '').slice(0, 160) };
      }
    }
    announce(!!desc?.element?.sensitive);

    let verdict = evaluate(member, c.input, desc, settings, this.policyState);
    if (verdict.kind === 'deny') return this.errorResult(verdict.message);
    const askedUser = verdict.kind === 'ask';
    let pending = verdict.kind === 'ask';
    for (let round = 0; verdict.kind === 'ask' && round < 3; round++) {
      this.setStatus('waiting_approval');
      let decision: ApprovalDecision;
      try {
        decision = await this.host.requestApproval(
          this.id,
          { kind: verdict.approvalKind, site: verdict.site, member, summary: verdict.summary, reason: verdict.reason },
          signal,
        );
      } finally {
        if (!signal.aborted) this.setStatus('running');
      }
      if (decision === 'deny') {
        return this.errorResult(
          `Error: The user declined this action (${verdict.summary}). Do not retry it or work around it; ask the user how to proceed.`,
        );
      }
      if (verdict.approvalKind !== 'site' || !verdict.site) {
        pending = false;
        break;
      }
      // A site approval only covers the site: re-check the action itself (purchases, sending,
      // passwords...) before running it.
      this.policyState.sessionSites.add(verdict.site);
      if (decision === 'allow_site') this.host.allowSitePermanently(verdict.site);
      verdict = evaluate(member, c.input, desc, settings, this.policyState);
      if (verdict.kind === 'deny') return this.errorResult(verdict.message);
      pending = verdict.kind === 'ask';
    }
    // Never run an action that still needs an answer (e.g. the round limit was reached).
    if (pending) return this.errorResult('Error: This action still needs your approval and was not run.');
    if (signal.aborted) return this.errorResult('Not executed: the user stopped the task.');
    // The page may have changed what this action would hit while the user was deciding: check
    // the target again and refuse if it is no longer the one that was approved.
    if (askedUser && desc?.element) {
      let again: ActionDescription | undefined;
      try {
        again = await this.browser<ActionDescription>('describe', { sessionId: this.id, member, input: c.input }, 20_000);
      } catch (e) {
        return this.errorResult(`Error: The page changed after this action was approved (${errText(e).replace(/^Error: /, '')}). Observe the page again before acting.`);
      }
      const a = desc.element;
      const b = again.element;
      if (!b || a.role !== b.role || a.name !== b.name || (a.formSubmitName ?? '') !== (b.formSubmitName ?? '') || desc.host !== again.host) {
        return this.errorResult('Error: The page changed after this action was approved, so the approved target is no longer there. Observe the page again before acting.');
      }
    }

    // file_upload: the policy validated the paths inside the upload directory; the browser needs
    // them absolute. Re-validate now (files may have changed during an approval wait).
    let input = c.input;
    if (member === 'file_upload' && settings.uploadDir) {
      const err = checkUploadPaths(c.input.paths, settings.uploadDir);
      if (err) return this.errorResult(err);
      try {
        const root = fs.realpathSync(settings.uploadDir);
        input = { ...c.input, paths: (c.input.paths as string[]).map((p) => fs.realpathSync(path.resolve(root, p))) };
      } catch (e) {
        return this.errorResult(errText(e));
      }
    }

    const params: ExecuteParams = {
      sessionId: this.id,
      member,
      input,
      attachScreenshot,
      settings: {
        allowPrivateNetworks: settings.allowPrivateNetworks,
        blockedSites: settings.blockedSites,
        enableOptional: settings.enableOptional,
        uploadDir: settings.uploadDir,
        lockUserInput: settings.lockUserInput,
      },
      expectDocKey: desc?.docKey,
    };
    let timeout = MEMBER_TIMEOUT_MS[member] ?? 30_000;
    if (member === 'wait' || member === 'hold_key') timeout = Math.min(30, Number(c.input.duration) || 0) * 1000 + 15_000;
    try {
      const call = this.browser<ToolResult>('execute', params as unknown as Record<string, unknown>, timeout);
      call.catch(() => {});
      // Stop takes effect immediately, even mid-action (e.g. a long wait); the outcome of an
      // action cut off this way is unknown, which the result says.
      const stopped = new Promise<'stopped'>((resolve) => {
        if (signal.aborted) resolve('stopped');
        signal.addEventListener('abort', () => resolve('stopped'), { once: true });
      });
      const res = await Promise.race([call, stopped]);
      if (res === 'stopped') return this.errorResult('Not completed: the user stopped the task while this action was running; its effect is unknown.');
      return normalizeResult(res);
    } catch (e) {
      return this.errorResult(errText(e));
    }
  }

  /**
   * RPC to the extension. If the extension lost the session (service worker or extension
   * restart), begin it again on the same tab and retry once.
   */
  private async browser<T>(method: 'describe' | 'execute', params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    try {
      return await this.link.call<T>(method, params, timeoutMs);
    } catch (e) {
      if (!/session is not active in the browser/i.test(errText(e))) throw e;
      const res = await this.link.call<SessionBeginResult>(
        'session_begin',
        { sessionId: this.id, tabId: this.activeTabId, title: this.title, lockUserInput: this.host.settings().lockUserInput },
        30_000,
      );
      this.activeTabId = res.activeTabId;
      this.tabIds = res.tabs.map((t) => t.tab_id);
      this.emit({ type: 'notice', level: 'info', message: 'Reconnected to the browser tab after the extension restarted.' });
      return this.link.call<T>(method, params, timeoutMs);
    }
  }

  async end(): Promise<void> {
    this.stop();
    await this.settled().catch(() => {});
    await this.link.call('session_end', { sessionId: this.id }, 5000).catch(() => {});
  }
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('Error') ? m : `Error: ${m}`;
}

/** Guard against malformed executor output (the API rejects invalid result blocks). */
export function normalizeResult(res: ToolResult | undefined): ToolResult {
  if (!res || !Array.isArray(res.content)) return { isError: true, content: [{ type: 'text', text: 'Error: the browser returned no result.' }] };
  const content = res.content.filter((b) => {
    if (b.type === 'text') return typeof b.text === 'string';
    if (b.type === 'image') return typeof b.data === 'string' && b.data.length > 0;
    if (b.type === 'browser_state') return !res.isError && Array.isArray(b.tabs);
    return false;
  });
  // At most one browser_state block.
  let seen = false;
  const deduped = content.filter((b) => {
    if (b.type !== 'browser_state') return true;
    if (seen) return false;
    seen = true;
    return true;
  });
  return { ...res, content: deduped.length ? deduped : [{ type: 'text', text: res.isError ? 'Error.' : 'Done.' }] };
}

/** Don't echo typed secrets into the UI/logs verbatim when they go into sensitive fields. */
function redactInput(member: string, input: Record<string, unknown>, sensitive: boolean): Record<string, unknown> {
  if ((member === 'type' || member === 'form_input') && typeof (input.text ?? input.value) === 'string') {
    const v = String(input.text ?? input.value);
    if (sensitive || /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$|^(?=.*[a-zA-Z])(?=.*\d)(?=.*[^\w\s]).{8,}$/.test(v) && !/\s/.test(v) && v.length < 64) {
      // Looks like it could be a password/token: keep length only.
      return { ...input, ...(input.text != null ? { text: `•••• (${v.length} chars)` } : { value: `•••• (${v.length} chars)` }) };
    }
  }
  return input;
}

/** Pull a CaptchaKraken plan out of a reply (JSON object or a bare cell-number array). */
function parseCaptchaPlan(text: string): CaptchaActionPlan | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  const body = raw.slice(start).trim();
  const point = (v: unknown): [number, number] | null => {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const x = Number(v[0]);
    const y = Number(v[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  if (body.startsWith('[')) {
    try {
      const list = JSON.parse(body) as unknown[];
      const cells = list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      return cells.length ? { action: 'cells', cells } : null;
    } catch {
      return null;
    }
  }
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    if (obj.action === 'cells' && Array.isArray(obj.target_ids)) {
      const cells = obj.target_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      return cells.length ? { action: 'cells', cells } : null;
    }
    if (obj.action === 'click' && Array.isArray(obj.points)) {
      const points = obj.points.map(point).filter((p): p is [number, number] => !!p);
      return points.length ? { action: 'click', points } : null;
    }
    if (obj.action === 'drag' && Array.isArray(obj.drags)) {
      const drags = obj.drags
        .map((d) => (d && typeof d === 'object' ? (d as Record<string, unknown>) : {}))
        .map((d) => ({ from: point(d.from) ?? ([] as []), to: point(d.to) }))
        .filter((d): d is { from: [number, number] | []; to: [number, number] } => !!d.to);
      return drags.length ? { action: 'drag', drags } : null;
    }
    if (obj.action === 'type' && typeof obj.text === 'string' && obj.text.trim()) return { action: 'type', text: obj.text.trim() };
  } catch {
    /* not JSON */
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
