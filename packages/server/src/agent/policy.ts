/**
 * Safety policy. Runs on the server before every member call, independent of the model:
 *  - URL policy (http/https only, blocked sites, private networks)
 *  - per-site permission (permissionMode "ask")
 *  - human confirmation for consequential actions (purchases, logins, sending, deleting...) and
 *    for typing into sensitive fields (passwords, card numbers), per category the user enabled
 *  - optional members (javascript_exec, file_upload...) gated by settings
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  READ_ONLY_MEMBERS,
  TAB_MEMBERS,
  checkUrlPolicy,
  hostMatches,
  parseNavigateUrl,
  siteKey,
  type ActionDescription,
  CONFIRM_CATEGORIES,
  DEFAULT_CONFIRM,
  type BrowserMember,
  type ConfirmCategory,
  type ConfirmSettings,
  type PolicySettings,
} from '@ba/shared';

export type PolicyVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; message: string }
  | { kind: 'ask'; approvalKind: 'site' | 'consequential' | 'sensitive'; site?: string; reason: string; summary: string; category?: ConfirmCategory };

/**
 * Words that mark a control's label as a consequential action, per confirmation category.
 * A label can match several categories ("Delete card"); it needs confirmation if any matching
 * category is switched on.
 */
const CATEGORY_WORDS: [ConfirmCategory, RegExp][] = [
  ['payments', /\b(buy|purchase|pay|payment|checkout|check out|place (?:your )?order|order now|complete order|confirm (?:order|purchase|payment|booking)|subscribe|donate|transfer|send money|wire|book now|reserve|withdraw|sell|trade)\b/i],
  ['messages', /\b(send|post|publish|tweet|reply)\b/i],
  ['deletions', /\b(delete|remove account|close account|deactivate|unsubscribe|cancel (?:subscription|order|membership))\b/i],
  ['accountChanges', /\b((?:change|reset|update) (?:your )?(?:password|email|e-mail|phone(?: number)?|username)|(?:enable|disable|turn (?:on|off)) (?:2fa|two[- ]factor)|remove (?:payment method|card|device))\b/i],
  ['agreements', /\b(accept (?:terms|agreement)|i agree|agree (?:and|&) continue|sign (?:contract|document))\b/i],
  ['forms', /\b(submit)\b/i],
];

/** The first enabled category whose words match the start of a control's label. */
export function categorize(label: string, confirm: ConfirmSettings): ConfirmCategory | undefined {
  // Only the start of a label is the control's action; long accessible names often carry a
  // description ("Match ... matches every invoice to payment records") that isn't the action.
  const head = label.slice(0, 40);
  return CATEGORY_WORDS.find(([id, re]) => confirm[id] && re.test(head))?.[0];
}

const LABEL = Object.fromEntries(CONFIRM_CATEGORIES.map((c) => [c.id, c.label])) as Record<ConfirmCategory, string>;

export interface PolicyState {
  /** Sites approved for this session only ("allow once" grants the site for the session). */
  sessionSites: Set<string>;
}

const POINTER_MEMBERS: BrowserMember[] = [
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_mouse_up', 'left_mouse_down', 'left_click_drag',
];

/** Members that change the page and therefore need a known target to be judged safely. */
const ACTING_MEMBERS: BrowserMember[] = [...POINTER_MEMBERS, 'type', 'key', 'hold_key', 'form_input', 'file_upload', 'javascript_exec'];

const ENTER_KEYS = new Set(['enter', 'return', 'kp_enter', 'numpadenter']);
const SPACE_KEYS = new Set(['space', ' ', 'spacebar']);

/** Last key of each chord in a key spec ("ctrl+Enter Tab" -> ["enter", "tab"]). */
function keysOf(spec: unknown): string[] {
  return String(spec ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((ch) => ch.split('+').pop()!.toLowerCase());
}

/** Does this call press Enter / Space (which submit forms and activate focused controls)? */
export function activationKeys(member: string, input: Record<string, unknown>): { enter: boolean; space: boolean } {
  if (member === 'key' || member === 'hold_key') {
    const keys = String(input.text ?? '') === ' ' ? ['space'] : keysOf(input.text);
    return { enter: keys.some((k) => ENTER_KEYS.has(k)), space: keys.some((k) => SPACE_KEYS.has(k)) };
  }
  if (member === 'type') {
    const t = String(input.text ?? '');
    return { enter: /[\r\n]/.test(t), space: t.includes(' ') };
  }
  return { enter: false, space: false };
}

export function needsDescription(member: string): boolean {
  return !READ_ONLY_MEMBERS.includes(member as BrowserMember) && !TAB_MEMBERS.includes(member as BrowserMember);
}

function siteAllowed(host: string, settings: PolicySettings, state: PolicyState): boolean {
  const key = siteKey(host);
  if (state.sessionSites.has(key)) return true;
  return settings.allowedSites.some((s) => hostMatches(host, s));
}

export function checkUploadPaths(paths: unknown, uploadDir: string | undefined): string | null {
  if (!Array.isArray(paths) || !paths.length) return 'Error: file_upload needs at least one path (document_ids are not supported by this executor).';
  if (!uploadDir) return 'Error: file_upload has no upload directory configured.';
  let root: string;
  try {
    root = fs.realpathSync(uploadDir);
  } catch {
    return `Error: the upload directory ${uploadDir} does not exist.`;
  }
  for (const p of paths) {
    if (typeof p !== 'string') return 'Error: file paths must be strings.';
    const abs = path.resolve(root, p);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return `Error: ${p} does not exist in the upload directory.`;
    }
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return `Error: ${p} is outside the allowed upload directory.`;
    if (!fs.statSync(real).isFile()) return `Error: ${p} is not a file.`;
  }
  return null;
}

/**
 * Decide what to do with one member call. `desc` describes the target (from the extension's
 * describe RPC) when the member acts on the page.
 */
export function evaluate(
  member: string,
  input: Record<string, unknown>,
  desc: ActionDescription | undefined,
  settings: PolicySettings,
  state: PolicyState,
): PolicyVerdict {
  const confirm = settings.confirm ?? DEFAULT_CONFIRM;
  // Optional members are gated by settings even if the model names them.
  if (member === 'javascript_exec' && !settings.enableOptional.javascript_exec) return { kind: 'deny', message: 'Error: javascript_exec is not enabled in this environment.' };
  if (member === 'file_upload' && !settings.enableOptional.file_upload) return { kind: 'deny', message: 'Error: file_upload is not enabled in this environment.' };
  if (member === 'read_console' && !settings.enableOptional.read_console) return { kind: 'deny', message: 'Error: read_console is not enabled in this environment.' };
  if (member === 'read_network' && !settings.enableOptional.read_network) return { kind: 'deny', message: 'Error: read_network is not enabled in this environment.' };

  const urlPolicy = { allowPrivateNetworks: settings.allowPrivateNetworks, blockedSites: settings.blockedSites };

  if (member === 'navigate') {
    const t = parseNavigateUrl(input.url);
    if (t.kind === 'error') return { kind: 'deny', message: t.message };
    if (t.kind === 'url') {
      const err = checkUrlPolicy(t.url, urlPolicy);
      if (err) return { kind: 'deny', message: err };
      const host = new URL(t.url).hostname;
      if (settings.permissionMode === 'ask' && !siteAllowed(host, settings, state)) {
        return { kind: 'ask', approvalKind: 'site', site: siteKey(host), reason: `The agent wants to open ${host}.`, summary: `Open ${t.url}` };
      }
    }
    return { kind: 'allow' };
  }

  if (member === 'file_upload') {
    const err = checkUploadPaths(input.paths, settings.uploadDir);
    if (err) return { kind: 'deny', message: err };
  }

  if (!needsDescription(member)) return { kind: 'allow' };
  if (!desc) {
    // Acting members must be described; without one we can't judge the action (fail closed).
    if (settings.permissionMode === 'yolo' || !confirm.uninspectable || !ACTING_MEMBERS.includes(member as BrowserMember)) return { kind: 'allow' };
    return { kind: 'ask', approvalKind: 'consequential', category: 'uninspectable', reason: 'The target of this action could not be inspected.', summary: member.replace(/_/g, ' ') };
  }

  // Acting on the current page (and any frame the target is in).
  for (const u of [desc.url, desc.frameUrl]) {
    if (u && /^https?:/.test(u)) {
      const err = checkUrlPolicy(u, urlPolicy);
      if (err) return { kind: 'deny', message: err.replace('Navigation refused.', 'Action refused.') };
    }
  }
  if (settings.permissionMode === 'yolo') return { kind: 'allow' };

  if (settings.permissionMode === 'ask' && desc.host && !siteAllowed(desc.host, settings, state)) {
    return {
      kind: 'ask',
      approvalKind: 'site',
      site: siteKey(desc.host),
      reason: `The agent wants to interact with ${desc.host}.`,
      summary: `${member.replace(/_/g, ' ')} on ${desc.host}`,
    };
  }

  if ((member === 'javascript_exec' || member === 'file_upload') && confirm.scriptsAndUploads) {
    return {
      kind: 'ask',
      approvalKind: 'consequential',
      category: 'scriptsAndUploads',
      site: desc.host,
      reason: member === 'javascript_exec' ? 'Run JavaScript in the page with full page privileges.' : 'Upload files from your computer to this site.',
      summary: member === 'javascript_exec' ? `Run: ${String(input.text).slice(0, 300)}` : `Upload ${(input.paths as string[]).join(', ')}`,
    };
  }

  const act = activationKeys(member, input);

  // Answering a page's confirm()/prompt() dialog is the page asking for consent.
  if (confirm.dialogs && desc.dialog && desc.dialog.type !== 'alert' && (member === 'key' || member === 'hold_key') && act.enter) {
    return {
      kind: 'ask',
      approvalKind: 'consequential',
      category: 'dialogs',
      site: desc.host,
      reason: `Accept the page's ${desc.dialog.type} dialog: "${desc.dialog.message.slice(0, 160)}"`,
      summary: `Press Enter on the ${desc.dialog.type} dialog`,
    };
  }
  if (desc.dialog) return { kind: 'allow' }; // Escape / typing into a prompt

  if (confirm.uninspectable && desc.unknown && ACTING_MEMBERS.includes(member as BrowserMember)) {
    return {
      kind: 'ask',
      approvalKind: 'consequential',
      category: 'uninspectable',
      site: desc.host,
      reason: `The agent wants to ${member.replace(/_/g, ' ')} on ${desc.host || 'this page'}, but the target could not be inspected (${desc.unknown}).`,
      summary: member.replace(/_/g, ' '),
    };
  }

  const el = desc.element;
  // Typing / setting values into sensitive fields.
  if ((member === 'type' || member === 'form_input') && el?.sensitive && confirm.sensitiveFields) {
    return {
      kind: 'ask',
      approvalKind: 'sensitive',
      category: 'sensitiveFields',
      site: desc.host,
      reason: `Enter data into a sensitive field (${el.name || el.inputType || el.role}).`,
      summary: member === 'type' ? `Type into "${el.name || el.role}"` : `Set "${el.name || el.role}"`,
    };
  }

  // Clicking, or activating with Enter/Space, consequential controls.
  if (!el) return { kind: 'allow' };
  const pointer = POINTER_MEMBERS.includes(member as BrowserMember);
  const controlLike = el.role === 'button' || el.role === 'link' || el.role === 'menuitem' || el.role === 'clickable' || el.inputType === 'submit' || el.tag === 'button';
  const labels: string[] = [];
  if (pointer && controlLike) labels.push(el.name);
  // Enter or Space on a focused control activates it; Enter in a form submits the form.
  if ((act.enter || act.space) && controlLike) labels.push(el.name);
  if (act.enter && el.formSubmitName) labels.push(el.formSubmitName);
  if ((member === 'form_input' || ((pointer || act.space) && el.role === 'checkbox')) && /(agree|accept|terms|consent)/i.test(el.name)) labels.push(el.name);
  let hit: string | undefined;
  let category: ConfirmCategory | undefined;
  for (const l of labels) {
    category = l ? categorize(l, confirm) : undefined;
    if (category) {
      hit = l;
      break;
    }
  }
  if (hit && category) {
    const viaKey = !pointer && member !== 'form_input';
    return {
      kind: 'ask',
      approvalKind: 'consequential',
      category,
      site: desc.host,
      reason: `${LABEL[category]}: this may be a consequential action ("${hit.slice(0, 80)}").`,
      summary: viaKey ? `Press ${act.enter ? 'Enter' : 'Space'} to activate "${hit.slice(0, 80)}"` : `${member.replace(/_/g, ' ')} "${hit.slice(0, 80)}"`,
    };
  }
  const loginLabel = pointer ? el.name : (el.formSubmitName ?? '');
  const clickSubmit = pointer && (el.inputType === 'submit' || el.role === 'button') && /(sign in|log in|login|continue|next|submit)/i.test(loginLabel);
  if (confirm.logins && el.formHasPassword && (clickSubmit || act.enter)) {
    return { kind: 'ask', approvalKind: 'sensitive', category: 'logins', site: desc.host, reason: 'Submit a login form.', summary: pointer ? `Click "${loginLabel.slice(0, 80)}"` : 'Press Enter to submit the login form' };
  }
  return { kind: 'allow' };
}
