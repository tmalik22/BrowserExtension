/**
 * WebSocket connection to the agent server: mutual authentication, pairing, reconnect with
 * backoff, heartbeat, RPC dispatch, and request/response for side-panel actions.
 *
 * Handshake: we send a random nonce; the server must answer with HMAC(secret, "ba-server:"+nonce)
 * before we reveal anything or obey any command, so a program squatting on the server's port
 * can't drive the browser. The secret (pasted token or paired secret) never goes over the wire.
 */
import { AUTH_CLIENT_LABEL, AUTH_SERVER_LABEL, PAIR_CODE_LABEL, PAIR_CONFIRM_LABEL, PAIR_SECRET_LABEL, PROTOCOL_VERSION, newId, type ClientFrame, type ServerFrame } from '@ba/shared';

export type ConnState = 'unconfigured' | 'connecting' | 'pairing' | 'connected' | 'disconnected' | 'error';

export interface BridgeConfig {
  serverUrl: string;
  /** Shared secret: the server's pairing token, or the per-browser secret issued by pairing. */
  token: string;
  keyType: 'token' | 'paired';
}

const enc = new TextEncoder();

async function hmacBytes(key: string | Uint8Array<ArrayBuffer>, msg: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmacHex(key: string, msg: string): Promise<string> {
  return hex(await hmacBytes(key, msg));
}

/** One pairing attempt: our ECDH key pair, then what both sides derive from the exchange. */
interface Pairing {
  keys: CryptoKeyPair;
  pub: string;
  /** SHA-256 (hex) of pub, sent first (commit-then-reveal). */
  commit: string;
  secret?: string;
  code?: string;
  confirm?: string;
  userConfirmed?: boolean;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two hex strings. */
function sameHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const DEFAULT_SERVER_URL = 'ws://127.0.0.1:7878/ws';

type RpcHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class Bridge {
  private ws: WebSocket | null = null;
  state: ConnState = 'disconnected';
  lastError = '';
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Map<string, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  hello: Extract<ServerFrame, { type: 'hello_ok' }> | null = null;
  lastState: Extract<ServerFrame, { type: 'state' }> | null = null;
  private config: BridgeConfig | null = null;
  private clientId = '';
  private manualClose = false;
  /** Per-connection handshake state. */
  private clientNonce = '';
  private serverVerified = false;
  /** Code shown to the user while a pairing request waits in the server window. */
  pairCode = '';
  /** True once the user confirmed in the side panel that both codes match. */
  pairConfirmed = false;
  private pairing: Pairing | null = null;
  private inbox: Promise<void> = Promise.resolve();
  private loading: Promise<BridgeConfig> | null = null;

  constructor(
    private onRpc: RpcHandler,
    private onFrame: (f: ServerFrame) => void,
    private onConnChange: () => void,
  ) {}

  /**
   * Load settings from storage once (concurrent callers share the same load), and never
   * overwrite settings that setConfig() saved while the load was in flight.
   */
  loadConfig(): Promise<BridgeConfig> {
    this.loading ??= (async () => {
      const st = (await chrome.storage.local.get(['serverUrl', 'token', 'keyType', 'clientId'])) as {
        serverUrl?: string;
        token?: string;
        keyType?: 'token' | 'paired';
        clientId?: string;
      };
      let clientId = st.clientId;
      if (!clientId) {
        clientId = newId('c');
        await chrome.storage.local.set({ clientId });
      }
      this.clientId = clientId;
      this.config ??= { serverUrl: st.serverUrl || DEFAULT_SERVER_URL, token: st.token || '', keyType: st.keyType === 'paired' ? 'paired' : 'token' };
      return this.config;
    })();
    return this.loading;
  }

  /** User clicked "Pair this browser": start a key exchange with the server. */
  async startPairing(): Promise<void> {
    await this.loadConfig();
    const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
    const pub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    const commit = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(pub))));
    this.disconnect();
    this.pairing = { keys, pub, commit };
    this.backoff = 1000;
    await this.connect();
  }

  /** User confirmed in the side panel that the server window shows the same code. */
  confirmPairing(): void {
    const p = this.pairing;
    if (!p?.confirm || !this.ws || this.state !== 'pairing') return;
    p.userConfirmed = true;
    this.pairConfirmed = true;
    this.serverVerified = true;
    this.ws.send(JSON.stringify({ type: 'pair_confirm', proof: p.confirm } satisfies ClientFrame));
    this.onConnChange();
  }

  cancelPairing(): void {
    this.pairing = null;
    this.pairCode = '';
    this.disconnect();
    this.setState('unconfigured', '');
  }

  getConfig(): BridgeConfig | null {
    return this.config;
  }

  async setConfig(c: Partial<BridgeConfig>): Promise<void> {
    await this.loadConfig(); // finish (or share) the initial load first so it can't overwrite us
    const cur = this.config!;
    // A token typed into Settings is the server's pairing token; pairing stores its own secret.
    const token = (c.token ?? cur.token).trim();
    const keyType = c.keyType ?? (c.token !== undefined ? 'token' : cur.keyType);
    this.config = { serverUrl: (c.serverUrl ?? cur.serverUrl).trim() || DEFAULT_SERVER_URL, token, keyType };
    await chrome.storage.local.set({ serverUrl: this.config.serverUrl, token: this.config.token, keyType: this.config.keyType });
    this.disconnect();
    this.backoff = 1000;
    void this.connect();
  }

  private setState(s: ConnState, error = ''): void {
    this.state = s;
    this.lastError = error;
    this.onConnChange();
  }

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    await this.loadConfig();
    // Another connect() may have started while we waited: don't open a second socket.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const cfg = this.config!;
    // No secret and no pairing started: wait for the user to click "Pair this browser".
    if (!cfg.token && !this.pairing) {
      this.setState('unconfigured', '');
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.manualClose = false;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(cfg.serverUrl);
    } catch (e) {
      this.setState('error', `Invalid server URL: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    this.serverVerified = false;
    this.clientNonce = '';
    this.pairCode = '';
    this.pairConfirmed = false;
    const pairing = this.pairing;
    ws.onopen = () => {
      const base = { type: 'hello' as const, clientId: this.clientId, protocol: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent };
      let hello: ClientFrame;
      if (pairing) {
        hello = { ...base, pairCommit: pairing.commit };
      } else {
        this.clientNonce = randomHex(32);
        hello = { ...base, clientNonce: this.clientNonce, keyType: cfg.keyType };
      }
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      let f: ServerFrame;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // Strictly in order: the handshake steps are async (HMAC, storage) and must not interleave.
      this.inbox = this.inbox.then(() => this.handle(f, ws)).catch(() => {});
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Disconnected from the agent server.'));
      }
      this.pending.clear();
      const wasPairing = !!this.pairing;
      this.pairing = null;
      this.pairCode = '';
      if (wasPairing && !this.config?.token) {
        // A pairing attempt ended without success: never retry on our own.
        this.setState(
          'unconfigured',
          ev.code === 4003 ? this.lastError : ev.code === 4001 ? 'Pairing timed out. Start it again.' : `Cannot reach ${cfg.serverUrl}. Is the server running?`,
        );
        return;
      }
      if (ev.code === 4003) {
        // Rejected: wrong token, not paired any more, or pairing declined. Don't retry on our own
        // (that would keep asking in the server window).
        if (cfg.token) this.setState('error', this.lastError || 'The server rejected this browser’s credentials.');
        else this.setState('unconfigured', this.lastError || 'Pair this browser with the server, or paste its pairing token in Settings.');
        return;
      }
      if (ev.code === 4006) return; // we refused the server (state already set)
      if (ev.code === 4004) {
        this.setState('error', this.lastError || 'Protocol mismatch between extension and server.');
        return;
      }
      if (this.manualClose) return;
      this.setState('disconnected', this.state === 'connecting' ? `Cannot reach ${cfg.serverUrl}. Is the agent server running?` : 'Connection lost; reconnecting…');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  disconnect(): void {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.hello = null;
    this.setState('disconnected');
  }

  send(f: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'connected') return false;
    this.ws.send(JSON.stringify(f));
    return true;
  }

  /** Send a frame that carries a requestId and wait for the server's response frame. */
  request<T = unknown>(f: ClientFrame & { requestId: string }, timeoutMs = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.send(f)) {
        reject(new Error(this.state === 'connected' ? 'Not connected' : this.lastError || 'Not connected to the agent server.'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(f.requestId);
        reject(new Error('The agent server did not respond.'));
      }, timeoutMs);
      this.pending.set(f.requestId, { resolve, reject, timer });
    });
  }

  /** Until the server has proven itself, only handshake frames are looked at; commands are ignored. */
  private async handshake(f: ServerFrame, ws: WebSocket): Promise<void> {
    const cfg = this.config!;
    const refuse = (message: string) => {
      this.setState('error', message);
      ws.close(4006, 'server not verified');
    };
    switch (f.type) {
      case 'challenge': {
        if (!this.clientNonce || this.serverVerified) return refuse('Unexpected handshake from the server.');
        const expected = await hmacHex(cfg.token, AUTH_SERVER_LABEL + this.clientNonce);
        if (!sameHex(String(f.proof), expected)) {
          return refuse(
            cfg.keyType === 'paired'
              ? `The server at ${cfg.serverUrl} doesn't recognise this browser (or isn't your Browser Agent server). Pair again from Settings.`
              : `The pairing token doesn't match the server at ${cfg.serverUrl} (or it isn't your Browser Agent server). Check the token in Settings.`,
          );
        }
        this.serverVerified = true;
        ws.send(JSON.stringify({ type: 'auth', proof: await hmacHex(cfg.token, AUTH_CLIENT_LABEL + String(f.serverNonce)) } satisfies ClientFrame));
        return;
      }
      case 'pair_pending': {
        const p = this.pairing;
        if (!p || p.code || typeof f.publicKey !== 'string') return refuse('Unexpected pairing message from the server.');
        let shared: Uint8Array<ArrayBuffer>;
        try {
          const raw = Uint8Array.from(atob(f.publicKey), (c) => c.charCodeAt(0));
          const peer = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
          shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, p.keys.privateKey, 256));
        } catch {
          return refuse('The server sent an invalid pairing key.');
        }
        const transcript = `${p.pub}|${f.publicKey}`;
        p.secret = b64url(await hmacBytes(shared, PAIR_SECRET_LABEL + transcript));
        const c = await hmacBytes(shared, PAIR_CODE_LABEL + transcript);
        p.code = String(new DataView(c.buffer).getUint32(0) % 1_000_000).padStart(6, '0');
        p.confirm = await hmacHex(p.secret, PAIR_CONFIRM_LABEL + transcript);
        // Only now reveal our key: the server's key was fixed before it could see ours.
        ws.send(JSON.stringify({ type: 'pair_reveal', publicKey: p.pub } satisfies ClientFrame));
        this.pairCode = p.code;
        this.setState('pairing', '');
        return;
      }
      case 'hello_ok':
        // Only after the server proved it knows the secret, or the user confirmed matching
        // pairing codes (which a program squatting on the port can't show in a server window).
        if (!this.serverVerified) return refuse('The server skipped authentication. It may not be your Browser Agent server.');
        if (this.pairing?.secret && this.pairing.userConfirmed) {
          const secret = this.pairing.secret;
          this.config = { ...cfg, token: secret, keyType: 'paired' };
          await chrome.storage.local.set({ token: secret, keyType: 'paired' });
          this.pairing = null;
          this.pairCode = '';
        }
        this.hello = f;
        this.backoff = 1000;
        this.setState('connected');
        return;
      case 'hello_error':
        this.lastError = f.message;
        this.setState(this.config?.token ? 'error' : 'unconfigured', f.message);
        return;
      default:
        return; // ignore everything else (including rpc) until authenticated
    }
  }

  private async handle(f: ServerFrame, ws: WebSocket): Promise<void> {
    if (this.ws !== ws) return;
    if (this.state !== 'connected') return this.handshake(f, ws);
    switch (f.type) {
      case 'hello_ok':
      case 'challenge':
      case 'pair_pending':
        break;
      case 'hello_error':
        this.lastError = f.message;
        this.setState('error', f.message);
        break;
      case 'ping':
        this.send({ type: 'pong', t: f.t });
        break;
      case 'rpc':
        this.onRpc(f.method, f.params).then(
          (result) => this.send({ type: 'rpc_result', id: f.id, result }),
          (e) => this.send({ type: 'rpc_result', id: f.id, error: e instanceof Error ? e.message : String(e) }),
        );
        break;
      case 'response': {
        const p = this.pending.get(f.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(f.requestId);
          if (f.ok) p.resolve(f.data);
          else p.reject(new Error(f.error ?? 'Request failed'));
        }
        break;
      }
      case 'state':
        this.lastState = f;
        break;
    }
    this.onFrame(f);
  }
}
