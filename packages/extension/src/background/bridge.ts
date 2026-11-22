/**
 * WebSocket connection to the agent server: pairing (hello + token), reconnect with backoff,
 * heartbeat, RPC dispatch, and request/response for side-panel actions.
 */
import { PROTOCOL_VERSION, newId, type ClientFrame, type ServerFrame } from '@ba/shared';

export type ConnState = 'unconfigured' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface BridgeConfig {
  serverUrl: string;
  token: string;
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

  constructor(
    private onRpc: RpcHandler,
    private onFrame: (f: ServerFrame) => void,
    private onConnChange: () => void,
  ) {}

  async loadConfig(): Promise<BridgeConfig> {
    const st = (await chrome.storage.local.get(['serverUrl', 'token', 'clientId'])) as { serverUrl?: string; token?: string; clientId?: string };
    let clientId = st.clientId;
    if (!clientId) {
      clientId = newId('c');
      await chrome.storage.local.set({ clientId });
    }
    this.clientId = clientId;
    const config: BridgeConfig = { serverUrl: st.serverUrl || DEFAULT_SERVER_URL, token: st.token || '' };
    this.config = config;
    return config;
  }

  getConfig(): BridgeConfig | null {
    return this.config;
  }

  async setConfig(c: Partial<BridgeConfig>): Promise<void> {
    const cur = this.config ?? (await this.loadConfig());
    this.config = { serverUrl: (c.serverUrl ?? cur.serverUrl).trim() || DEFAULT_SERVER_URL, token: (c.token ?? cur.token).trim() };
    await chrome.storage.local.set({ serverUrl: this.config.serverUrl, token: this.config.token });
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
    const cfg = this.config ?? (await this.loadConfig());
    if (!cfg.token) {
      this.setState('unconfigured', 'Paste the pairing token from the agent server into Settings.');
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
    ws.onopen = () => {
      const hello: ClientFrame = {
        type: 'hello',
        token: cfg.token,
        clientId: this.clientId,
        protocol: PROTOCOL_VERSION,
        extensionVersion: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
      };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      let f: ServerFrame;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(f);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Disconnected from the agent server.'));
      }
      this.pending.clear();
      if (ev.code === 4003) {
        this.setState('error', 'The server rejected the pairing token.');
        return;
      }
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

  private handle(f: ServerFrame): void {
    switch (f.type) {
      case 'hello_ok':
        this.hello = f;
        this.backoff = 1000;
        this.setState('connected');
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
