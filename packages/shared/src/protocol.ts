/**
 * Wire protocol between the agent server and the browser extension (WebSocket, JSON frames),
 * plus the event stream the extension's side panel renders.
 */
import type { BrowserMember } from './tools.ts';

export const PROTOCOL_VERSION = 2;

/** HMAC labels for the mutual handshake (see packages/server/src/pairing.ts). */
export const AUTH_SERVER_LABEL = 'ba-server:';
export const AUTH_CLIENT_LABEL = 'ba-client:';
export const AUTH_WHOAMI_LABEL = 'ba-whoami:';
/** Pairing derivations (ECDH shared secret -> paired secret, comparison code, confirmation). */
export const PAIR_SECRET_LABEL = 'ba-pair-secret|';
export const PAIR_CODE_LABEL = 'ba-pair-code|';
export const PAIR_CONFIRM_LABEL = 'ba-pair-confirm|';

// ---------------------------------------------------------------------------------------------
// Tool results produced by the executor (extension)
// ---------------------------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  mediaType: 'image/jpeg' | 'image/png';
  /** base64, no data: prefix */
  data: string;
  width?: number;
  height?: number;
}

export interface BrowserTab {
  tab_id: string;
  title: string;
  url: string;
  active?: boolean;
}

export type BrowserStateChange =
  | { type: 'tab_opened'; tab_id: string }
  | { type: 'download_started'; download_id: string; url: string }
  | { type: 'download_completed'; download_id: string; url: string; path?: string; size_bytes?: number }
  | { type: 'download_failed'; download_id: string; url: string; error?: string };

export interface BrowserStateBlock {
  type: 'browser_state';
  tabs: BrowserTab[];
  state_changes?: BrowserStateChange[];
}

export type ResultBlock = TextBlock | ImageBlock | BrowserStateBlock;

export interface ToolResult {
  isError: boolean;
  content: ResultBlock[];
  /** Tab the call ran on (for rendering the Tab Context footer for non-Anthropic providers). */
  executedOn?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Settings / policy
// ---------------------------------------------------------------------------------------------

export type PermissionMode = 'ask' | 'auto' | 'yolo';

/** Where people get the server and docs. */
export const PROJECT_URL = 'https://github.com/tmalik22/BrowserExtension';
export const SERVER_DOWNLOAD_URL = `${PROJECT_URL}/releases/latest`;

/** Kinds of action the user can choose to confirm before the agent does them. */
export type ConfirmCategory =
  | 'payments'
  | 'logins'
  | 'sensitiveFields'
  | 'messages'
  | 'deletions'
  | 'accountChanges'
  | 'agreements'
  | 'forms'
  | 'dialogs'
  | 'scriptsAndUploads'
  | 'uninspectable';

export type ConfirmSettings = Record<ConfirmCategory, boolean>;

/** Every confirmation category, in the order the settings UI shows them. */
export const CONFIRM_CATEGORIES: readonly { id: ConfirmCategory; label: string; hint: string }[] = [
  { id: 'payments', label: 'Purchases & payments', hint: 'Buy, checkout, place order, pay, subscribe, donate, transfer, book' },
  { id: 'logins', label: 'Logging in', hint: 'Submitting a form that contains a password' },
  { id: 'sensitiveFields', label: 'Passwords & card details', hint: 'Typing into password, card number or other sensitive fields' },
  { id: 'messages', label: 'Sending & posting', hint: 'Send, post, publish, reply, tweet' },
  { id: 'deletions', label: 'Deleting & cancelling', hint: 'Delete, remove, deactivate, unsubscribe, cancel a subscription' },
  { id: 'accountChanges', label: 'Account & security changes', hint: 'Change password or email, turn 2FA on/off, remove a card or device' },
  { id: 'agreements', label: 'Accepting terms & signing', hint: 'I agree, accept terms, consent checkboxes, sign a document' },
  { id: 'forms', label: 'Submitting forms', hint: 'Buttons labelled "Submit"' },
  { id: 'dialogs', label: 'Accepting page dialogs', hint: 'Answering "OK" to a page’s confirm() or prompt()' },
  { id: 'scriptsAndUploads', label: 'Running scripts & uploading files', hint: 'javascript_exec and file_upload (when those tools are enabled)' },
  { id: 'uninspectable', label: 'Actions on unknown targets', hint: 'When the agent can’t tell what a click or key press would hit' },
];

export const DEFAULT_CONFIRM: ConfirmSettings = {
  payments: true,
  logins: true,
  sensitiveFields: true,
  messages: true,
  deletions: true,
  accountChanges: true,
  agreements: true,
  forms: true,
  dialogs: true,
  scriptsAndUploads: true,
  uninspectable: true,
};

export interface PolicySettings {
  /**
   * ask  – ask before acting on a site for the first time, and before consequential actions.
   * auto – act on any site; still confirm consequential actions (purchases, sending, deleting...).
   * yolo – never ask. Only for sandboxed/test browsers.
   */
  permissionMode: PermissionMode;
  /** Hosts the user approved permanently ("example.com" also covers subdomains). */
  allowedSites: string[];
  /** Hosts the agent may never visit or act on. */
  blockedSites: string[];
  /** Allow localhost / private IP ranges (off by default, per Anthropic's guidance). */
  allowPrivateNetworks: boolean;
  enableOptional: {
    javascript_exec: boolean;
    file_upload: boolean;
    read_console: boolean;
    read_network: boolean;
  };
  /** Directory that file_upload may read from (server filesystem). */
  uploadDir?: string;
  maxSteps: number;
  /** Attach a screenshot to the last result of each batch for vision models. */
  autoScreenshot: boolean;
  /** Block physical user input in the agent's tab while it works (Comet-style). */
  lockUserInput: boolean;
  /** Which kinds of action need the user's confirmation (permission modes "ask" and "auto"). */
  confirm: ConfirmSettings;
  /** @deprecated Legacy master switch for risky clicks; migrated into `confirm` when loading settings. */
  confirmRiskyClicks?: boolean;
  /** Model profile that solves CAPTCHA / Cloudflare challenges for the main model. Off when unset. */
  captchaHelperProfileId?: string;
}

export const DEFAULT_SETTINGS: PolicySettings = {
  permissionMode: 'ask',
  allowedSites: [],
  blockedSites: [],
  allowPrivateNetworks: false,
  enableOptional: { javascript_exec: false, file_upload: false, read_console: false, read_network: false },
  maxSteps: 60,
  autoScreenshot: false,
  lockUserInput: false,
  confirm: { ...DEFAULT_CONFIRM },
};

export interface ProfileInfo {
  id: string;
  label: string;
  provider: string;
  model: string;
  vision: boolean;
  available: boolean;
  unavailableReason?: string;
}

/** A provider key the panel can set. The key itself never leaves the server. */
export interface ApiKeyInfo {
  /** Env-style name, e.g. NANOGPT_API_KEY. */
  name: string;
  label: string;
  set: boolean;
  /** Where the current key comes from: saved from the panel, or the .env file. */
  source?: 'panel' | 'env';
  /** Last 4 characters, to tell keys apart. */
  hint?: string;
  /** Labels of the model profiles that use this key. */
  usedBy: string[];
}

export interface ProfileTestResult {
  profileId: string;
  label: string;
  model: string;
  ok: boolean;
  /** Plain-language outcome. */
  message: string;
  seconds?: number;
  /** Model ids the provider offers that look like the one asked for (when it wasn't found). */
  suggestions?: string[];
}

export interface KeyTestResult {
  name: string;
  results: ProfileTestResult[];
}

// ---------------------------------------------------------------------------------------------
// Agent events (server -> extension -> side panel)
// ---------------------------------------------------------------------------------------------

export type ApprovalDecision = 'allow_once' | 'allow_site' | 'deny';

export type SessionStatus = 'idle' | 'running' | 'waiting_approval' | 'stopping';

export type AgentEvent =
  | { type: 'session_started'; profileId: string; title: string }
  | { type: 'user_message'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; callId: string; member: string; input: Record<string, unknown>; summary: string }
  | { type: 'tool_result'; callId: string; isError: boolean; text: string; image?: { mediaType: string; data: string } }
  | {
      type: 'approval_request';
      approvalId: string;
      kind: 'site' | 'consequential' | 'sensitive';
      site?: string;
      member: string;
      summary: string;
      reason: string;
    }
  | { type: 'approval_resolved'; approvalId: string; decision: ApprovalDecision }
  | { type: 'status'; status: SessionStatus; step: number; maxSteps: number }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      /** Size of the latest request (what must fit the context window) and the window, if known. */
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'turn_done'; reason: TurnEndReason; finalText: string };

export type TurnEndReason = 'end_turn' | 'max_steps' | 'stopped' | 'error' | 'refusal' | 'max_tokens';

/** One past or current chat, for the history list. */
export interface ChatInfo {
  sessionId: string;
  title: string;
  profileId?: string;
  startedAt: number;
  updatedAt: number;
  /** Messages the user sent. */
  messages: number;
  /** Start of the agent's last reply. */
  lastReply?: string;
  /** Still in the server's memory (can be continued directly). */
  live: boolean;
  running: boolean;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  profileId: string;
  status: SessionStatus;
  tabIds: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------------------------

/** Extension -> server */
export type ClientFrame =
  | {
      type: 'hello';
      clientId: string;
      protocol: number;
      extensionVersion: string;
      userAgent: string;
      /** Mutual handshake: the client's random nonce, and which secret it holds. */
      clientNonce?: string;
      keyType?: 'token' | 'paired';
      /**
       * No secret yet: start pairing. Commit-then-reveal: SHA-256 (hex) of our ECDH P-256 public
       * key (raw, base64); the key itself is only sent after the server has sent its own, so
       * neither side can grind keys to make the two codes match.
       */
      pairCommit?: string;
      /** Legacy/scripts: the raw pairing token (the extension never sends this). */
      token?: string;
    }
  | { type: 'auth'; proof: string }
  /** Reveals the committed public key, after the server's key arrived. */
  | { type: 'pair_reveal'; publicKey: string }
  /** Sent once the user confirmed in the side panel that both codes match. */
  | { type: 'pair_confirm'; proof: string }
  | { type: 'rpc_result'; id: string; result?: unknown; error?: string }
  | {
      type: 'send_message';
      requestId: string;
      sessionId?: string;
      text: string;
      profileId?: string;
      /** Chrome tab the task starts in (string tab_id). */
      tabId?: string;
      /** Start a new chat that carries on from this saved one (its summary is given to the model). */
      continueFrom?: string;
    }
  | { type: 'stop'; sessionId: string }
  | { type: 'approval_response'; approvalId: string; decision: ApprovalDecision }
  | { type: 'update_settings'; requestId: string; settings: Partial<PolicySettings> }
  | { type: 'get_state'; requestId: string }
  | { type: 'get_history'; requestId: string; sessionId: string }
  /** Past chats, newest first (live ones and ones saved on disk); responds with ChatInfo[]. */
  | { type: 'list_chats'; requestId: string; limit?: number }
  /** Save (or with an empty key, remove) a provider API key on the server. Never echoed back. */
  | { type: 'set_api_key'; requestId: string; name: string; key: string }
  /** Try every model that uses this key with one small request; responds with KeyTestResult. */
  | { type: 'test_api_key'; requestId: string; name: string }
  /** Change which model id a profile asks for (e.g. after a test suggested the right one). */
  | { type: 'set_profile_model'; requestId: string; profileId: string; model: string }
  | { type: 'pong'; t: number };

/** Server -> extension */
export type ServerFrame =
  | {
      type: 'hello_ok';
      serverVersion: string;
      protocol: number;
      profiles: ProfileInfo[];
      defaultProfileId: string;
      settings: PolicySettings;
    }
  | { type: 'hello_error'; message: string }
  /** The server's proof that it knows the secret, and its nonce for the client to answer. */
  | { type: 'challenge'; serverNonce: string; proof: string }
  /** The server's ECDH public key; both sides now show the same 6-digit code to compare. */
  | { type: 'pair_pending'; publicKey: string }
  | { type: 'rpc'; id: string; method: RpcMethod; params: Record<string, unknown> }
  | { type: 'agent_event'; sessionId: string; seq: number; event: AgentEvent }
  | { type: 'response'; requestId: string; ok: boolean; error?: string; data?: unknown }
  | { type: 'state'; sessions: SessionSummary[]; settings: PolicySettings; profiles: ProfileInfo[]; apiKeys?: ApiKeyInfo[] }
  | { type: 'gpu'; gpu: GpuStatus }
  | { type: 'ping'; t: number };

/**
 * RPC methods the server invokes on the extension.
 *  - session_begin: claim the start tab for a session (tab group, overlay).
 *  - execute:       run one browser member call.
 *  - describe:      describe what a member call would act on (for safety checks) without acting.
 *  - session_end:   release tabs/overlay.
 */
export type RpcMethod = 'session_begin' | 'execute' | 'describe' | 'session_end' | 'session_status' | 'captcha_probe' | 'captcha_observe' | 'captcha_action';

/** One image of the challenge region plus the geometry to map normalized points back. */
export interface CaptchaObservation {
  kind?: string;
  /** Grid geometry (normalized points are not used for grids; cell rects are CSS viewport px). */
  grid?: { rows: number; cols: number; cells: { x: number; y: number; w: number; h: number }[] };
  /** Challenge region in CSS viewport px, and the crop's own size in image px. */
  region: { x: number; y: number; w: number; h: number };
  shot: { data: string; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number };
  /** True when the region is a located challenge widget, not the whole-viewport fallback. */
  located?: boolean;
}

export type CaptchaActionPlan =
  | { action: 'click'; points: [number, number][] }
  | { action: 'drag'; drags: { from: [number, number] | []; to: [number, number] }[] }
  | { action: 'cells'; cells: number[] }
  | { action: 'type'; text: string };

/** What the extension sees on a tab that might be blocked by a CAPTCHA. */
export interface CaptchaProbe {
  challenge: boolean;
  /** The challenge widget already reports success (e.g. a checked Turnstile box). */
  solved?: boolean;
  kind?: 'cloudflare' | 'turnstile' | 'recaptcha' | 'hcaptcha' | 'unknown';
  detail?: string;
}

export interface ExecuteParams {
  sessionId: string;
  member: BrowserMember;
  input: Record<string, unknown>;
  /** Attach a screenshot to this result (auto observation). */
  attachScreenshot?: boolean;
  settings: Pick<PolicySettings, 'allowPrivateNetworks' | 'blockedSites' | 'enableOptional' | 'uploadDir' | 'lockUserInput'>;
  /** From describe: the action is only valid on this same document. */
  expectDocKey?: string;
}

export interface SessionBeginParams {
  sessionId: string;
  tabId?: string;
  title: string;
  lockUserInput: boolean;
}

export interface SessionBeginResult {
  activeTabId: string;
  tabs: BrowserTab[];
}

/** What a pending action would touch (used by the safety policy before running it). */
export interface ActionDescription {
  tabId: string;
  url: string;
  host: string;
  /** Description of the target element, if any. */
  element?: {
    role: string;
    name: string;
    tag: string;
    inputType?: string;
    autocomplete?: string;
    /** Name of the form's submit control, if the element is in a form. */
    formSubmitName?: string;
    formHasPassword?: boolean;
    sensitive?: boolean;
  };
  /** For navigate: the resolved target URL. */
  targetUrl?: string;
  /** URL of the frame that holds the target, when it is not the top-level document. */
  frameUrl?: string;
  /** A JS dialog currently blocks the page. */
  dialog?: { type: string; message: string };
  /** Set when the target could not be inspected (reason). The policy then asks. */
  unknown?: string;
  /** Document identity at describe time; execute fails if the page changed meanwhile. */
  docKey?: string;
}

// ---------------------------------------------------------------------------------------------
// GPU monitoring (server -> extension)
// ---------------------------------------------------------------------------------------------

export interface GpuSample {
  t: number;
  index: number;
  name: string;
  tempC: number | null;
  /** Memory-junction temperature; most GeForce cards don't report it. */
  memTempC: number | null;
  fanPct: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  utilPct: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
  smClockMHz: number | null;
  /** Why clocks are limited right now: power_cap, sw_thermal, hw_thermal, hw_slowdown, ... */
  reasons: string[];
  pstate: string;
}

export interface GpuHistoryPoint {
  t: number;
  tempC: number | null;
  powerW: number | null;
  utilPct: number | null;
  fanPct: number | null;
}

export interface GpuAlert {
  id: string;
  level: 'warn' | 'critical';
  message: string;
  since: number;
}

export interface GpuStatus {
  available: boolean;
  error?: string;
  sample?: GpuSample;
  /** Last ~5 minutes. */
  history: GpuHistoryPoint[];
  alerts: GpuAlert[];
  peaks: { tempC: number | null; powerW: number | null; fanPct: number | null; since: number };
}
