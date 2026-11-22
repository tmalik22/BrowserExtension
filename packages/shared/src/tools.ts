/**
 * Browser member tools.
 *
 * These mirror Anthropic's `browser_toolset_20260801` contract exactly (member names, input
 * shapes, result conventions), so Claude models get the toolset they were trained on, and every
 * other provider gets the same members as ordinary JSON-schema function tools. One executor (the
 * extension) serves all providers.
 */

export const BROWSER_MEMBERS = [
  // navigation & capture
  'navigate', 'screenshot', 'zoom',
  // pointer
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move', 'scroll', 'scroll_to',
  // keyboard & timing
  'type', 'key', 'hold_key', 'wait',
  // page reading
  'read_page', 'find', 'get_page_text',
  // forms & files
  'form_input', 'file_upload',
  // diagnostics & scripting
  'read_console', 'read_network', 'javascript_exec',
  // tabs
  'new_tab', 'list_tabs', 'switch_tab', 'close_tab',
] as const;

export type BrowserMember = (typeof BROWSER_MEMBERS)[number];

/** Members Anthropic disables by default because they widen the attack surface. */
export const OPTIONAL_MEMBERS: readonly BrowserMember[] = ['javascript_exec', 'file_upload', 'read_console', 'read_network'];

/** Tab-management members: a successful result is exactly one browser_state block. */
export const TAB_MEMBERS: readonly BrowserMember[] = ['new_tab', 'list_tabs', 'switch_tab', 'close_tab'];

/** Members that only observe; they never change page state. */
export const READ_ONLY_MEMBERS: readonly BrowserMember[] = [
  'screenshot', 'zoom', 'read_page', 'find', 'get_page_text', 'read_console', 'read_network', 'list_tabs', 'wait',
];

/** A small subset for weak/local models with limited context or tool-calling skill. */
export const COMPACT_MEMBERS: readonly BrowserMember[] = [
  'navigate', 'screenshot', 'read_page', 'find', 'get_page_text', 'left_click', 'type', 'key',
  'scroll', 'scroll_to', 'form_input', 'wait', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab',
];

/** Members that need a vision-capable model to be useful. */
export const VISION_MEMBERS: readonly BrowserMember[] = ['screenshot', 'zoom'];

export const HALT_TEXT = 'Not executed: an earlier action in this turn failed.';

export function isBrowserMember(name: string): name is BrowserMember {
  return (BROWSER_MEMBERS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------------------------
// JSON schemas (used for non-Anthropic providers; Anthropic receives the native toolset entry).
// Kept deliberately flat (no oneOf) because many OpenAI-compatible/local servers reject unions.
// ---------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const tabId: JsonSchema = { type: 'string', description: 'Tab to act on. Defaults to the active tab.' };
const modifiers: JsonSchema = {
  type: 'string',
  description: 'Optional key chord held during the click, e.g. "shift" or "ctrl+shift".',
};
const target: JsonSchema = {
  type: 'object',
  description:
    'Either {"type":"ref","ref":"ref_12"} (an element reference from read_page/find) or {"type":"coordinate","x":100,"y":200} (viewport pixels of the latest screenshot).',
  properties: {
    type: { type: 'string', enum: ['ref', 'coordinate'] },
    ref: { type: 'string', description: 'Element reference such as "ref_12" (when type is "ref").' },
    x: { type: 'integer', description: 'Viewport x pixel (when type is "coordinate").' },
    y: { type: 'integer', description: 'Viewport y pixel (when type is "coordinate").' },
  },
  required: ['type'],
};
const coordTarget: JsonSchema = {
  type: 'object',
  description: 'A viewport coordinate: {"type":"coordinate","x":100,"y":200}.',
  properties: {
    type: { type: 'string', enum: ['coordinate'] },
    x: { type: 'integer' },
    y: { type: 'integer' },
  },
  required: ['type', 'x', 'y'],
};
const refTarget: JsonSchema = {
  type: 'object',
  description: 'An element reference: {"type":"ref","ref":"ref_12"}.',
  properties: { type: { type: 'string', enum: ['ref'] }, ref: { type: 'string' } },
  required: ['type', 'ref'],
};

function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export interface MemberSpec {
  name: BrowserMember;
  description: string;
  parameters: JsonSchema;
}

const click = (what: string): Omit<MemberSpec, 'name'> => ({
  description: `${what} a viewport coordinate or a referenced element. Prefer refs from read_page/find when available.`,
  parameters: obj({ target, modifiers, tab_id: tabId }, ['target']),
});

export const MEMBER_SPECS: Record<BrowserMember, Omit<MemberSpec, 'name'>> = {
  navigate: {
    description:
      'Load an http(s) URL in the tab, or move through history with "back", "forward" or "reload". A URL without a scheme is treated as https://.',
    parameters: obj({ url: { type: 'string' }, tab_id: tabId }, ['url']),
  },
  screenshot: {
    description: 'Capture the visible viewport as an image. Coordinates you use later are pixels in this image.',
    parameters: obj({ tab_id: tabId }),
  },
  zoom: {
    description:
      'Return a cropped, upscaled image of region [x0, y0, x1, y1] (viewport pixels) to inspect small text or controls. Coordinates stay in full-viewport pixels.',
    parameters: obj(
      { region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 }, tab_id: tabId },
      ['region'],
    ),
  },
  left_click: click('Left-click'),
  right_click: click('Right-click'),
  middle_click: click('Middle-click'),
  double_click: click('Double-click'),
  triple_click: click('Triple-click (selects a line/paragraph)'),
  hover: {
    description: 'Move the pointer over a coordinate or referenced element without clicking.',
    parameters: obj({ target, tab_id: tabId }, ['target']),
  },
  left_click_drag: {
    description: 'Press at `from`, drag to `target`, and release.',
    parameters: obj({ from: coordTarget, target: coordTarget, tab_id: tabId }, ['from', 'target']),
  },
  left_mouse_down: {
    description: 'Press and hold the left button at a coordinate.',
    parameters: obj({ target: coordTarget, tab_id: tabId }, ['target']),
  },
  left_mouse_up: {
    description: 'Release the left button at a coordinate.',
    parameters: obj({ target: coordTarget, tab_id: tabId }, ['target']),
  },
  mouse_move: {
    description: 'Move the pointer to a coordinate.',
    parameters: obj({ target: coordTarget, tab_id: tabId }, ['target']),
  },
  scroll: {
    description: 'Scroll with the mouse wheel at a viewport position. scroll_amount is wheel notches (1-10, default 3).',
    parameters: obj(
      {
        target: coordTarget,
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer', minimum: 1, maximum: 10 },
        tab_id: tabId,
      },
      ['target', 'scroll_direction'],
    ),
  },
  scroll_to: {
    description: 'Scroll a referenced element into view.',
    parameters: obj({ target: refTarget, tab_id: tabId }, ['target']),
  },
  type: {
    description: 'Type a literal string at the current focus (click/focus the field first).',
    parameters: obj({ text: { type: 'string' }, tab_id: tabId }, ['text']),
  },
  key: {
    description:
      'Press a key or chord: a single key ("Enter"), a chord joined with + ("ctrl+a"), or a space-separated sequence ("Backspace Backspace"). repeat is 1-100.',
    parameters: obj(
      { text: { type: 'string' }, repeat: { type: 'integer', minimum: 1, maximum: 100 }, tab_id: tabId },
      ['text'],
    ),
  },
  hold_key: {
    description: 'Hold a key or chord for `duration` seconds (0-30).',
    parameters: obj({ text: { type: 'string' }, duration: { type: 'number' }, tab_id: tabId }, ['text', 'duration']),
  },
  wait: {
    description: 'Pause for `duration` seconds (0-30), e.g. while a page loads.',
    parameters: obj({ duration: { type: 'number' }, tab_id: tabId }, ['duration']),
  },
  read_page: {
    description:
      'Return the accessibility tree as text; each element is tagged with a reference like [ref_2]. filter omitted: visible elements; "interactive": visible interactive elements only; "all": also off-screen elements. depth caps tree depth (default 15). ref scopes to a subtree. Read the tree before taking screenshots.',
    parameters: obj(
      {
        filter: { type: 'string', enum: ['interactive', 'all'] },
        depth: { type: 'integer', minimum: 1 },
        ref: { type: 'string' },
        tab_id: tabId,
      },
    ),
  },
  find: {
    description:
      'Find elements matching a natural-language description such as "search field" or "add to cart button". Returns up to 20 matches tagged like read_page.',
    parameters: obj({ query: { type: 'string' }, tab_id: tabId }, ['query']),
  },
  get_page_text: {
    description: 'Return the page\'s visible text, prioritizing main article content. Best for reading articles and docs.',
    parameters: obj({ tab_id: tabId }),
  },
  form_input: {
    description:
      'Set a form element\'s value directly. Use a boolean for checkboxes/radios and an option\'s value or visible text for selects.',
    parameters: obj(
      { target: refTarget, value: { type: ['string', 'number', 'boolean'] }, tab_id: tabId },
      ['target', 'value'],
    ),
  },
  file_upload: {
    description: 'Set the files on a file-input element from allowlisted paths.',
    parameters: obj(
      {
        target: refTarget,
        paths: { type: 'array', items: { type: 'string' } },
        document_ids: { type: 'array', items: { type: 'string' } },
        tab_id: tabId,
      },
      ['target'],
    ),
  },
  read_console: {
    description: 'Return console entries (log/warning/error) since the last read.',
    parameters: obj({ tab_id: tabId }),
  },
  read_network: {
    description: 'Return network requests (method, URL, status, type, timing) since the last read.',
    parameters: obj({ tab_id: tabId }),
  },
  javascript_exec: {
    description: 'Run JavaScript in the page and return the value of the last expression as text (write an expression, not a return statement).',
    parameters: obj({ text: { type: 'string' }, tab_id: tabId }, ['text']),
  },
  new_tab: { description: 'Open a new tab and make it the active tab.', parameters: obj({}) },
  list_tabs: { description: 'List the open tabs.', parameters: obj({}) },
  switch_tab: { description: 'Make tab_id the active tab.', parameters: obj({ tab_id: { type: 'string' } }, ['tab_id']) },
  close_tab: { description: 'Close tab_id.', parameters: obj({ tab_id: { type: 'string' } }, ['tab_id']) },
};

export interface MemberSelection {
  /** "full": every enabled member; "compact": a small set for weak models. */
  toolSet?: 'full' | 'compact';
  vision?: boolean;
  enableOptional?: Partial<Record<'javascript_exec' | 'file_upload' | 'read_console' | 'read_network', boolean>>;
  disabled?: BrowserMember[];
}

/** The members a session offers to the model, after config. */
export function selectMembers(sel: MemberSelection = {}): BrowserMember[] {
  const base: readonly BrowserMember[] = sel.toolSet === 'compact' ? COMPACT_MEMBERS : BROWSER_MEMBERS;
  return base.filter((m) => {
    if (OPTIONAL_MEMBERS.includes(m) && !sel.enableOptional?.[m as keyof NonNullable<MemberSelection['enableOptional']>]) return false;
    if (sel.vision === false && VISION_MEMBERS.includes(m)) return false;
    if (sel.disabled?.includes(m)) return false;
    return true;
  });
}

export function memberSpecs(members: BrowserMember[]): MemberSpec[] {
  return members.map((name) => ({ name, ...MEMBER_SPECS[name] }));
}
