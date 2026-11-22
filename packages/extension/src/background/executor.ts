/**
 * Executor for the browser member tools (Anthropic browser_toolset_20260801 contract).
 * Every call returns a ToolResult: text / image / browser_state blocks, or an error.
 */
import {
  TAB_MEMBERS,
  checkUrlPolicy,
  hostOf,
  parseNavigateUrl,
  sanitizeTitle,
  sanitizeUrl,
  truncate,
  type ActionDescription,
  type BrowserMember,
  type CaptchaActionPlan,
  type CaptchaObservation,
  type CaptchaProbe,
  type ExecuteParams,
  type ResultBlock,
  type ToolResult,
} from '@ba/shared';
import { CdpError, attach, drainConsole, drainNetwork, enableConsole, iframeRect, isRestrictedUrl, openDialog, send } from './cdp.ts';
import { StaleRefError, frameCall, frameOffset, listFrames, lookupRef, probeFrame, refCall, refFor, type FrameInfo } from './frames.ts';
import { click, drag, mouseDown, mouseMove, mouseUp, parseKeySequence, parseModifiers, pressChord, typeText, wheel, type Button } from './input.ts';
import { captchaCrop, screenshot, toCss, viewport, zoom, imageScale } from './screenshot.ts';
import {
  addTab,
  getSession,
  overlay,
  parseTabId,
  rememberPolicy,
  resolveTab,
  setActiveTab,
  stateBlock,
  tabIdStr,
  type AgentSession,
} from './sessions.ts';
import { settle, sleep, waitForLoad } from './settle.ts';

const OUTPUT_CAP = 50_000;
const PAGE_TEXT_CAP = 100_000;

class ToolError extends Error {}

const err = (m: string) => new ToolError(m.startsWith('Error') || m.startsWith('Not executed') ? m : `Error: ${m}`);

/** Members that change page state and need a settle afterwards. */
const ACTING = new Set<BrowserMember>([
  'navigate', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover', 'left_click_drag',
  'left_mouse_down', 'left_mouse_up', 'mouse_move', 'scroll', 'scroll_to', 'type', 'key', 'hold_key', 'form_input',
  'file_upload', 'javascript_exec',
]);

/** Members allowed while a JS dialog blocks the page. */
const DIALOG_OK = new Set<BrowserMember>(['key', 'type', 'wait', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'navigate']);

interface Ctx {
  s: AgentSession;
  tabId: number;
  p: ExecuteParams;
  input: Record<string, any>;
  /** prompt() text typed while a prompt dialog is open */
}

const promptText = new Map<number, string>();

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

export async function execute(p: ExecuteParams): Promise<ToolResult> {
  let s: AgentSession;
  try {
    s = getSession(p.sessionId);
  } catch (e) {
    return errorResult(e);
  }
  const member = p.member;
  const input = (p.input ?? {}) as Record<string, any>;
  try {
    if (TAB_MEMBERS.includes(member)) return await tabMember(s, member, input);
    const tabId = resolveTab(s, input.tab_id);
    const tab = await chrome.tabs.get(tabId).catch(() => {
      throw err(`the tab ${tabIdStr(tabId)} no longer exists. Use list_tabs.`);
    });
    if (member !== 'navigate' && member !== 'wait' && isRestrictedUrl(tab.pendingUrl || tab.url)) {
      throw err(`${tabIdStr(tabId)} shows a browser-internal page (${truncate(tab.url ?? '', 80)}) that extensions cannot read or control. Use navigate to open a website.`);
    }
    const dialog = openDialog(tabId);
    if (dialog && !DIALOG_OK.has(member)) {
      throw err(`a JavaScript ${dialog.type} dialog is blocking the page ("${truncate(dialog.message, 200)}"). Press Enter to accept or Escape to dismiss it${dialog.type === 'prompt' ? ' (type text first to fill in the prompt)' : ''}.`);
    }
    const policy = { allowPrivateNetworks: p.settings.allowPrivateNetworks, blockedSites: p.settings.blockedSites };
    rememberPolicy(s, policy);
    // Every member (reads included) respects the URL policy: a page may have opened or redirected
    // this tab somewhere the agent may not go.
    const tabUrl = tab.pendingUrl || tab.url || '';
    if (member !== 'navigate' && /^https?:/.test(tabUrl)) {
      const e = checkUrlPolicy(tabUrl, policy);
      if (e) throw err(`${tabIdStr(tabId)} is on ${hostOf(tabUrl)}, which is not allowed (${e.replace(/^Error: /, '')}). Navigate elsewhere or close the tab.`);
    }
    // The action was approved for a specific document: refuse if the page changed meanwhile.
    if (p.expectDocKey && member !== 'navigate' && ACTING.has(member)) {
      const now = await docKey(tabId).catch(() => '');
      if (now && now !== p.expectDocKey) throw err('the page changed (navigated or reloaded) after this action was checked. Observe the page again before acting.');
    }
    const ctx: Ctx = { s, tabId, p, input };
    if (s.lockUserInput && ACTING.has(member)) await frameCall(tabId, 0, { type: 'ba:lock_suspend', value: true }, 2000).catch(() => {});
    let out: ResultBlock[];
    try {
      out = await run(ctx, member);
    } finally {
      if (s.lockUserInput && ACTING.has(member)) await frameCall(tabId, 0, { type: 'ba:lock_suspend', value: false }, 2000).catch(() => {});
    }
    return await finish(ctx, member, out);
  } catch (e) {
    return errorResult(e);
  }
}

const CAPTCHA_URL = /challenges\.cloudflare\.com|challenges\.cloudflare\.com\/turnstile|recaptcha|hcaptcha|arkoselabs|funcaptcha|\/cdn-cgi\/challenge-platform/i;
const CAPTCHA_TITLE = /just a moment|attention required|verify you are human|checking your browser|security check/i;

function captchaKind(u: string, t: string): CaptchaProbe['kind'] {
  if (/\/cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i.test(u)) return /turnstile/i.test(u) ? 'turnstile' : 'cloudflare';
  if (/recaptcha/i.test(u)) return 'recaptcha';
  if (/hcaptcha/i.test(u)) return 'hcaptcha';
  if (/arkoselabs|funcaptcha/i.test(u)) return 'unknown';
  return CAPTCHA_TITLE.test(t) ? 'cloudflare' : 'unknown';
}

const captchaObs = new Map<number, CaptchaObservation>();

/** Look for a CAPTCHA / Cloudflare challenge on a tab without changing it. */
export async function probeCaptcha(p: { sessionId: string; tab_id?: string }): Promise<CaptchaProbe> {
  const s = getSession(p.sessionId);
  const tabId = resolveTab(s, p.tab_id);
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw err(`${tabIdStr(tabId)} no longer exists.`);
  });
  const url = tab.pendingUrl || tab.url || '';
  const title = tab.title || '';
  const frames = await listFrames(tabId).catch(() => []);
  const challengeFrames = frames.filter((f) => CAPTCHA_URL.test(f.url));
  const kind = captchaKind(url, title);

  const check = async (frameId: number): Promise<CaptchaProbe | null> => {
    try {
      const r = await frameCall<CaptchaProbe>(tabId, frameId, { type: 'ba:captcha_probe' }, 3000);
      return r.result;
    } catch {
      return null;
    }
  };

  // The top frame sees the solved response token and can see a visible widget iframe.
  const main = await check(0);
  if (main?.solved) return { ...main, challenge: false, solved: true, kind: main.kind ?? kind };
  if (challengeFrames.length) {
    let challenge = false;
    let solved = false;
    let responded = 0;
    let detail = '';
    for (const f of challengeFrames.slice(0, 4)) {
      const r = await check(f.frameId);
      if (!r) continue;
      responded++;
      if (r.challenge) challenge = true;
      if (r.solved) solved = true;
      detail ||= r.detail ?? f.url;
    }
    if (challenge) return { challenge: true, kind: captchaKind(challengeFrames[0].url, title), detail: detail || challengeFrames[0].url };
    // The widget frame is still there but reports no active challenge: it was solved.
    if (responded || solved) return { challenge: false, solved: true, kind: captchaKind(challengeFrames[0].url, title), detail };
  }
  if (main?.challenge) return main;
  if (CAPTCHA_URL.test(url) || CAPTCHA_TITLE.test(title)) return { challenge: true, kind, detail: title || url };
  return { challenge: false };
}

/** Crop the current challenge (with numbered cells when it is a grid) for a captcha VLM. */
export async function captchaObserve(p: { sessionId: string; tab_id?: string }): Promise<CaptchaObservation> {
  const s = getSession(p.sessionId);
  const tabId = resolveTab(s, p.tab_id);
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw err(`${tabIdStr(tabId)} no longer exists.`);
  });
  const vp = await viewport(tabId);
  const url = tab.pendingUrl || tab.url || '';
  const title = tab.title || '';
  const loc = await frameCall<{ rect: { x: number; y: number; w: number; h: number }; inIframe: boolean }>(
    tabId, 0, { type: 'ba:captcha_locate' }, 4000,
  ).then((r) => r.result).catch(() => ({ rect: { x: 0, y: 0, w: vp.width, h: vp.height }, inIframe: false }));
  let region = loc.rect;
  let located = loc.inIframe;
  let grid: CaptchaObservation['grid'];
  const frames = await listFrames(tabId).catch(() => []);
  const challengeFrame = frames.find((f) => CAPTCHA_URL.test(f.url));
  // Some widgets live in a closed shadow root the top-frame scan cannot see; use the DOM domain.
  if (!loc.inIframe && challengeFrame) {
    const box = await iframeRect(tabId, CAPTCHA_URL);
    if (box && box.w > 10 && box.h > 10) {
      region = box;
      located = true;
    } else {
      try {
        const off = await frameOffset(tabId, challengeFrame.frameId);
        const hit = await probeFrame(tabId, challengeFrame.frameId);
        if (hit.visible && hit.width > 10 && hit.height > 10) {
          region = { x: off.x, y: off.y, w: hit.width, h: hit.height };
          located = true;
        }
      } catch {
        /* keep the full viewport */
      }
    }
  }
  if (!region.w || region.w < 20 || region.h < 20) {
    region = { x: 0, y: 0, w: vp.width, h: vp.height };
    located = false;
  }
  region = {
    x: Math.max(0, Math.min(vp.width - 1, region.x)),
    y: Math.max(0, Math.min(vp.height - 1, region.y)),
    w: Math.min(vp.width - Math.max(0, region.x), region.w),
    h: Math.min(vp.height - Math.max(0, region.y), region.h),
  };

  if (challengeFrame) {
    try {
      const off = await frameOffset(tabId, challengeFrame.frameId);
      const g = await frameCall<{ rows: number; cols: number; cells: { x: number; y: number; w: number; h: number }[] }>(
        tabId, challengeFrame.frameId, { type: 'ba:captcha_grid' }, 4000,
      );
      if (g.result) grid = { rows: g.result.rows, cols: g.result.cols, cells: g.result.cells.map((c) => ({ x: c.x + off.x, y: c.y + off.y, w: c.w, h: c.h })) };
    } catch {
      /* no grid */
    }
  }
  const shot = await captchaCrop(tabId, region, grid?.cells ?? []);
  const obs: CaptchaObservation = { kind: captchaKind(challengeFrame?.url || url, title), grid, region: shot.rect, shot, located };
  captchaObs.set(tabId, obs);
  return obs;
}

/** Apply a CaptchaKraken plan (normalized 0-1000 points / cell numbers / typed text). */
export async function captchaAction(p: {
  sessionId: string;
  tab_id?: string;
  plan: CaptchaActionPlan;
  settings?: { allowPrivateNetworks: boolean; blockedSites: string[] };
}): Promise<{ ok: true; message: string }> {
  const s = getSession(p.sessionId);
  const tabId = resolveTab(s, p.tab_id);
  const obs = captchaObs.get(tabId);
  if (!obs) throw err('the challenge image is stale; take a new observation first.');
  // These clicks bypass the per-action policy (they are confined to the challenge), so never act
  // blindly on the whole page, and never on a page the URL policy forbids.
  if (!obs.located) throw err('the challenge widget could not be located on the page; refusing to click outside it.');
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw err(`${tabIdStr(tabId)} no longer exists.`);
  });
  const tabUrl = tab.pendingUrl || tab.url || '';
  if (!p.settings) throw err('no URL policy was supplied for the CAPTCHA action.');
  if (/^https?:/.test(tabUrl)) {
    const e = checkUrlPolicy(tabUrl, { allowPrivateNetworks: p.settings.allowPrivateNetworks, blockedSites: p.settings.blockedSites });
    if (e) throw err(`${hostOf(tabUrl)} is not allowed (${e.replace(/^Error: /, '')}).`);
  }
  const plan = p.plan;
  const pt = (x: number, y: number) => ({
    x: Math.max(0, Math.min(obs.region.x + obs.region.w - 1, obs.region.x + (Math.max(0, Math.min(1000, x)) / 1000) * obs.region.w)),
    y: Math.max(0, Math.min(obs.region.y + obs.region.h - 1, obs.region.y + (Math.max(0, Math.min(1000, y)) / 1000) * obs.region.h)),
  });
  const center = { x: obs.region.x + obs.region.w / 2, y: obs.region.y + obs.region.h / 2 };
  let message = '';
  if (plan.action === 'click') {
    const points = plan.points.filter((q) => Array.isArray(q) && q.length === 2).map(([x, y]) => pt(Number(x), Number(y)));
    if (!points.length) throw err('the plan had no click points.');
    for (const q of points) {
      await click(tabId, q.x, q.y, 'left', 1, 0, 90);
      await sleep(120);
    }
    message = `Clicked ${points.map((q) => `(${Math.round(q.x)},${Math.round(q.y)})`).join(', ')}.`;
  } else if (plan.action === 'cells') {
    if (!obs.grid) throw err('the plan returned cell numbers but no grid was found.');
    const cells = plan.cells.filter((n) => Number.isInteger(n) && n >= 1 && n <= obs.grid!.cells.length);
    if (!cells.length) throw err('the plan had no valid cells.');
    for (const n of cells) {
      const c = obs.grid.cells[n - 1];
      await click(tabId, c.x + c.w / 2, c.y + c.h / 2, 'left', 1, 0, 90);
      await sleep(140);
    }
    message = `Clicked cells ${cells.join(', ')}.`;
  } else if (plan.action === 'drag') {
    for (const d of plan.drags ?? []) {
      const from = d.from?.length === 2 ? pt(Number(d.from[0]), Number(d.from[1])) : { x: center.x, y: center.y + obs.region.h * 0.3 };
      const to = pt(Number(d.to?.[0]), Number(d.to?.[1]));
      await drag(tabId, from, to);
      await sleep(200);
    }
    message = `Dragged ${(plan.drags ?? []).length} item(s).`;
  } else if (plan.action === 'type') {
    await click(tabId, center.x, center.y, 'left', 1, 0, 60);
    await sleep(80);
    await typeText(tabId, String(plan.text ?? ''));
    message = `Typed the answer (${String(plan.text ?? '').length} chars).`;
  } else {
    throw err('unknown captcha action plan.');
  }
  await settle(tabId, { maxMs: 1500 });
  captchaObs.delete(tabId);
  return { ok: true, message };
}

function errorResult(e: unknown): ToolResult {
  let m = e instanceof Error ? e.message : String(e);
  if (e instanceof CdpError && !m.startsWith('Error')) m = `Error: browser automation failed: ${m}`;
  if (!m.startsWith('Error') && !m.startsWith('Not executed')) m = `Error: ${m}`;
  return { isError: true, content: [{ type: 'text', text: truncate(m, 2000) }] };
}

async function finish(ctx: Ctx, member: BrowserMember, out: ResultBlock[]): Promise<ToolResult> {
  const { s, tabId } = ctx;
  if (ACTING.has(member) && member !== 'navigate') {
    const r = await settle(tabId, { maxMs: member === 'hover' || member === 'mouse_move' ? 1200 : 3000 });
    const mentioned = out.some((b) => b.type === 'text' && /dialog/i.test(b.text));
    if (r === 'dialog' && !mentioned) out.push({ type: 'text', text: dialogNote(tabId) });
  }
  const st = await stateBlock(s, false);
  if (ctx.p.attachScreenshot && !openDialog(tabId) && !out.some((b) => b.type === 'image')) {
    try {
      const shot = await captureClean(tabId);
      out.push({ type: 'image', mediaType: shot.mediaType, data: shot.data, width: shot.width, height: shot.height });
    } catch {
      /* best effort */
    }
  }
  if (st) {
    // A result whose only content is an image needs a text block for the tab context to render.
    if (!out.some((b) => b.type === 'text')) out.unshift({ type: 'text', text: 'Screenshot captured.' });
    out.push(st);
  }
  return { isError: false, content: out, executedOn: tabIdStr(tabId) };
}

function dialogNote(tabId: number): string {
  const d = openDialog(tabId);
  if (!d) return '';
  return `A JavaScript ${d.type} dialog opened: "${truncate(d.message, 300)}". Press Enter to accept or Escape to dismiss it${d.type === 'prompt' ? ' (type text first to fill in the prompt)' : ''}; the page is blocked until then.`;
}

/** Auto-accept plain alerts and beforeunload prompts so they don't wedge the session. */
export function onDialogOpened(tabId: number, params: { type: string; message: string }): void {
  if (params.type === 'alert') {
    setTimeout(() => {
      send(tabId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }, 50);
    alerts.set(tabId, [...(alerts.get(tabId) ?? []), params.message]);
  }
}
const alerts = new Map<number, string[]>();

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

async function run(ctx: Ctx, member: BrowserMember): Promise<ResultBlock[]> {
  const { input, tabId } = ctx;
  const text = (t: string): ResultBlock[] => {
    const a = alerts.get(tabId);
    if (a?.length) {
      alerts.delete(tabId);
      t += `\n${a.map((m) => `An alert dialog appeared and was dismissed: "${truncate(m, 300)}"`).join('\n')}`;
    }
    return [{ type: 'text', text: t }];
  };
  switch (member) {
    case 'navigate':
      return text(await navigate(ctx));
    case 'screenshot': {
      const shot = await captureClean(tabId);
      // Stating the pixel frame helps models (especially smaller local VLMs) calibrate coordinates.
      return [
        { type: 'text', text: `Screenshot of the viewport, ${shot.width}×${shot.height} pixels (x from the left edge, y from the top edge). Click coordinates use this pixel space.` },
        { type: 'image', mediaType: shot.mediaType, data: shot.data, width: shot.width, height: shot.height },
      ];
    }
    case 'zoom': {
      const shot = await zoom(tabId, input.region);
      return [{ type: 'image', mediaType: shot.mediaType, data: shot.data, width: shot.width, height: shot.height }];
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
      return text(await clickMember(ctx, member));
    case 'hover': {
      const t = await resolveTarget(ctx, input.target, { ref: true, coordinate: true });
      cursor(tabId, t.x, t.y, false);
      await mouseMove(tabId, t.x, t.y);
      return text(`Hovered over ${t.label}.`);
    }
    case 'left_click_drag': {
      const from = await resolveTarget(ctx, input.from, { ref: false, coordinate: true });
      const to = await resolveTarget(ctx, input.target, { ref: false, coordinate: true });
      cursor(tabId, from.x, from.y, false);
      await drag(tabId, from, to);
      cursor(tabId, to.x, to.y, true);
      return text(`Dragged from ${from.label} to ${to.label}.`);
    }
    case 'left_mouse_down': {
      const t = await resolveTarget(ctx, input.target, { ref: false, coordinate: true });
      await mouseDown(tabId, t.x, t.y);
      return text(`Pressed the left button at ${t.label}.`);
    }
    case 'left_mouse_up': {
      const t = await resolveTarget(ctx, input.target, { ref: false, coordinate: true });
      await mouseUp(tabId, t.x, t.y);
      return text(`Released the left button at ${t.label}.`);
    }
    case 'mouse_move': {
      const t = await resolveTarget(ctx, input.target, { ref: false, coordinate: true });
      cursor(tabId, t.x, t.y, false);
      await mouseMove(tabId, t.x, t.y);
      return text(`Moved the pointer to ${t.label}.`);
    }
    case 'scroll':
      return text(await scrollMember(ctx));
    case 'scroll_to': {
      const ref = refOf(input.target);
      const { result } = await refCall<{ description: string }>(tabId, ref, { type: 'ba:scroll_to' });
      return text(`Scrolled ${ref} (${result.description}) into view.`);
    }
    case 'type':
      return text(await typeMember(ctx));
    case 'key':
      return text(await keyMember(ctx));
    case 'hold_key': {
      const d = clampDuration(input.duration);
      const chords = parseKeySequence(String(input.text ?? ''));
      for (const c of chords) await pressChord(tabId, c, d * 1000);
      return text(`Held ${input.text} for ${d} seconds.`);
    }
    case 'wait': {
      const d = clampDuration(input.duration);
      await sleep(d * 1000);
      const dn = dialogNote(tabId);
      return text(`Waited ${d} seconds.${dn ? ' ' + dn : ''}`);
    }
    case 'read_page':
      return text(await readPage(ctx));
    case 'find':
      return text(await findMember(ctx));
    case 'get_page_text':
      return text(await pageText(ctx));
    case 'form_input': {
      const ref = refOf(input.target);
      if (input.value === undefined) throw err('form_input requires a value.');
      const { result } = await refCall<{ ok: boolean; message: string }>(tabId, ref, { type: 'ba:form_input', value: input.value });
      if (!result.ok) throw err(result.message);
      return text(result.message.replace(/^Set /, `Set ${ref} `).replace(/^(Checked|Unchecked) /, `$1 ${ref} `));
    }
    case 'file_upload':
      return text(await fileUpload(ctx));
    case 'read_console': {
      const first = !(await consoleEnabled(tabId));
      await enableConsole(tabId);
      const lines = drainConsole(tabId);
      const head = first ? 'Console capture started now; earlier entries are not available.\n' : '';
      return text(head + (lines.length ? redactLines(lines).join('\n') : 'No new console entries.'));
    }
    case 'read_network': {
      const lines = drainNetwork(tabId);
      return text(lines.length ? truncate(lines.join('\n'), OUTPUT_CAP) : 'No new network requests since the last read.');
    }
    case 'javascript_exec':
      return text(await jsExec(ctx));
    default:
      throw err(`${member} is not implemented by this executor.`);
  }
}

const consoleOn = new Set<number>();
async function consoleEnabled(tabId: number): Promise<boolean> {
  const was = consoleOn.has(tabId);
  consoleOn.add(tabId);
  return was;
}

function redactLines(lines: string[]): string[] {
  return lines.map((l) =>
    truncate(
      l
        .replace(/(bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
        .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)\b/g, '[REDACTED_JWT]')
        .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)["'\s:=]+)([^\s"',;]{6,})/gi, '$1[REDACTED]'),
      600,
    ),
  );
}

function clampDuration(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err('duration must be a number of seconds between 0 and 30.');
  return Math.min(30, n);
}

function refOf(target: any): string {
  if (!target || target.type !== 'ref' || typeof target.ref !== 'string') throw err('target must be an element reference like {"type": "ref", "ref": "ref_12"}.');
  return target.ref;
}

function cursor(tabId: number, x: number, y: number, clicked: boolean): void {
  frameCall(tabId, 0, { type: 'ba:cursor', x, y, click: clicked }, 1000).catch(() => {});
}

async function captureClean(tabId: number) {
  await frameCall(tabId, 0, { type: 'ba:overlay_capture', hidden: true }, 1500).catch(() => {});
  try {
    return await screenshot(tabId);
  } finally {
    frameCall(tabId, 0, { type: 'ba:overlay_capture', hidden: false }, 1500).catch(() => {});
  }
}

// Targets -------------------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
  label: string;
  ref?: string;
  unclickable?: string;
}

/** One parser for targets, used by both describe (policy) and execution. */
export function targetKind(target: any): 'ref' | 'coordinate' | null {
  if (!target || typeof target !== 'object') return null;
  if (target.type === 'ref') return typeof target.ref === 'string' ? 'ref' : null;
  if (target.type === 'coordinate') return 'coordinate';
  if (target.type === undefined) {
    if (typeof target.ref === 'string') return 'ref';
    if (target.x !== undefined && target.y !== undefined) return 'coordinate';
  }
  return null;
}

async function docKey(tabId: number): Promise<string> {
  const { docNonce } = await frameCall(tabId, 0, { type: 'ba:hello' }, 3000);
  return docNonce;
}

async function resolveTarget(ctx: Ctx, target: any, allow: { ref: boolean; coordinate: boolean }): Promise<Point> {
  if (!target || typeof target !== 'object') throw err('a target object is required.');
  const kind = targetKind(target);
  if (kind === 'ref') {
    if (!allow.ref) throw err('this action needs a coordinate target {"type": "coordinate", "x": .., "y": ..}.');
    const ref = String(target.ref);
    const { result, target: t } = await refCall<{ x?: number; y?: number; unclickable?: string; description: string }>(ctx.tabId, ref, { type: 'ba:resolve', scroll: true });
    const off = t.frameId === 0 ? { x: 0, y: 0 } : await frameOffset(ctx.tabId, t.frameId);
    return { x: (result.x ?? 0) + off.x, y: (result.y ?? 0) + off.y, label: `element ${ref} (${result.description})`, ref, unclickable: result.unclickable };
  }
  if (kind === 'coordinate') {
    if (!allow.coordinate) throw err('this action needs an element reference target {"type": "ref", "ref": "ref_N"}.');
    const p = await toCss(ctx.tabId, target.x, target.y);
    return { x: p.x, y: p.y, label: `(${target.x}, ${target.y})` };
  }
  throw err('target must be {"type": "ref", "ref": ".."} or {"type": "coordinate", "x": .., "y": ..}.');
}

async function clickMember(ctx: Ctx, member: BrowserMember): Promise<string> {
  const { tabId, input } = ctx;
  const t = await resolveTarget(ctx, input.target, { ref: true, coordinate: true });
  const modifiers = parseModifiers(input.modifiers);
  const button: Button = member === 'right_click' ? 'right' : member === 'middle_click' ? 'middle' : 'left';
  const count = member === 'double_click' ? 2 : member === 'triple_click' ? 3 : 1;
  const verb = { left_click: 'Clicked', right_click: 'Right-clicked', middle_click: 'Middle-clicked', double_click: 'Double-clicked', triple_click: 'Triple-clicked' }[member as 'left_click'];
  if (t.ref && t.unclickable) {
    // Only zero-size (visually hidden) controls get a programmatic click. A covered element must
    // not be clicked through its overlay: the overlay may be a confirmation dialog or a blocker
    // the user would have to deal with first.
    const hiddenControl = /no size/.test(t.unclickable);
    if (hiddenControl && member === 'left_click' && !modifiers) {
      const { result } = await refCall<{ ok: boolean }>(tabId, t.ref, { type: 'ba:dom_click' });
      if (result.ok) return `${verb} ${t.label} programmatically, because ${t.unclickable}. Verify the result.`;
    }
    const hint = /covered/.test(t.unclickable) ? 'Dismiss or close what covers it first (e.g. a banner or dialog), or scroll it into a clear area.' : 'Scroll it into view, or use a coordinate from a screenshot.';
    throw err(`cannot ${member.replace('_', ' ')} ${t.label}: ${t.unclickable}. ${hint}`);
  }
  // For coordinate clicks, say what is under the pointer so the model knows what it hit
  // (it can't otherwise tell "the speed button" from "the video surface").
  let hitLabel = '';
  if (!t.ref) {
    const at = await describeAt(tabId, t.x, t.y).catch(() => null);
    const info = at?.info;
    if (info) {
      const name = info.name ? ` "${truncate(String(info.name), 60)}"` : '';
      hitLabel = ` on ${info.role === 'generic' ? info.tag : info.role}${name}`;
    }
  }
  cursor(tabId, t.x, t.y, true);
  await click(tabId, Math.round(t.x), Math.round(t.y), button, count, modifiers, t.ref ? 0 : 150);
  // Say what the click changed for toggles, so the model needn't judge it from a screenshot.
  const after = await toggleState(ctx, t).catch(() => '');
  return `${verb} ${t.label}${hitLabel}.${after}`;
}

async function toggleState(ctx: Ctx, t: Point): Promise<string> {
  await sleep(120);
  let info: any;
  if (t.ref) info = (await refCall<any>(ctx.tabId, t.ref, { type: 'ba:describe' }, 3000)).result.info;
  else info = (await describeAt(ctx.tabId, t.x, t.y)).info;
  if (!info || typeof info.checked !== 'boolean') return '';
  return ` ${info.role === 'radio' ? 'The option' : 'It'} "${truncate(String(info.name || info.role), 60)}" is now ${info.checked ? 'checked' : 'unchecked'}.`;
}

async function scrollMember(ctx: Ctx): Promise<string> {
  const { tabId, input } = ctx;
  const dir = String(input.scroll_direction ?? '');
  if (!['up', 'down', 'left', 'right'].includes(dir)) throw err('scroll_direction must be up, down, left or right.');
  const amount = Math.max(1, Math.min(10, Math.round(Number(input.scroll_amount ?? 3)) || 3));
  let pt: Point;
  if (input.target) pt = await resolveTarget(ctx, input.target, { ref: false, coordinate: true });
  else {
    const vp = await frameCall<{ width: number; height: number }>(tabId, 0, { type: 'ba:viewport' }, 3000);
    pt = { x: vp.result.width / 2, y: vp.result.height / 2, label: 'the page center' };
  }
  const before = await frameCall<any>(tabId, 0, { type: 'ba:scroll_state' }, 3000).then((r) => r.result).catch(() => null);
  const delta = amount * 100;
  await wheel(tabId, pt.x, pt.y, dir === 'left' ? -delta : dir === 'right' ? delta : 0, dir === 'up' ? -delta : dir === 'down' ? delta : 0);
  await sleep(250);
  const after = await frameCall<any>(tabId, 0, { type: 'ba:scroll_state' }, 3000).then((r) => r.result).catch(() => null);
  let note = '';
  if (before && after) {
    if (before.x === after.x && before.y === after.y) note = ' The page itself did not move (an inner scrollable area may have scrolled, or it is already at the end).';
    else note = ` Page scroll position is now ${after.y}px of ${after.maxY}px vertically${after.maxX ? `, ${after.x}px of ${after.maxX}px horizontally` : ''}.`;
  }
  return `Scrolled ${dir} by ${amount} at ${pt.label}.${note}`;
}

/** Find the deepest focused element, following focus into child frames. */
async function focusedField(tabId: number): Promise<{ description?: string; value?: string; nothingFocused?: boolean; frameId: number }> {
  let frameId = 0;
  for (let depth = 0; depth < 6; depth++) {
    const { result } = await frameCall<any>(tabId, frameId, { type: 'ba:focused_state' }, 3000);
    if (!result.isIframe) return { ...result, frameId };
    const children = (await listFrames(tabId)).filter((f) => f.parentFrameId === frameId);
    let next: number | undefined;
    for (const c of children) {
      try {
        const hit = await probeFrame(tabId, c.frameId, 1000);
        if (hit.iframeId === result.iframeId) {
          next = c.frameId;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (next === undefined) return { description: 'an embedded frame', frameId };
    frameId = next;
  }
  return { description: 'an embedded frame', frameId };
}

async function typeMember(ctx: Ctx): Promise<string> {
  const { tabId, input } = ctx;
  const value = input.text;
  if (typeof value !== 'string') throw err('type requires a text string.');
  const dialog = openDialog(tabId);
  if (dialog) {
    if (dialog.type !== 'prompt') throw err(`a ${dialog.type} dialog is open; typing is only possible into prompt dialogs. Press Enter or Escape.`);
    promptText.set(tabId, (promptText.get(tabId) ?? '') + value);
    return `Typed into the prompt dialog. Press Enter to submit it.`;
  }
  const before = await focusedField(tabId).catch(() => ({ nothingFocused: false, frameId: 0 }) as const);
  if (before.nothingFocused) throw err('no element has keyboard focus, so the text would go nowhere. Click the target field first (or use form_input).');
  await typeText(tabId, value);
  await sleep(60);
  const after = await focusedField(tabId).catch(() => null);
  const secret = !!(after && (after as { sensitive?: boolean }).sensitive);
  const shown = secret ? `••••" (${value.length} chars)` : value.length > 80 ? `${value.slice(0, 80)}…" (${value.length} chars)` : `${value}"`;
  if (after?.description) {
    const v = after.value !== undefined ? ` Its value is now "${truncate(after.value, 200)}".` : '';
    return `Typed "${shown} into ${after.description}.${v}`;
  }
  return `Typed "${shown}.`;
}

async function keyMember(ctx: Ctx): Promise<string> {
  const { tabId, input } = ctx;
  const spec = String(input.text ?? '');
  const repeat = Math.max(1, Math.min(100, Math.round(Number(input.repeat ?? 1)) || 1));
  const dialog = openDialog(tabId);
  if (dialog) {
    const k = spec.trim().toLowerCase();
    if (['enter', 'return', 'escape', 'esc'].includes(k)) {
      const accept = k === 'enter' || k === 'return';
      const pt = promptText.get(tabId);
      promptText.delete(tabId);
      await send(tabId, 'Page.handleJavaScriptDialog', { accept, ...(accept && pt !== undefined ? { promptText: pt } : {}) });
      return `${accept ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog "${truncate(dialog.message, 200)}".`;
    }
    throw err(`a ${dialog.type} dialog is open; press Enter to accept or Escape to dismiss it.`);
  }
  const chords = parseKeySequence(spec);
  for (let i = 0; i < repeat; i++) for (const c of chords) await pressChord(tabId, c);
  return `Pressed ${spec}${repeat > 1 ? ` ${repeat} times` : ''}.`;
}

// Navigation ------------------------------------------------------------------------------------

async function navigate(ctx: Ctx): Promise<string> {
  const { tabId, input, p } = ctx;
  const target = parseNavigateUrl(input.url);
  if (target.kind === 'error') throw err(target.message);
  const policy = { allowPrivateNetworks: p.settings.allowPrivateNetworks, blockedSites: p.settings.blockedSites };
  const tab = await chrome.tabs.get(tabId);
  const restricted = isRestrictedUrl(tab.url);
  const dialog = openDialog(tabId);
  // Leaving the page: alerts/beforeunload are acknowledged, but confirm()/prompt() are dismissed —
  // never answered "yes" on the user's behalf.
  if (dialog) await send(tabId, 'Page.handleJavaScriptDialog', { accept: dialog.type === 'alert' || dialog.type === 'beforeunload' }).catch(() => {});

  if (target.kind === 'history') {
    try {
      if (target.action === 'back') await chrome.tabs.goBack(tabId);
      else if (target.action === 'forward') await chrome.tabs.goForward(tabId);
      else await chrome.tabs.reload(tabId);
    } catch (e) {
      throw err(`cannot go ${target.action}: ${(e as Error).message}`);
    }
  } else {
    const policyErr = checkUrlPolicy(target.url, policy);
    if (policyErr) throw err(policyErr);
    if (restricted) {
      await chrome.tabs.update(tabId, { url: target.url });
    } else {
      await attach(tabId);
      const r = await send<{ errorText?: string }>(tabId, 'Page.navigate', { url: target.url });
      if (r.errorText && r.errorText !== 'net::ERR_ABORTED') throw err(`navigation to ${target.url} failed: ${r.errorText}.`);
    }
  }
  const status = await waitForLoad(tabId, 30_000);
  const after = await chrome.tabs.get(tabId);
  const finalUrl = after.url ?? '';
  if (/^https?:/.test(finalUrl)) {
    const e2 = checkUrlPolicy(finalUrl, policy);
    if (e2) {
      await chrome.tabs.update(tabId, { url: 'about:blank' });
      throw err(`the page redirected to ${hostOf(finalUrl)}, which is not allowed: ${e2.replace(/^Error: /, '')}`);
    }
  }
  if (!isRestrictedUrl(finalUrl)) {
    await attach(tabId).catch(() => {});
    if (ctx.s.running && tabId === ctx.s.activeTab) await overlay(tabId, true, ctx.s);
  }
  if (status === 'dialog') return `Navigation started. ${dialogNote(tabId)}`;
  await settle(tabId, { minMs: 50, maxMs: 2500 });
  const what = target.kind === 'history' ? (target.action === 'reload' ? 'Reloaded' : `Went ${target.action} to`) : 'Navigated to';
  const title = after.title ? ` (title: "${sanitizeTitle(after.title, 120)}")` : '';
  const shownUrl = sanitizeUrl(finalUrl);
  if (status === 'timeout') return `${what} ${shownUrl}, but the page is still loading after 30 seconds${title}.`;
  if (/^chrome-error:/.test(finalUrl) || after.title?.match(/^(This site can.t be reached|.* is not available)/)) {
    return `${what} ${shownUrl}${title}, but the browser shows an error page.`;
  }
  return target.kind === 'history' && target.action === 'reload' ? `Reloaded ${shownUrl}${title}.` : `${what} ${shownUrl}${title}.`;
}

// Tabs ----------------------------------------------------------------------------------------

async function tabMember(s: AgentSession, member: BrowserMember, input: Record<string, any>): Promise<ToolResult> {
  if (member === 'new_tab') {
    const tab = await chrome.tabs.create({ windowId: s.windowId, url: 'about:blank', active: true }).catch(() => chrome.tabs.create({ url: 'about:blank', active: true }));
    if (tab.windowId !== s.windowId) s.windowId = tab.windowId;
    await addTab(s, tab.id!, false);
    await setActiveTab(s, tab.id!);
    // Exactly one tab_opened: this tab.
    s.pendingChanges = s.pendingChanges.filter((c) => c.type !== 'tab_opened');
    s.pendingChanges.push({ type: 'tab_opened', tab_id: tabIdStr(tab.id!) });
    const block = (await stateBlock(s, true))!;
    const active = block.tabs.find((t) => t.active);
    if (active) active.url = 'about:blank';
    return { isError: false, content: [block], executedOn: tabIdStr(tab.id!) };
  }
  if (member === 'list_tabs') {
    s.pendingChanges = s.pendingChanges.filter((c) => c.type !== 'tab_opened');
    const block = (await stateBlock(s, true))!;
    return { isError: false, content: [block] };
  }
  const id = parseTabId(input.tab_id);
  if (!s.tabs.includes(id)) throw err(`${String(input.tab_id)} is not one of this task's tabs. Use list_tabs.`);
  if (member === 'switch_tab') {
    await chrome.tabs.update(id, { active: true });
    await setActiveTab(s, id);
  } else {
    await chrome.tabs.remove(id);
    s.tabs = s.tabs.filter((t) => t !== id);
    if (s.activeTab === id && s.tabs.length) await setActiveTab(s, s.tabs[s.tabs.length - 1]);
  }
  s.pendingChanges = s.pendingChanges.filter((c) => c.type !== 'tab_opened');
  const block = (await stateBlock(s, true))!;
  return { isError: false, content: [block], executedOn: tabIdStr(id) };
}

// Page reading ----------------------------------------------------------------------------------

interface Line {
  depth: number;
  role: string;
  name: string;
  id?: number;
  props: string;
  iframe?: boolean;
}

function fmtLine(l: Line, base: number, ref: string): string {
  const indent = '  '.repeat(base + l.depth);
  const name = l.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (l.role === 'text') return `${indent}text "${name}"`;
  return `${indent}${l.role}${name ? ` "${name}"` : ''}${ref ? ` [${ref}]` : ''}${l.props ? ' ' + l.props : ''}`;
}

/** Map <iframe> element ids in a frame to child frame ids. */
async function childFrameMap(tabId: number, frameId: number, frames: FrameInfo[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const children = frames.filter((f) => f.parentFrameId === frameId);
  await Promise.all(
    children.map(async (c) => {
      try {
        const hit = await probeFrame(tabId, c.frameId, 1500);
        map.set(hit.iframeId, c.frameId);
      } catch {
        /* frame not reachable */
      }
    }),
  );
  return map;
}

/** Frames whose URL the policy forbids are not read (their content never reaches the model). */
function frameBlocked(frames: FrameInfo[], frameId: number, policy: { allowPrivateNetworks: boolean; blockedSites: string[] }): string | null {
  const f = frames.find((x) => x.frameId === frameId);
  if (!f || !/^https?:/.test(f.url)) return null;
  return checkUrlPolicy(f.url, policy) ? hostOf(f.url) : null;
}

let currentPolicy = { allowPrivateNetworks: false, blockedSites: [] as string[] };

async function frameOutline(tabId: number, frameId: number, req: { filter?: string; depth: number; rootId?: number }, base: number, frames: FrameInfo[], out: string[], budget: { chars: number; truncated: boolean }): Promise<void> {
  const { result, docNonce } = await frameCall<{ lines: Line[]; truncated: boolean; stale?: boolean }>(tabId, frameId, { type: 'ba:outline', filter: req.filter, depth: req.depth, rootId: req.rootId }, 20_000);
  if (result.stale) throw new StaleRefError('stale');
  if (result.truncated) budget.truncated = true;
  const hasFrames = result.lines.some((l) => l.iframe);
  const frameMap = hasFrames ? await childFrameMap(tabId, frameId, frames) : new Map<number, number>();
  for (const l of result.lines) {
    if (budget.chars <= 0) {
      budget.truncated = true;
      return;
    }
    const ref = l.id !== undefined ? await refFor(tabId, frameId, docNonce, l.id) : '';
    const line = fmtLine(l, base, ref);
    out.push(line);
    budget.chars -= line.length + 1;
    if (l.iframe && l.id !== undefined) {
      const child = frameMap.get(l.id);
      const remaining = req.depth - (l.depth + 1);
      const blockedHost = child !== undefined ? frameBlocked(frames, child, currentPolicy) : null;
      if (blockedHost) {
        out.push(`${'  '.repeat(base + l.depth + 1)}(frame content withheld: ${blockedHost} is not allowed by policy)`);
      } else if (child !== undefined && remaining > 0) {
        try {
          await frameOutline(tabId, child, { filter: req.filter, depth: remaining }, base + l.depth + 1, frames, out, budget);
        } catch (e) {
          out.push(`${'  '.repeat(base + l.depth + 1)}(frame content unavailable: ${truncate((e as Error).message, 120)})`);
        }
      }
    }
  }
}

async function readPage(ctx: Ctx): Promise<string> {
  const { tabId, input } = ctx;
  currentPolicy = { allowPrivateNetworks: ctx.p.settings.allowPrivateNetworks, blockedSites: ctx.p.settings.blockedSites };
  const filter = input.filter === 'interactive' || input.filter === 'all' ? input.filter : undefined;
  if (input.filter !== undefined && input.filter !== null && !filter) throw err('filter must be "interactive" or "all" (or omitted).');
  const depth = Math.max(1, Math.round(Number(input.depth ?? 15)) || 15);
  const frames = await listFrames(tabId);
  const out: string[] = [];
  const budget = { chars: OUTPUT_CAP - 400, truncated: false };
  if (input.ref) {
    const t = await lookupRef(tabId, String(input.ref));
    if (frameBlocked(frames, t.frameId, currentPolicy)) throw err(`${input.ref} is inside a frame whose site is not allowed by policy.`);
    try {
      const probe = await frameCall<{ url: string }>(tabId, t.frameId, { type: 'ba:hello' }, 5000);
      if (probe.docNonce !== t.doc) throw new StaleRefError('stale');
      await frameOutline(tabId, t.frameId, { filter, depth, rootId: t.id }, 0, frames, out, budget);
    } catch (e) {
      if (e instanceof StaleRefError) throw err(`${input.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
      throw e;
    }
  } else {
    await frameOutline(tabId, 0, { filter, depth }, 0, frames, out, budget);
  }
  if (!out.length) {
    return filter === 'interactive'
      ? 'No visible interactive elements in the viewport. Try scrolling, read_page with filter "all", or a screenshot.'
      : 'No visible elements found. The page may still be loading, be empty, or render with canvas; try a screenshot.';
  }
  let text = out.join('\n');
  if (budget.truncated) {
    text += `\n[Output truncated at about ${OUTPUT_CAP.toLocaleString('en-US')} characters. Narrow the read with filter "interactive", a smaller depth, or the ref of a container.]`;
  }
  if (!filter) {
    const sc = await frameCall<any>(tabId, 0, { type: 'ba:scroll_state' }, 3000).then((r) => r.result).catch(() => null);
    if (sc && sc.maxY > 0) text += `\n[Viewport shows ${sc.y}–${sc.y + sc.vh}px of ${sc.maxY + sc.vh}px page height; elements outside it are omitted (use filter "all" to include them).]`;
  }
  return text;
}

async function findMember(ctx: Ctx): Promise<string> {
  const { tabId, input } = ctx;
  const query = String(input.query ?? '').trim();
  if (!query) throw err('find requires a query.');
  const policy = { allowPrivateNetworks: ctx.p.settings.allowPrivateNetworks, blockedSites: ctx.p.settings.blockedSites };
  const frames = await listFrames(tabId);
  const all: { frameId: number; doc: string; m: { id: number; role: string; name: string; props: string; score: number } }[] = [];
  await Promise.all(
    frames.filter((f) => !frameBlocked(frames, f.frameId, policy)).map(async (f) => {
      try {
        const { result, docNonce } = await frameCall<{ matches: { id: number; role: string; name: string; props: string; score: number }[] }>(tabId, f.frameId, { type: 'ba:find', query, limit: 20 }, 15_000);
        for (const m of result.matches) all.push({ frameId: f.frameId, doc: docNonce, m });
      } catch {
        /* unreachable frame */
      }
    }),
  );
  all.sort((a, b) => b.m.score - a.m.score || a.frameId - b.frameId);
  const top = all.slice(0, 20);
  if (!top.length) return `No elements matching "${truncate(query, 100)}" were found. Try different words, read_page, or a screenshot.`;
  const lines: string[] = [];
  for (const x of top) {
    const ref = await refFor(tabId, x.frameId, x.doc, x.m.id);
    lines.push(fmtLine({ depth: 0, role: x.m.role, name: x.m.name, props: x.m.props }, 0, ref));
  }
  return lines.join('\n');
}

async function pageText(ctx: Ctx): Promise<string> {
  const { tabId } = ctx;
  const top = await frameCall<{ title: string; url: string; text: string; truncated: boolean }>(tabId, 0, { type: 'ba:text', maxChars: PAGE_TEXT_CAP }, 20_000);
  let out = `Title: ${sanitizeTitle(top.result.title)}\nURL: ${sanitizeUrl(top.result.url)}\n\n${top.result.text || '(no visible text)'}`;
  let truncated = top.result.truncated;
  const policy = { allowPrivateNetworks: ctx.p.settings.allowPrivateNetworks, blockedSites: ctx.p.settings.blockedSites };
  const allFrames = await listFrames(tabId);
  const frames = allFrames.filter((f) => f.frameId !== 0 && !frameBlocked(allFrames, f.frameId, policy));
  for (const f of frames) {
    if (out.length >= PAGE_TEXT_CAP) {
      truncated = true;
      break;
    }
    try {
      const hit = await probeFrame(tabId, f.frameId, 1000);
      if (!hit.visible) continue;
      const r = await frameCall<{ text: string; url: string }>(tabId, f.frameId, { type: 'ba:text', maxChars: 20_000 }, 10_000);
      if (r.result.text.trim()) out += `\n\n--- Embedded frame: ${sanitizeUrl(r.result.url, 150)} ---\n${r.result.text}`;
    } catch {
      /* skip */
    }
  }
  if (out.length > PAGE_TEXT_CAP) {
    out = out.slice(0, PAGE_TEXT_CAP);
    truncated = true;
  }
  if (truncated) out += `\n[Text truncated at ${PAGE_TEXT_CAP.toLocaleString('en-US')} characters.]`;
  return out;
}

// Files / scripting -----------------------------------------------------------------------------

function findNodeByAttr(node: any, attr: string, value: string): number | undefined {
  const attrs: string[] = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === attr && attrs[i + 1] === value) return node.nodeId;
  for (const c of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
    const r = findNodeByAttr(c, attr, value);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function fileUpload(ctx: Ctx): Promise<string> {
  const { tabId, input } = ctx;
  const ref = refOf(input.target);
  const paths: string[] = Array.isArray(input.paths) ? input.paths.map(String) : [];
  if (!paths.length) throw err('file_upload needs paths (document_ids are not supported by this executor).');
  const token = crypto.randomUUID();
  const { result } = await refCall<{ ok?: boolean; multiple?: boolean; error?: string }>(tabId, ref, { type: 'ba:mark_upload', token });
  if (!result.ok) throw err(result.error ?? 'could not prepare the file input.');
  if (paths.length > 1 && !result.multiple) throw err('this file input accepts a single file.');
  try {
    const doc = await send<{ root: any }>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    const nodeId = findNodeByAttr(doc.root, 'data-ba-upload', token);
    if (nodeId === undefined) throw err('the file input is inside a cross-origin frame, which file_upload does not support.');
    await send(tabId, 'DOM.setFileInputFiles', { nodeId, files: paths });
  } finally {
    const t = await lookupRef(tabId, ref).catch(() => null);
    if (t) frameCall(tabId, t.frameId, { type: 'ba:unmark_upload', token }, 2000).catch(() => {});
  }
  return `Set ${paths.length} file(s) on ${ref}: ${paths.map((p) => p.split(/[\\/]/).pop()).join(', ')}.`;
}

async function jsExec(ctx: Ctx): Promise<string> {
  const code = String(ctx.input.text ?? '');
  if (!code.trim()) throw err('javascript_exec requires text.');
  const r = await send<any>(ctx.tabId, 'Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 15_000, replMode: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw err(`JavaScript error: ${truncate(d.exception?.description ?? d.text ?? 'exception', 2000)}`);
  }
  const v = r.result;
  let out: string;
  if (v.type === 'undefined') out = 'undefined';
  else if (v.value !== undefined) out = typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 1);
  else out = v.description ?? String(v.type);
  return truncate(out, 20_000);
}

// ---------------------------------------------------------------------------------------------
// describe (for the server's safety policy, before an action runs)
// ---------------------------------------------------------------------------------------------

export async function describe(params: { sessionId: string; member: BrowserMember; input: Record<string, any> }): Promise<ActionDescription> {
  const s = getSession(params.sessionId);
  const input = params.input ?? {};
  const tabId = TAB_MEMBERS.includes(params.member) ? s.activeTab : resolveTab(s, input.tab_id);
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  const desc: ActionDescription = { tabId: tabIdStr(tabId), url, host: hostOf(url) };
  const dialog = openDialog(tabId);
  if (dialog) {
    desc.dialog = { type: dialog.type, message: truncate(dialog.message, 300) };
    return desc;
  }
  if (isRestrictedUrl(url)) return desc;
  const member = params.member;
  // For a drag the press happens at `from`; for everything else at `target`.
  const target = member === 'left_click_drag' ? input.from : input.target;
  const kind = targetKind(target);
  const frameUrl = async (frameId: number) => (await listFrames(tabId)).find((f) => f.frameId === frameId)?.url;
  try {
    desc.docKey = await docKey(tabId).catch(() => undefined);
    if (kind === 'ref') {
      const { result, target: t } = await refCall<any>(tabId, String(target.ref), { type: 'ba:describe' }, 5000);
      desc.element = result.info;
      if (t.frameId !== 0) desc.frameUrl = await frameUrl(t.frameId);
    } else if (kind === 'coordinate') {
      const p = await toCss(tabId, target.x, target.y);
      const r = await describeAt(tabId, p.x, p.y);
      if (r.info) desc.element = r.info;
      else desc.unknown = r.reason ?? 'nothing at that point';
      if (r.frameId) desc.frameUrl = await frameUrl(r.frameId);
    } else if (member === 'type' || member === 'key' || member === 'hold_key') {
      const f = await focusedField(tabId);
      if (f.description === 'an embedded frame') desc.unknown = 'keyboard focus is inside an embedded frame that could not be inspected';
      else if (!f.nothingFocused) {
        const { result } = await frameCall<any>(tabId, f.frameId, { type: 'ba:describe', focused: true }, 5000);
        if (result.info) desc.element = result.info;
        if (f.frameId !== 0) desc.frameUrl = await frameUrl(f.frameId);
      }
    } else if (target !== undefined && member !== 'scroll' && member !== 'scroll_to') {
      desc.unknown = 'unrecognised target';
    }
  } catch (e) {
    if (e instanceof StaleRefError) throw e;
    // Could not inspect the target: the policy asks the user instead of allowing.
    desc.unknown = truncate((e as Error).message.replace(/^Error: /, ''), 160);
  }
  return desc;
}

/** Describe the element at a top-level viewport point, descending into (cross-origin) frames. */
async function describeAt(tabId: number, x: number, y: number): Promise<{ info?: any; frameId?: number; reason?: string }> {
  let frameId = 0;
  let ox = 0;
  let oy = 0;
  const frames = await listFrames(tabId);
  for (let depth = 0; depth < 6; depth++) {
    const { result } = await frameCall<any>(tabId, frameId, { type: 'ba:describe', point: { x: x - ox, y: y - oy } }, 5000);
    if (!result.info) return { frameId, reason: 'nothing at that point' };
    if (!result.info.isIframe || result.iframeId === undefined) return { info: result.info, frameId };
    const map = await childFrameMap(tabId, frameId, frames);
    const child = map.get(result.iframeId);
    if (child === undefined) return { frameId, reason: 'the point is inside an embedded frame that could not be inspected' };
    const hit = await probeFrame(tabId, child, 1500);
    ox += hit.offset.x;
    oy += hit.offset.y;
    frameId = child;
  }
  return { frameId, reason: 'frames nested too deeply' };
}

export { imageScale };
